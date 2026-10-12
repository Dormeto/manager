# Operations (vision docs/specs/2026-10-05-onboarding-design.md, R4b): the workflow that installs, upgrades and removes
# routers by API calls and onboards and offboards workloads through them. The API creates an operation and starts an
# execution; the state machine calls the operations Lambda (`next`) until the operation is done.

locals {
  # The router bundle the manager installs, of the release's router version.
  router_bundle = {
    "router.zip"     = local.artifact.router
    "blueprint.json" = local.artifact.blueprint
  }
}

resource "aws_s3_bucket" "artifacts" {
  bucket = "${local.name}-artifacts-${local.account_id}"
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_object" "router_bundle" {
  for_each = local.router_bundle
  bucket   = aws_s3_bucket.artifacts.id
  key      = "router/${local.router_version}/${each.key}"
  source   = each.value
  etag     = filemd5(each.value)

  depends_on = [terraform_data.artifacts]
}

resource "aws_iam_role" "operations" {
  name               = "${local.name}-operations"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "operations" {
  statement {
    sid       = "OperationItems"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:BatchWriteItem"]
    resources = [aws_dynamodb_table.manager.arn, "${aws_dynamodb_table.manager.arn}/index/*"]
  }
  statement {
    sid       = "RouterBundle"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/router/*"]
  }
  statement {
    sid       = "AssumeCommandRoles"
    actions   = ["sts:AssumeRole"]
    resources = ["arn:aws:iam::*:role/${var.command_role_name}"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceOrgID"
      values   = [var.organization_id]
    }
  }
  statement {
    # The connections of a discovery run: their executions (packaging design §5).
    sid       = "StartOperations"
    actions   = ["states:StartExecution"]
    resources = ["arn:aws:states:${local.region}:${local.account_id}:stateMachine:${local.name}-operations"]
  }
  statement {
    # The access check function runs as this role too.
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.operations.arn}:*", "${aws_cloudwatch_log_group.access_check.arn}:*"]
  }
}

resource "aws_iam_role_policy" "operations" {
  name   = "operations"
  role   = aws_iam_role.operations.id
  policy = data.aws_iam_policy_document.operations.json
}

resource "aws_cloudwatch_log_group" "operations" {
  name              = "/aws/lambda/${local.name}-operations"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "operations" {
  function_name    = "${local.name}-operations"
  role             = aws_iam_role.operations.arn
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = local.artifact.operations
  source_code_hash = filebase64sha256(local.artifact.operations)
  # One step per invocation: the longest are the onboarder's preview and onboard (300 s at most, it lists every Auto
  # Scaling group and ECS service of the region), plus a margin.
  timeout     = 360
  memory_size = 512

  environment {
    variables = {
      ENV                = var.env
      TABLE              = aws_dynamodb_table.manager.name
      ROUTERS            = local.routers
      ARTIFACTS_BUCKET   = aws_s3_bucket.artifacts.id
      ROUTER_VERSION     = local.router_version
      COMMAND_ROLE       = var.command_role_name
      MANAGER_PRINCIPALS = jsonencode([aws_iam_role.api.arn])
      # The connections a discovery run decides start their executions here (by name: the state machine invokes this).
      OPERATIONS_STATE_MACHINE = "arn:aws:states:${local.region}:${local.account_id}:stateMachine:${local.name}-operations"
      # Installed routers send their state there (scale design §3).
      MANAGER_BUS = aws_cloudwatch_event_bus.manager.arn
      # The manager's IP lists (R6b): installed routers read its catalog and the bucket's objects.
      ROUTER_IP_LISTS_CATALOG = "s3://${aws_s3_bucket.lists.id}/catalog.json"
      ROUTER_IP_LISTS_BUCKET  = aws_s3_bucket.lists.id
    }
  }

  depends_on = [aws_cloudwatch_log_group.operations, aws_iam_role_policy.operations, terraform_data.artifacts]
}

# The access check (packaging design §3): assumes an account's command role and answers whether it could, nothing else.
# It runs as the operations role, the one the command role trusts; discovery may invoke it, never the operations
# function (whose steps act under the command role).
resource "aws_cloudwatch_log_group" "access_check" {
  name              = "/aws/lambda/${local.name}-access-check"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "access_check" {
  function_name    = "${local.name}-access-check"
  role             = aws_iam_role.operations.arn
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]
  handler          = "check.handler"
  filename         = local.artifact.access_check
  source_code_hash = filebase64sha256(local.artifact.access_check)
  # Two STS attempts of 10 s at most.
  timeout     = 30
  memory_size = 256

  environment {
    variables = {
      ENV          = var.env
      COMMAND_ROLE = var.command_role_name
    }
  }

  depends_on = [aws_cloudwatch_log_group.access_check, aws_iam_role_policy.operations, terraform_data.artifacts]
}

data "aws_iam_policy_document" "states_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "workflow" {
  name               = "${local.name}-workflow"
  assume_role_policy = data.aws_iam_policy_document.states_assume.json
}

resource "aws_iam_role_policy" "workflow" {
  name = "workflow"
  role = aws_iam_role.workflow.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "lambda:InvokeFunction", Resource = [aws_lambda_function.operations.arn, "${aws_lambda_function.operations.arn}:*"] }]
  })
}

resource "aws_sfn_state_machine" "operations" {
  name     = "${local.name}-operations"
  role_arn = aws_iam_role.workflow.arn
  type     = "STANDARD"
  definition = jsonencode({
    Comment = "Dormeto operation: the next step until done, waiting as each step asks"
    StartAt = "Next"
    # Slot waits end 24 hours after the operation started (engine.ts SLOT_WAIT_MAX); the steps after them fit in the hour left.
    TimeoutSeconds = 25 * 3600
    States = {
      Next = {
        Type           = "Task"
        Resource       = "arn:aws:states:::lambda:invoke"
        Parameters     = { FunctionName = aws_lambda_function.operations.arn, Payload = { task = "next", "operationId.$" = "$.operationId" } }
        ResultSelector = { "Payload.$" = "$.Payload" }
        ResultPath     = "$.result"
        Retry = [{
          ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException", "Lambda.TooManyRequestsException", "Lambda.Unknown", "States.Timeout"]
          IntervalSeconds = 2, MaxAttempts = 6, BackoffRate = 2, JitterStrategy = "FULL"
        }]
        Catch = [{ ErrorEquals = ["States.ALL"], ResultPath = "$.error", Next = "Release" }]
        Next  = "Decide"
      }
      Decide = {
        Type = "Choice"
        Choices = [
          { And = [{ Variable = "$.result.Payload.done", BooleanEquals = true }, { Variable = "$.result.Payload.status", StringEquals = "failed" }], Next = "Failed" },
          { Variable = "$.result.Payload.done", BooleanEquals = true, Next = "Succeeded" },
        ]
        Default = "Wait"
      }
      Wait = { Type = "Wait", SecondsPath = "$.result.Payload.waitSeconds", Next = "Next" }
      Release = {
        Type       = "Task"
        Resource   = "arn:aws:states:::lambda:invoke"
        Parameters = { FunctionName = aws_lambda_function.operations.arn, Payload = { task = "fail", "operationId.$" = "$.operationId", "error.$" = "$.error" } }
        Retry      = [{ ErrorEquals = ["States.ALL"], IntervalSeconds = 5, MaxAttempts = 5, BackoffRate = 2 }]
        Next       = "Failed"
      }
      Succeeded = { Type = "Succeed" }
      Failed    = { Type = "Fail", Error = "OperationFailed", Cause = "See the operation record in the manager." }
    }
  })
}
