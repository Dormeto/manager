# Organization discovery (vision docs/specs/2026-10-04-org-discovery-design.md): the discovery Lambda reads the
# organization through its delegation policy and assumes the read-only DmtDiscoveryRole in each account of the perimeter.

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
    sid       = "DiscoveryItems"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:BatchWriteItem"]
    resources = [aws_dynamodb_table.manager.arn]
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

data "archive_file" "discovery" {
  type        = "zip"
  source_file = "${path.module}/../../../packages/discovery/dist/index.mjs"
  output_path = "${path.module}/.build/${local.name}-discovery.zip"
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
  filename         = data.archive_file.discovery.output_path
  source_code_hash = data.archive_file.discovery.output_base64sha256
  timeout          = 900
  memory_size      = 512
  # One run at a time (the run lock covers the rest).
  reserved_concurrent_executions = 1

  environment {
    variables = {
      TABLE     = aws_dynamodb_table.manager.name
      ENV       = var.env
      ROLE_NAME = var.discovery_role_name
    }
  }

  depends_on = [aws_cloudwatch_log_group.discovery, aws_iam_role_policy.discovery]
}

# Hourly tick: the Lambda runs discovery when the refresh period of the configuration has elapsed.
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
      values   = [var.account_id]
    }
    # EventBridge Scheduler presents its schedule group as the source, not the schedule (router lesson, 2026-10-04).
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = ["arn:aws:scheduler:${var.region}:${var.account_id}:schedule-group/default"]
    }
  }
}

resource "aws_iam_role" "discovery_scheduler" {
  name               = "${local.name}-discovery-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "discovery_scheduler" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.discovery.arn]
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
    arn      = aws_lambda_function.discovery.arn
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
