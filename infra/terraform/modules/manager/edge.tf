# Dashboard: SPA on a private S3 bucket and the API under /api/*, behind CloudFront on <dashboard_domain>.

resource "aws_s3_bucket" "dashboard" {
  bucket = "${local.name}-dashboard-${local.account_id}"
}

resource "aws_s3_bucket_public_access_block" "dashboard" {
  bucket                  = aws_s3_bucket.dashboard.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "dashboard" {
  bucket = aws_s3_bucket.dashboard.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

data "aws_iam_policy_document" "dashboard" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.dashboard.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.dashboard.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "dashboard" {
  bucket     = aws_s3_bucket.dashboard.id
  policy     = data.aws_iam_policy_document.dashboard.json
  depends_on = [aws_s3_bucket_public_access_block.dashboard]
}

locals {
  dist = "${local.artifacts_dir}/dashboard"
  content_types = {
    html  = "text/html; charset=utf-8"
    js    = "text/javascript; charset=utf-8"
    css   = "text/css; charset=utf-8"
    svg   = "image/svg+xml"
    json  = "application/json"
    png   = "image/png"
    woff2 = "font/woff2"
    txt   = "text/plain; charset=utf-8"
  }
}

# Hashed assets never change; index.html and config.json are revalidated on every load.
resource "aws_s3_object" "dashboard" {
  for_each      = fileset(local.dist, "**")
  bucket        = aws_s3_bucket.dashboard.id
  key           = each.value
  source        = "${local.dist}/${each.value}"
  source_hash   = filemd5("${local.dist}/${each.value}")
  content_type  = lookup(local.content_types, reverse(split(".", each.value))[0], "application/octet-stream")
  cache_control = startswith(each.value, "assets/") ? "public, max-age=31536000, immutable" : "no-cache"
}

resource "aws_s3_object" "config" {
  bucket        = aws_s3_bucket.dashboard.id
  key           = "config.json"
  content_type  = "application/json"
  cache_control = "no-cache"
  content = jsonencode({
    env        = var.env
    authority  = "https://${aws_cognito_user_pool.main.endpoint}"
    clientId   = aws_cognito_user_pool_client.dashboard.id
    authDomain = local.auth_host
  })

  lifecycle {
    precondition {
      condition     = length(local.missing_artifacts) == 0
      error_message = local.missing_message
    }
  }
}

resource "aws_cloudfront_origin_access_control" "dashboard" {
  name                              = local.name
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Application routes (no file extension) serve index.html; the API keeps its own errors.
resource "aws_cloudfront_function" "spa" {
  name    = "${local.name}-spa"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = <<-JS
    function handler(event) {
      var request = event.request;
      var last = request.uri.split('/').pop();
      if (last.indexOf('.') === -1) request.uri = '/index.html';
      return request;
    }
  JS
}

resource "aws_cloudfront_response_headers_policy" "dashboard" {
  name = local.name

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 63072000
      include_subdomains         = false
      override                   = true
    }
    # Vuetify injects its theme as a style element: inline styles only, never inline scripts.
    content_security_policy {
      content_security_policy = join("; ", [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self' https://cognito-idp.${local.region}.amazonaws.com https://${local.auth_host}",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
      ])
      override = true
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
  }

  remove_headers_config {
    items {
      header = "Server"
    }
    items {
      header = "x-amz-server-side-encryption"
    }
  }
}

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "api" {
  name = "Managed-AllViewerExceptHostHeader"
}

resource "aws_cloudfront_distribution" "dashboard" {
  enabled             = true
  comment             = "Dormeto manager ${var.env}"
  aliases             = local.custom_domain ? [var.domain.dashboard] : []
  default_root_object = "index.html"
  http_version        = "http2and3"
  is_ipv6_enabled     = true
  price_class         = "PriceClass_100"

  origin {
    origin_id                = "dashboard"
    domain_name              = aws_s3_bucket.dashboard.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.dashboard.id
  }

  origin {
    origin_id   = "api"
    domain_name = replace(aws_apigatewayv2_api.api.api_endpoint, "https://", "")
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id           = "dashboard"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.dashboard.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa.arn
    }
  }

  ordered_cache_behavior {
    path_pattern               = "/api/*"
    target_origin_id           = "api"
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.api.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.dashboard.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # Without a domain, CloudFront's own (*.cloudfront.net).
  viewer_certificate {
    acm_certificate_arn            = local.custom_domain ? var.domain.certificate_arn : null
    cloudfront_default_certificate = !local.custom_domain
    ssl_support_method             = local.custom_domain ? "sni-only" : null
    minimum_protocol_version       = local.custom_domain ? "TLSv1.2_2021" : "TLSv1"
  }
}

resource "aws_route53_record" "dashboard" {
  for_each = local.zone_id == null ? toset([]) : toset(["A", "AAAA"])
  zone_id  = local.zone_id
  name     = var.domain.dashboard
  type     = each.value

  alias {
    name                   = aws_cloudfront_distribution.dashboard.domain_name
    zone_id                = aws_cloudfront_distribution.dashboard.hosted_zone_id
    evaluate_target_health = false
  }
}
