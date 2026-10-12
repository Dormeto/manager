# Savings (vision docs/specs/2026-10-08-savings-design.md, R9b): a daily job prices each workload's previous UTC day from
# its history and AWS's list prices (the Price List API, cached in the table), into day items and the summary the
# Overview reads.

resource "aws_iam_role" "savings" {
  name               = "${local.name}-savings"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "savings" {
  statement {
    # Workload summaries and their history, read; day items, the summary and the price cache, written.
    sid       = "Savings"
    actions   = ["dynamodb:Query", "dynamodb:GetItem", "dynamodb:PutItem"]
    resources = [aws_dynamodb_table.manager.arn]
  }
  statement {
    # The Price List API has no resource-level permission.
    sid       = "Prices"
    actions   = ["pricing:GetProducts"]
    resources = ["*"]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.savings.arn}:*"]
  }
}

resource "aws_iam_role_policy" "savings" {
  name   = "savings"
  role   = aws_iam_role.savings.id
  policy = data.aws_iam_policy_document.savings.json
}

resource "aws_cloudwatch_log_group" "savings" {
  name              = "/aws/lambda/${local.name}-savings"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "savings" {
  function_name    = "${local.name}-savings"
  role             = aws_iam_role.savings.arn
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]
  handler          = "savings.handler"
  filename         = local.artifact.savings
  source_code_hash = filebase64sha256(local.artifact.savings)
  # A history query per workload, ten at a time: minutes for thousands of workloads.
  timeout     = 900
  memory_size = 512
  # One run at a time: a day's cumulative total is added once.
  reserved_concurrent_executions = 1

  environment {
    variables = {
      TABLE            = aws_dynamodb_table.manager.name
      HISTORY_DAYS     = tostring(var.history_days)
      SAVINGS_BASELINE = var.savings_baseline
      SAVINGS_TIMEZONE = var.savings_timezone
    }
  }

  depends_on = [aws_cloudwatch_log_group.savings, aws_iam_role_policy.savings, terraform_data.artifacts]
}

resource "aws_sqs_queue" "savings_failures" {
  name                      = "${local.name}-savings-failures"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_iam_role" "savings_scheduler" {
  name               = "${local.name}-savings-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "savings_scheduler" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.savings.arn]
  }
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.savings_failures.arn]
  }
}

resource "aws_iam_role_policy" "savings_scheduler" {
  name   = "scheduler"
  role   = aws_iam_role.savings_scheduler.id
  policy = data.aws_iam_policy_document.savings_scheduler.json
}

resource "aws_scheduler_schedule" "savings" {
  name                = "${local.name}-savings"
  schedule_expression = "cron(30 0 * * ? *)"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.savings.arn
    role_arn = aws_iam_role.savings_scheduler.arn
    input    = jsonencode({ source = "schedule" })

    retry_policy {
      maximum_retry_attempts = 2
    }
    dead_letter_config {
      arn = aws_sqs_queue.savings_failures.arn
    }
  }
}
