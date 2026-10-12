# Organization discovery (vision docs/specs/2026-10-04-org-discovery-design.md): the discovery Lambda reads the
# organization through its delegation policy and assumes the read-only DmtDiscoveryRole in each account of the perimeter.

# The organization roles of the manager's own account (packaging design §3): the access module, as in any other account
# (the published module, or its procedure): DmtDiscoveryRole, DmtCommandRole and DmtRouterBoundary. They are the
# account's, trusted by every environment that shares them (R5a review I2): a second environment in the account sets
# create_organization_roles = false and is listed in the first one's organization_role_envs.
module "organization_roles" {
  source              = "../access"
  count               = var.create_organization_roles ? 1 : 0
  manager_account_id  = local.account_id
  envs                = local.organization_role_envs
  organization_id     = var.organization_id
  discovery_role_name = var.discovery_role_name
  command_role_name   = var.command_role_name
  # Checked with the other artifacts (a missing one fails the plan with its path).
  boundary_policy = try(file(local.artifact.boundary), "{}")
}

resource "aws_iam_role" "discovery" {
  name               = "${local.name}-discovery"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "discovery" {
  statement {
    sid       = "ReadOrganization"
    actions   = ["organizations:Describe*", "organizations:List*"]
    resources = ["*"]
  }
  statement {
    sid       = "AssumeDiscoveryRoles"
    actions   = ["sts:AssumeRole"]
    resources = ["arn:aws:iam::*:role/${var.discovery_role_name}"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceOrgID"
      values   = [var.organization_id]
    }
  }
  statement {
    # The command role trusts the operations role only: the access check function (that role, nothing but an assume)
    # checks it for discovery (packaging design §3). Never the operations function, whose steps act under the role.
    sid       = "CheckCommandRoles"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.access_check.arn]
  }
  statement {
    # Event-driven refresh: the forwarded load balancer changes (refresh.tf).
    sid       = "RefreshQueue"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
    resources = [aws_sqs_queue.refresh.arn]
  }
  statement {
    sid       = "DiscoveryItems"
    actions   = ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:BatchWriteItem"]
    resources = [aws_dynamodb_table.manager.arn, "${aws_dynamodb_table.manager.arn}/index/*"]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.discovery.arn}:*"]
  }
}

resource "aws_iam_role_policy" "discovery" {
  name   = "discovery"
  role   = aws_iam_role.discovery.id
  policy = data.aws_iam_policy_document.discovery.json
}

resource "aws_cloudwatch_log_group" "discovery" {
  name              = "/aws/lambda/${local.name}-discovery"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "discovery" {
  function_name    = "${local.name}-discovery"
  role             = aws_iam_role.discovery.arn
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = local.artifact.discovery
  source_code_hash = filebase64sha256(local.artifact.discovery)
  timeout          = 900
  memory_size      = 512
  # 20 account steps at once (the state machine's Map), plus a plan or a finalize; one run at a time (its lock).
  reserved_concurrent_executions = 25

  environment {
    variables = {
      TABLE     = aws_dynamodb_table.manager.name
      ENV       = var.env
      ROLE_NAME = var.discovery_role_name
      # The access check function checks the command role of each account.
      ACCESS_CHECK_FUNCTION = aws_lambda_function.access_check.function_name
      # Dev only: a synthetic organization added to the real one (acceptance at scale, scale design §7).
      SYNTHETIC_ACCOUNTS = tostring(var.discovery_synthetic_accounts)
    }
  }

  depends_on = [aws_cloudwatch_log_group.discovery, aws_iam_role_policy.discovery, terraform_data.artifacts]
}

# A run (scale design §5): plan, the accounts 20 at a time in a Distributed Map (each child its own execution), finalize.
# An account step that fails or times out is recorded by finalize as unfinished; the others go on.
locals {
  discovery_state_machine = "${local.name}-discovery"
  discovery_retry = [{
    ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException", "Lambda.TooManyRequestsException"]
    IntervalSeconds = 2
    MaxAttempts     = 4
    BackoffRate     = 2
  }]
}

resource "aws_iam_role" "discovery_run" {
  name = "${local.name}-discovery-run"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "states.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = local.account_id } }
    }]
  })
}

data "aws_iam_policy_document" "discovery_run" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.discovery.arn, "${aws_lambda_function.discovery.arn}:*"]
  }
  # The connections a run decides (packaging design §5): the operations task connections, with the run's lists only. The
  # discovery Lambda itself may not invoke the operations function (its role: discovery.tf).
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.operations.arn, "${aws_lambda_function.operations.arn}:*"]
  }
  # The Distributed Map runs each account as a child execution of this state machine.
  statement {
    actions   = ["states:StartExecution"]
    resources = ["arn:aws:states:${local.region}:${local.account_id}:stateMachine:${local.discovery_state_machine}"]
  }
  statement {
    actions   = ["states:DescribeExecution", "states:StopExecution"]
    resources = ["arn:aws:states:${local.region}:${local.account_id}:execution:${local.discovery_state_machine}/*"]
  }
}

resource "aws_iam_role_policy" "discovery_run" {
  name   = "run"
  role   = aws_iam_role.discovery_run.id
  policy = data.aws_iam_policy_document.discovery_run.json
}

resource "aws_sfn_state_machine" "discovery" {
  name     = local.discovery_state_machine
  role_arn = aws_iam_role.discovery_run.arn
  definition = jsonencode({
    Comment        = "Dormeto discovery run: plan, one step per account, finalize"
    StartAt        = "Plan"
    TimeoutSeconds = 10800
    States = {
      Plan = {
        Type       = "Task"
        Resource   = "arn:aws:states:::lambda:invoke"
        Parameters = { FunctionName = aws_lambda_function.discovery.arn, Payload = { step = "plan", "input.$" = "$" } }
        OutputPath = "$.Payload"
        Retry      = local.discovery_retry
        Next       = "Planned"
      }
      Planned = {
        Type    = "Choice"
        Choices = [{ Variable = "$.status", StringEquals = "planned", Next = "Accounts" }]
        Default = "Done"
      }
      Accounts = {
        Type                       = "Map"
        ItemsPath                  = "$.accounts"
        ItemSelector               = { step = "account", "account.$" = "$$.Map.Item.Value", "runId.$" = "$.runId" }
        MaxConcurrency             = 20
        ToleratedFailurePercentage = 100
        ItemProcessor = {
          ProcessorConfig = { Mode = "DISTRIBUTED", ExecutionType = "STANDARD" }
          StartAt         = "Account"
          States = {
            Account = {
              Type           = "Task"
              Resource       = "arn:aws:states:::lambda:invoke"
              Parameters     = { FunctionName = aws_lambda_function.discovery.arn, "Payload.$" = "$" }
              ResultSelector = { "ok.$" = "$.Payload.ok" }
              Retry          = local.discovery_retry
              # A step that times out or crashes ends small: finalize records the account as unfinished, and the Map's
              # output stays far below the state size limit whatever the number of failures.
              Catch = [{ ErrorEquals = ["States.ALL"], Next = "AccountFailed" }]
              End   = true
            }
            AccountFailed = { Type = "Pass", Result = { ok = false }, End = true }
          }
        }
        ResultPath = null
        Catch      = [{ ErrorEquals = ["States.ALL"], ResultPath = null, Next = "Finalize" }]
        Next       = "Finalize"
      }
      Finalize = {
        Type       = "Task"
        Resource   = "arn:aws:states:::lambda:invoke"
        Parameters = { FunctionName = aws_lambda_function.discovery.arn, Payload = { step = "finalize", "plan.$" = "$" } }
        OutputPath = "$.Payload"
        Retry      = local.discovery_retry
        # A finalize that times out or crashes: the run is recorded as failed and its lock released.
        Catch = [{ ErrorEquals = ["States.ALL"], ResultPath = "$.failure", Next = "Abandon" }]
        Next  = "Connect?"
      }
      # Event-driven refresh: accounts to connect or disconnect go to the operations (one operation per account).
      "Connect?" = {
        Type    = "Choice"
        Choices = [{ Or = [{ Variable = "$.connections.connect", NumericGreaterThan = 0 }, { Variable = "$.connections.disconnect", NumericGreaterThan = 0 }], Next = "Connections" }]
        Default = "Done"
      }
      Connections = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        # The run's id only: the operations read its lists from the run record (Step Functions' payloads: 256 KB at most).
        Parameters = { FunctionName = aws_lambda_function.operations.arn, Payload = { task = "connections", "runId.$" = "$.startedAt" } }
        ResultPath = "$.connected"
        Retry      = local.discovery_retry
        # The run is recorded: a failure here waits for the next run.
        Catch = [{ ErrorEquals = ["States.ALL"], ResultPath = "$.connectionsFailure", Next = "Done" }]
        End   = true
      }
      Abandon = {
        Type       = "Task"
        Resource   = "arn:aws:states:::lambda:invoke"
        Parameters = { FunctionName = aws_lambda_function.discovery.arn, Payload = { step = "abandon", "plan.$" = "$", "error.$" = "$.failure.Error" } }
        OutputPath = "$.Payload"
        Retry      = local.discovery_retry
        End        = true
      }
      Done = { Type = "Succeed" }
    }
  })

  depends_on = [aws_iam_role_policy.discovery_run]
}

output "discovery_state_machine_arn" {
  value = aws_sfn_state_machine.discovery.arn
}

# Hourly tick: the state machine plans a run when the refresh period of the configuration has elapsed.
resource "aws_sqs_queue" "discovery_failures" {
  name                      = "${local.name}-discovery-failures"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
    # EventBridge Scheduler presents its schedule group as the source, not the schedule (router lesson, 2026-10-04).
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = ["arn:aws:scheduler:${local.region}:${local.account_id}:schedule-group/default"]
    }
  }
}

resource "aws_iam_role" "discovery_scheduler" {
  name               = "${local.name}-discovery-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "discovery_scheduler" {
  statement {
    actions   = ["states:StartExecution"]
    resources = [aws_sfn_state_machine.discovery.arn]
  }
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.discovery_failures.arn]
  }
}

resource "aws_iam_role_policy" "discovery_scheduler" {
  name   = "scheduler"
  role   = aws_iam_role.discovery_scheduler.id
  policy = data.aws_iam_policy_document.discovery_scheduler.json
}

resource "aws_scheduler_schedule" "discovery" {
  name                = "${local.name}-discovery"
  schedule_expression = "rate(1 hour)"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_sfn_state_machine.discovery.arn
    role_arn = aws_iam_role.discovery_scheduler.arn
    input    = jsonencode({ source = "schedule" })

    retry_policy {
      maximum_retry_attempts = 2
    }
    dead_letter_config {
      arn = aws_sqs_queue.discovery_failures.arn
    }
  }
}
