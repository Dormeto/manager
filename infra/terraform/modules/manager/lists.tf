# IP lists distributed by the manager (vision docs/specs/2026-10-08-reliability-security-design.md, R6b): the catalog
# (ip_lists) in a bucket the organization's routers read; the list function, from the router bundle, downloads each list
# once for every router, checks it and publishes it with its manifest, hourly.
locals {
  lists_bucket = "${local.name}-ip-lists-${local.account_id}"
  # Lists of the catalog given as s3:// URIs: the list function reads their objects.
  catalog_s3_objects = [for l in var.ip_lists : "arn:aws:s3:::${trimprefix(l.url, "s3://")}" if startswith(l.url, "s3://")]
}

resource "aws_s3_bucket" "lists" {
  bucket = local.lists_bucket
  # The lists are downloaded again by the list function: nothing to keep at uninstall.
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "lists" {
  bucket                  = aws_s3_bucket.lists.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "lists" {
  bucket = aws_s3_bucket.lists.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "lists" {
  bucket = aws_s3_bucket.lists.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Each version's data is its own object under data/: written again by the list function before 30 days (its current
# version), the older ones expire.
resource "aws_s3_bucket_lifecycle_configuration" "lists" {
  bucket = aws_s3_bucket.lists.id
  rule {
    id     = "expire-list-data"
    status = "Enabled"
    filter {
      prefix = "data/"
    }
    expiration {
      days = 30
    }
  }
}

# The routers of the organization read the catalog, the manifests and the data (their roles grant s3:GetObject on the
# bucket's objects); the manager's account too.
data "aws_iam_policy_document" "lists" {
  statement {
    sid       = "OrganizationRouters"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.lists.arn}/*"]
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
    # Within the organization, or within the manager's own account when there is none (account deployment).
    condition {
      test     = "StringEquals"
      variable = var.organization_id == null ? "aws:PrincipalAccount" : "aws:PrincipalOrgID"
      values   = [var.organization_id == null ? local.account_id : var.organization_id]
    }
  }
  statement {
    sid       = "TlsOnly"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.lists.arn, "${aws_s3_bucket.lists.arn}/*"]
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "lists" {
  bucket     = aws_s3_bucket.lists.id
  policy     = data.aws_iam_policy_document.lists.json
  depends_on = [aws_s3_bucket_public_access_block.lists]
}

# The catalog: what the list function downloads, what the routers use (R13 edits it from the dashboard).
resource "aws_s3_object" "catalog" {
  bucket       = aws_s3_bucket.lists.id
  key          = "catalog.json"
  content_type = "application/json"
  content      = jsonencode({ lists = [for l in var.ip_lists : { name = l.name, url = l.url, action = l.action, refreshHours = l.refresh_hours }] })
}

resource "aws_iam_role" "ip_lists" {
  name               = "${local.name}-ip-lists"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "ip_lists" {
  statement {
    sid       = "Lists"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.lists.arn}/*"]
  }
  statement {
    # Without it, a missing object answers AccessDenied, not NoSuchKey (status.json before the first run).
    sid       = "ListsListing"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.lists.arn]
  }
  dynamic "statement" {
    for_each = length(local.catalog_s3_objects) > 0 ? [1] : []
    content {
      sid       = "CatalogObjects"
      actions   = ["s3:GetObject"]
      resources = local.catalog_s3_objects
    }
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.ip_lists.arn}:*"]
  }
}

resource "aws_iam_role_policy" "ip_lists" {
  name   = "ip-lists"
  role   = aws_iam_role.ip_lists.id
  policy = data.aws_iam_policy_document.ip_lists.json
}

resource "aws_cloudwatch_log_group" "ip_lists" {
  name              = "/aws/lambda/${local.name}-ip-lists"
  retention_in_days = var.log_retention_days
}

# The router bundle's list function: the packed format has one owner, the router.
resource "aws_lambda_function" "ip_lists" {
  function_name    = "${local.name}-ip-lists"
  role             = aws_iam_role.ip_lists.arn
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]
  handler          = "lists.handler"
  filename         = local.artifact.router
  source_code_hash = filebase64sha256(local.artifact.router)
  # Each download is cut at 20 s and 20 MB; parsing and packing 200,000 entries takes about a second.
  timeout     = 300
  memory_size = 512
  # One run at a time: status.json has a single writer.
  reserved_concurrent_executions = 1

  environment {
    variables = {
      DMT_LISTS_BUCKET = aws_s3_bucket.lists.id
    }
  }

  depends_on = [aws_cloudwatch_log_group.ip_lists, aws_iam_role_policy.ip_lists, terraform_data.artifacts]
}

resource "aws_sqs_queue" "ip_lists_failures" {
  name                      = "${local.name}-ip-lists-failures"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_iam_role" "ip_lists_scheduler" {
  name               = "${local.name}-ip-lists-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "ip_lists_scheduler" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.ip_lists.arn]
  }
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.ip_lists_failures.arn]
  }
}

resource "aws_iam_role_policy" "ip_lists_scheduler" {
  name   = "scheduler"
  role   = aws_iam_role.ip_lists_scheduler.id
  policy = data.aws_iam_policy_document.ip_lists_scheduler.json
}

# Hourly: each list is downloaded at its refresh period (a failed one again after an hour).
resource "aws_scheduler_schedule" "ip_lists" {
  name                = "${local.name}-ip-lists"
  schedule_expression = "rate(1 hour)"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.ip_lists.arn
    role_arn = aws_iam_role.ip_lists_scheduler.arn
    input    = jsonencode({ source = "schedule" })

    retry_policy {
      maximum_retry_attempts = 2
    }
    dead_letter_config {
      arn = aws_sqs_queue.ip_lists_failures.arn
    }
  }
}

output "ip_lists_catalog" {
  description = "The catalog of the manager's IP lists, for a router written in Terraform (its ip_lists_catalog); installed routers get it on their own."
  value       = "s3://${aws_s3_bucket.lists.id}/catalog.json"
}
