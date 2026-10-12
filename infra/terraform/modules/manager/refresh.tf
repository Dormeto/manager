# Event-driven discovery refresh (vision docs/specs/2026-10-06-packaging-design.md, section 5): the forwarders the manager
# installs in connected accounts send their load balancer changes to the manager's bus; this rule queues them, and the
# discovery Lambda rescans the account-regions they name, in batches of up to 5 minutes.

resource "aws_cloudwatch_event_rule" "refresh" {
  name           = "${local.name}-refresh"
  description    = "Dormeto: load balancer changes forwarded by the connected accounts, to discovery"
  event_bus_name = aws_cloudwatch_event_bus.manager.name
  event_pattern  = jsonencode({ source = ["aws.elasticloadbalancing"], "detail-type" = ["AWS API Call via CloudTrail"] })
}

resource "aws_sqs_queue" "refresh_failed" {
  name                      = "${local.name}-refresh-failed"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "refresh" {
  name = "${local.name}-refresh"
  # Above the discovery Lambda's timeout (900 s) and the batching window (300 s): a batch being rescanned is never
  # delivered twice; an event given back (another refresh, out of time) comes back after it.
  visibility_timeout_seconds = 1800
  message_retention_seconds  = 86400
  sqs_managed_sse_enabled    = true
  redrive_policy             = jsonencode({ deadLetterTargetArn = aws_sqs_queue.refresh_failed.arn, maxReceiveCount = 5 })
}

data "aws_iam_policy_document" "refresh_queue" {
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.refresh.arn]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.refresh.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "refresh" {
  queue_url = aws_sqs_queue.refresh.id
  policy    = data.aws_iam_policy_document.refresh_queue.json
}

resource "aws_cloudwatch_event_target" "refresh" {
  rule           = aws_cloudwatch_event_rule.refresh.name
  event_bus_name = aws_cloudwatch_event_bus.manager.name
  arn            = aws_sqs_queue.refresh.arn
}

# One rescan per account-region and batch: 300 events of one account-region rescan it once.
resource "aws_lambda_event_source_mapping" "refresh" {
  event_source_arn                   = aws_sqs_queue.refresh.arn
  function_name                      = aws_lambda_function.discovery.arn
  batch_size                         = 10000
  maximum_batching_window_in_seconds = 300
  # The events a batch could not handle (another refresh runs, out of time) go back to the queue, the others are deleted.
  function_response_types = ["ReportBatchItemFailures"]
  scaling_config {
    maximum_concurrency = 2
  }
}
