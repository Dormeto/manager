# Router events (vision docs/specs/2026-10-05-scale-design.md §3 and §4): routers of the organization send their state
# after each idle check and each workload state change to this bus; a queue buffers them for the fleet Lambda, which
# writes the router and workload summaries the API reads.

resource "aws_cloudwatch_event_bus" "manager" {
  name = local.name
}

# Any principal of the organization may publish (routers run in its accounts); the envelope's account and region identify
# each router, never the payload.
data "aws_iam_policy_document" "manager_bus" {
  statement {
    sid       = "OrganizationRouters"
    actions   = ["events:PutEvents"]
    resources = [aws_cloudwatch_event_bus.manager.arn]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:PrincipalOrgID"
      values   = [var.organization_id]
    }
  }
}

resource "aws_cloudwatch_event_bus_policy" "manager" {
  event_bus_name = aws_cloudwatch_event_bus.manager.name
  policy         = data.aws_iam_policy_document.manager_bus.json
}

resource "aws_cloudwatch_event_rule" "router_events" {
  name           = "${local.name}-router-events"
  description    = "Dormeto: router state and workload state changes, to the fleet Lambda"
  event_bus_name = aws_cloudwatch_event_bus.manager.name
  event_pattern  = jsonencode({ source = ["dormeto.router"] })
}

resource "aws_sqs_queue" "router_events_failed" {
  name                      = "${local.name}-router-events-failed"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "router_events" {
  name                       = "${local.name}-router-events"
  visibility_timeout_seconds = 720 # six times the fleet Lambda's timeout
  message_retention_seconds  = 86400
  redrive_policy             = jsonencode({ deadLetterTargetArn = aws_sqs_queue.router_events_failed.arn, maxReceiveCount = 5 })
}

data "aws_iam_policy_document" "router_events_queue" {
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.router_events.arn]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.router_events.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "router_events" {
  queue_url = aws_sqs_queue.router_events.id
  policy    = data.aws_iam_policy_document.router_events_queue.json
}

resource "aws_cloudwatch_event_target" "router_events" {
  rule           = aws_cloudwatch_event_rule.router_events.name
  event_bus_name = aws_cloudwatch_event_bus.manager.name
  arn            = aws_sqs_queue.router_events.arn
}

resource "aws_iam_role" "fleet" {
  name               = "${local.name}-fleet"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "fleet" {
  statement {
    sid       = "Summaries"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query"]
    resources = [aws_dynamodb_table.manager.arn]
  }
  statement {
    sid       = "RouterEvents"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
    resources = [aws_sqs_queue.router_events.arn]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.fleet.arn}:*"]
  }
}

resource "aws_iam_role_policy" "fleet" {
  name   = "fleet"
  role   = aws_iam_role.fleet.id
  policy = data.aws_iam_policy_document.fleet.json
}

resource "aws_cloudwatch_log_group" "fleet" {
  name              = "/aws/lambda/${local.name}-fleet"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "fleet" {
  function_name    = "${local.name}-fleet"
  role             = aws_iam_role.fleet.arn
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = local.artifact.fleet
  source_code_hash = filebase64sha256(local.artifact.fleet)
  # A batch of 25 chunks of about 90 workloads, written 10 at a time, takes seconds; the margin is for a throttled table
  # draining a backlog.
  timeout     = 120
  memory_size = 256

  environment {
    variables = {
      TABLE        = aws_dynamodb_table.manager.name
      HISTORY_DAYS = tostring(var.history_days)
    }
  }

  depends_on = [aws_cloudwatch_log_group.fleet, aws_iam_role_policy.fleet, terraform_data.artifacts]
}

# Batches of up to 25 events within 1 s; a failed event comes back alone (partial batch response); at most 5 batches at
# once.
resource "aws_lambda_event_source_mapping" "router_events" {
  event_source_arn                   = aws_sqs_queue.router_events.arn
  function_name                      = aws_lambda_function.fleet.arn
  batch_size                         = 25
  maximum_batching_window_in_seconds = 1
  function_response_types            = ["ReportBatchItemFailures"]
  scaling_config {
    maximum_concurrency = 5
  }
}

output "event_bus_arn" {
  value = aws_cloudwatch_event_bus.manager.arn
}
