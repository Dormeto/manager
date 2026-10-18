# Health alarms (vision docs/specs/2026-10-08-reliability-security-design.md, R6a): the watchdog compares, every 5
# minutes, the routers the manager knows with what they report, and publishes what changed to the alert topic;
# CloudWatch alarms watch the watchdog and the router events' dead-letter queue, to the same topic.

# Not encrypted: CloudWatch alarms cannot publish to a topic encrypted with the AWS managed key, and alerts hold no secret.
resource "aws_sns_topic" "alerts" {
  name = "${local.name}-alerts"
}

data "aws_iam_policy_document" "alerts" {
  statement {
    sid       = "AccountAlarms"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
  statement {
    # The account's own principals, as without a topic policy (the watchdog role, subscriptions managed in IAM).
    sid       = "Account"
    actions   = ["sns:Publish", "sns:Subscribe", "sns:GetTopicAttributes", "sns:ListSubscriptionsByTopic"]
    resources = [aws_sns_topic.alerts.arn]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${local.account_id}:root"]
    }
  }
}

resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.alerts.json
}

# Pending until each recipient confirms the email AWS sends.
resource "aws_sns_topic_subscription" "alert_email" {
  for_each  = toset(var.alert_emails)
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = each.value
}

resource "aws_iam_role" "watchdog" {
  name               = "${local.name}-watchdog"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "watchdog" {
  statement {
    # Router summaries and the installed routers' registry, read; alarm items, written.
    sid       = "Alarms"
    actions   = ["dynamodb:Query", "dynamodb:PutItem", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.manager.arn]
  }
  statement {
    sid       = "Alerts"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]
  }
  statement {
    sid       = "ListsStatus"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.lists.arn}/status.json"]
  }
  statement {
    sid       = "ListsListing"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.lists.arn]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.watchdog.arn}:*"]
  }
}

resource "aws_iam_role_policy" "watchdog" {
  name   = "watchdog"
  role   = aws_iam_role.watchdog.id
  policy = data.aws_iam_policy_document.watchdog.json
}

resource "aws_cloudwatch_log_group" "watchdog" {
  name              = "/aws/lambda/${local.name}-watchdog"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "watchdog" {
  function_name    = "${local.name}-watchdog"
  role             = aws_iam_role.watchdog.arn
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]
  handler          = "watchdog.handler"
  filename         = local.artifact.watchdog
  source_code_hash = filebase64sha256(local.artifact.watchdog)
  timeout          = 120
  memory_size      = 256
  # One run at a time: an alarm is never sent twice by overlapping runs.
  reserved_concurrent_executions = 1

  environment {
    variables = {
      TABLE           = aws_dynamodb_table.manager.name
      ROUTERS         = local.routers
      MANAGER_ACCOUNT = local.account_id
      ENV             = var.env
      ALERTS_TOPIC    = aws_sns_topic.alerts.arn
      DASHBOARD_URL   = "https://${local.dashboard_host}"
      # The manager's IP lists (R6b): their status, alarmed on.
      LISTS_BUCKET = aws_s3_bucket.lists.id
    }
  }

  depends_on = [aws_cloudwatch_log_group.watchdog, aws_iam_role_policy.watchdog, terraform_data.artifacts]
}

resource "aws_sqs_queue" "watchdog_failures" {
  name                      = "${local.name}-watchdog-failures"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_iam_role" "watchdog_scheduler" {
  name               = "${local.name}-watchdog-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "watchdog_scheduler" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.watchdog.arn]
  }
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.watchdog_failures.arn]
  }
}

resource "aws_iam_role_policy" "watchdog_scheduler" {
  name   = "scheduler"
  role   = aws_iam_role.watchdog_scheduler.id
  policy = data.aws_iam_policy_document.watchdog_scheduler.json
}

resource "aws_scheduler_schedule" "watchdog" {
  name                = "${local.name}-watchdog"
  schedule_expression = "rate(5 minutes)"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.watchdog.arn
    role_arn = aws_iam_role.watchdog_scheduler.arn
    input    = jsonencode({ source = "schedule" })

    retry_policy {
      maximum_retry_attempts = 2
    }
    dead_letter_config {
      arn = aws_sqs_queue.watchdog_failures.arn
    }
  }
}

locals {
  # The watchdog's own failures, and what it cannot see: each a CloudWatch alarm to the alert topic, in and out of ALARM.
  manager_alarms = {
    watchdog-errors = {
      description = "The watchdog failed: router alarms are not evaluated (see its logs)."
      namespace   = "AWS/Lambda", metric = "Errors", statistic = "Sum", dimensions = { FunctionName = aws_lambda_function.watchdog.function_name }
      # One failed run in 15 minutes (review I4: not three in a row).
      comparison = "GreaterThanThreshold", threshold = 0, periods = 3, datapoints = 1, missing = "notBreaching"
    }
    watchdog-silent = {
      description = "The watchdog did not run for 15 minutes: router alarms are not evaluated (its schedule, or the watchdog-failures queue)."
      namespace   = "AWS/Lambda", metric = "Invocations", statistic = "Sum", dimensions = { FunctionName = aws_lambda_function.watchdog.function_name }
      comparison  = "LessThanThreshold", threshold = 1, periods = 3, datapoints = 3, missing = "breaching"
    }
    ip-lists-errors = {
      description = "The IP list function failed: the routers keep the last versions published (see its logs; a list's own download errors are router alarms of the watchdog)."
      namespace   = "AWS/Lambda", metric = "Errors", statistic = "Sum", dimensions = { FunctionName = aws_lambda_function.ip_lists.function_name }
      # Hourly runs: the state holds between them (review I5: no OK every hour while it keeps failing).
      comparison = "GreaterThanThreshold", threshold = 0, periods = 1, datapoints = 1, missing = "ignore"
    }
    savings-errors = {
      description = "The daily savings job failed: the Overview's savings miss a day (see its logs; run it again with {\"day\": \"YYYY-MM-DD\"})."
      namespace   = "AWS/Lambda", metric = "Errors", statistic = "Sum", dimensions = { FunctionName = aws_lambda_function.savings.function_name }
      # A run a day: the state holds until the next one.
      comparison = "GreaterThanThreshold", threshold = 0, periods = 1, datapoints = 1, missing = "ignore"
    }
    update-check-errors = {
      description = "The daily update check failed: a new version may not be recorded or sent (see its logs; the next day tries again)."
      namespace   = "AWS/Lambda", metric = "Errors", statistic = "Sum", dimensions = { FunctionName = aws_lambda_function.update_check.function_name }
      # A run a day: the state holds until the next one.
      comparison = "GreaterThanThreshold", threshold = 0, periods = 1, datapoints = 1, missing = "ignore"
    }
    savings-failed = {
      description = "Runs of the savings job the scheduler could not deliver are in the savings-failures queue: run them again by hand."
      namespace   = "AWS/SQS", metric = "ApproximateNumberOfMessagesVisible", statistic = "Maximum", dimensions = { QueueName = aws_sqs_queue.savings_failures.name }
      comparison  = "GreaterThanThreshold", threshold = 0, periods = 1, datapoints = 1, missing = "notBreaching"
    }
    router-events-failed = {
      description = "Router events the manager could not store are in the router-events-failed queue: the dashboard and the alarms miss them."
      namespace   = "AWS/SQS", metric = "ApproximateNumberOfMessagesVisible", statistic = "Maximum", dimensions = { QueueName = aws_sqs_queue.router_events_failed.name }
      comparison  = "GreaterThanThreshold", threshold = 0, periods = 1, datapoints = 1, missing = "notBreaching"
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "manager" {
  for_each            = local.manager_alarms
  alarm_name          = "${local.name}-${each.key}"
  alarm_description   = each.value.description
  namespace           = each.value.namespace
  metric_name         = each.value.metric
  statistic           = each.value.statistic
  dimensions          = each.value.dimensions
  period              = 300
  evaluation_periods  = each.value.periods
  datapoints_to_alarm = each.value.datapoints
  comparison_operator = each.value.comparison
  threshold           = each.value.threshold
  treat_missing_data  = each.value.missing
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

output "alerts_topic_arn" {
  description = "The alert topic: subscribe anything beyond alert_emails to it (a chat channel, an HTTPS endpoint, a queue)."
  value       = aws_sns_topic.alerts.arn
}
