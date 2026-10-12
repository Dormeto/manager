# Manager API: one Lambda behind an HTTP API with a Cognito JWT authorizer, served under /api/* by CloudFront.

resource "aws_dynamodb_table" "manager" {
  name         = local.name
  billing_mode = "PAY_PER_REQUEST"
  # The registry of installed routers, operations and audit: protected with the users (deletion_protection).
  deletion_protection_enabled = var.deletion_protection
  hash_key                    = "pk"
  range_key                   = "sk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
  attribute {
    name = "gsi1pk"
    type = "S"
  }
  attribute {
    name = "gsi1sk"
    type = "S"
  }
  # Listings (scale design §4): candidates by status (CS#<status>), operations by time (OPS).
  global_secondary_index {
    name            = "gsi1"
    hash_key        = "gsi1pk"
    range_key       = "gsi1sk"
    projection_type = "ALL"
  }
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
  point_in_time_recovery {
    enabled = true
  }
  server_side_encryption {
    enabled = true
  }
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "api" {
  name               = "${local.name}-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${local.name}-api"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "api" {
  statement {
    # Routers written in Terraform, and the controllers of the routers the manager installs (their resource policy allows
    # this role in other accounts).
    sid       = "RouterControllers"
    actions   = ["lambda:InvokeFunction"]
    resources = concat([for r in var.routers : "arn:aws:lambda:${r.region}:${local.account_id}:function:${r.controller}"], ["arn:aws:lambda:*:*:function:dmtr-${var.env}-controller"])
  }
  statement {
    sid       = "Operations"
    actions   = ["states:StartExecution"]
    resources = [aws_sfn_state_machine.operations.arn]
  }
  statement {
    # Audit, preferences and discovery items (configuration, dismissals, manual exclusions: DeleteItem lifts one).
    sid       = "ManagerItems"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:BatchWriteItem", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.manager.arn, "${aws_dynamodb_table.manager.arn}/index/*"]
  }
  statement {
    sid = "Users"
    actions = [
      "cognito-idp:ListUsers", "cognito-idp:ListUsersInGroup", "cognito-idp:AdminCreateUser",
      "cognito-idp:AdminAddUserToGroup", "cognito-idp:AdminRemoveUserFromGroup", "cognito-idp:AdminDisableUser",
      "cognito-idp:AdminEnableUser", "cognito-idp:AdminGetUser",
      # The MFA policy (R6c): a user's reset by an administrator.
      "cognito-idp:AdminSetUserMFAPreference", "cognito-idp:AdminDeleteSoftwareToken",
    ]
    resources = [aws_cognito_user_pool.main.arn]
  }
  statement {
    # The Routers view shows the manager's IP lists (R6b): the catalog, and the status the list function writes.
    sid       = "ListsStatus"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.lists.arn}/catalog.json", "${aws_s3_bucket.lists.arn}/status.json"]
  }
  statement {
    # A missing status.json answers NoSuchKey, not AccessDenied.
    sid       = "ListsListing"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.lists.arn]
  }
  statement {
    # The Overview says where alerts go (R6a).
    sid       = "AlertSubscriptions"
    actions   = ["sns:ListSubscriptionsByTopic"]
    resources = [aws_sns_topic.alerts.arn]
  }
  # With an SES identity, invitations while SES is in the sandbox: the invited address is verified as an SES identity
  # first. Without, Cognito sends its own email to any address.
  dynamic "statement" {
    for_each = var.ses_identity == null ? [] : [1]
    content {
      sid       = "SesSandbox"
      actions   = ["ses:GetAccount", "ses:GetEmailIdentity", "ses:CreateEmailIdentity"]
      resources = ["*"]
    }
  }
  statement {
    # Discovery: run on demand (the discovery state machine).
    sid       = "Discovery"
    actions   = ["states:StartExecution"]
    resources = [aws_sfn_state_machine.discovery.arn]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.api.arn}:*"]
  }
}

resource "aws_iam_role_policy" "api" {
  name   = "api"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}

resource "aws_lambda_function" "api" {
  function_name    = "${local.name}-api"
  role             = aws_iam_role.api.arn
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = local.artifact.api
  source_code_hash = filebase64sha256(local.artifact.api)
  # The HTTP API waits at most 30 s; discovery and status calls take a few seconds.
  timeout     = 29
  memory_size = 512

  environment {
    variables = {
      # Routers run in the manager account until onboarding deploys them elsewhere (R4).
      ROUTERS                 = local.routers
      OPERATIONS              = aws_sfn_state_machine.operations.arn
      MANAGER_ACCOUNT         = local.account_id
      ENV                     = var.env
      ROUTER_VERSION          = local.router_version
      TABLE                   = aws_dynamodb_table.manager.name
      VERSION                 = local.version
      USER_POOL_ID            = aws_cognito_user_pool.main.id
      EMAIL_SENDER            = var.ses_identity == null ? "cognito" : "ses"
      DASHBOARD_URL           = "https://${local.dashboard_host}/"
      DISCOVERY_STATE_MACHINE = aws_sfn_state_machine.discovery.arn
      ALERTS_TOPIC            = aws_sns_topic.alerts.arn
      LISTS_BUCKET            = aws_s3_bucket.lists.id
      MFA_MODE                = var.mfa
      # The organization roles, shown in the dashboard (packaging design §3).
      DISCOVERY_ROLE = var.discovery_role_name
      COMMAND_ROLE   = var.command_role_name
    }
  }

  depends_on = [aws_cloudwatch_log_group.api, aws_iam_role_policy.api, terraform_data.artifacts]
}

resource "aws_apigatewayv2_api" "api" {
  name          = "${local.name}-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_authorizer" "cognito" {
  api_id           = aws_apigatewayv2_api.api.id
  authorizer_type  = "JWT"
  name             = "cognito"
  identity_sources = ["$request.header.Authorization"]

  jwt_configuration {
    issuer   = "https://${aws_cognito_user_pool.main.endpoint}"
    audience = concat([aws_cognito_user_pool_client.dashboard.id], aws_cognito_user_pool_client.smoke[*].id)
  }
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "health" {
  api_id    = aws_apigatewayv2_api.api.id
  route_key = "GET /api/health"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_apigatewayv2_route" "api" {
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "ANY /api/{proxy+}"
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.api.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = 50
    throttling_rate_limit  = 20
  }
}

resource "aws_lambda_permission" "api" {
  statement_id  = "http-api"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}
