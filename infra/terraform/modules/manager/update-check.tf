# The daily update check (vision docs/specs/2026-10-18-daily-update-check-design.md): a function run at 07:00 UTC reads the
# check's setting (administrators turn it on in the Update page; off, it reads that one item and stops), then the public
# release index, records the result and, when chosen, sends a newer version once to the alert topic.

resource "aws_iam_role" "update_check" {
  name               = "${local.name}-update-check"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "update_check" {
  statement {
    # The setting and the last result (UPDATE#CHECK, UPDATE#RESULT).
    sid       = "UpdateCheck"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem"]
    resources = [aws_dynamodb_table.manager.arn]
  }
  statement {
    sid       = "Alert"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.update_check.arn}:*"]
  }
}

resource "aws_iam_role_policy" "update_check" {
  name   = "update-check"
  role   = aws_iam_role.update_check.id
  policy = data.aws_iam_policy_document.update_check.json
}

resource "aws_cloudwatch_log_group" "update_check" {
  name              = "/aws/lambda/${local.name}-update-check"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "update_check" {
  function_name    = "${local.name}-update-check"
  role             = aws_iam_role.update_check.arn
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]
  handler          = "update-check.handler"
  filename         = local.artifact.update_check
  source_code_hash = filebase64sha256(local.artifact.update_check)
  # One fetch of the release index, 5 seconds at most, and a few table calls.
  timeout     = 30
  memory_size = 256
  # One run at a time: a version is sent once.
  reserved_concurrent_executions = 1

  environment {
    variables = {
      TABLE         = aws_dynamodb_table.manager.name
      ENV           = var.env
      VERSION       = local.version
      ALERTS_TOPIC  = aws_sns_topic.alerts.arn
      DASHBOARD_URL = "https://${local.dashboard_host}"
    }
  }

  depends_on = [aws_cloudwatch_log_group.update_check, aws_iam_role_policy.update_check, terraform_data.artifacts]
}

resource "aws_iam_role" "update_check_scheduler" {
  name               = "${local.name}-update-check-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "update_check_scheduler" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.update_check.arn]
  }
}

resource "aws_iam_role_policy" "update_check_scheduler" {
  name   = "scheduler"
  role   = aws_iam_role.update_check_scheduler.id
  policy = data.aws_iam_policy_document.update_check_scheduler.json
}

# Always scheduled: with the check off a run reads one table item and does nothing.
resource "aws_scheduler_schedule" "update_check" {
  name                = "${local.name}-update-check"
  schedule_expression = "cron(0 7 * * ? *)"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.update_check.arn
    role_arn = aws_iam_role.update_check_scheduler.arn
    input    = jsonencode({ source = "schedule" })

    # The next day tries again.
    retry_policy {
      maximum_retry_attempts = 0
    }
  }
}
