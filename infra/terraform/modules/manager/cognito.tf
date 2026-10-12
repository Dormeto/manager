# Sign-in: Cognito user pool with managed login on auth.<dashboard_domain>; users are invited by administrators.

locals {
  ses_identity_arn = var.ses_identity == null ? null : "arn:aws:ses:${local.region}:${local.account_id}:identity/${var.ses_identity}"
}

# With an SES identity (dev: dormeto.com, verified by the website stack), Cognito sends the invitations through it;
# without, Cognito sends them itself (about 50 a day, no SES production access needed).
resource "aws_ses_identity_policy" "cognito" {
  count    = var.ses_identity == null ? 0 : 1
  identity = local.ses_identity_arn
  name     = "${local.name}-cognito"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "cognito-idp.amazonaws.com" }
      Action    = ["ses:SendEmail", "ses:SendRawEmail"]
      Resource  = local.ses_identity_arn
      Condition = {
        StringEquals = { "aws:SourceAccount" = local.account_id }
        ArnLike      = { "aws:SourceArn" = "arn:aws:cognito-idp:${local.region}:${local.account_id}:userpool/*" }
      }
    }]
  })
}

resource "aws_cognito_user_pool" "main" {
  name                     = local.name
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  mfa_configuration        = "OPTIONAL"
  user_pool_tier           = "ESSENTIALS"
  deletion_protection      = var.env == "dev" ? "INACTIVE" : "ACTIVE"

  software_token_mfa_configuration {
    enabled = true
  }

  admin_create_user_config {
    allow_admin_create_user_only = true
    invite_message_template {
      email_subject = "Your Dormeto account"
      email_message = "You are invited to the Dormeto dashboard: https://${local.dashboard_host}/<br><br>Sign in with {username} and the temporary password <b>{####}</b>, then choose your own password. The temporary password expires in 7 days."
      sms_message   = "Dormeto: sign in as {username} with {####}"
    }
  }

  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = false
    temporary_password_validity_days = 7
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  email_configuration {
    email_sending_account = var.ses_identity == null ? "COGNITO_DEFAULT" : "DEVELOPER"
    source_arn            = local.ses_identity_arn
    from_email_address    = var.ses_identity == null ? null : var.email_from
  }

  depends_on = [aws_ses_identity_policy.cognito]
}

resource "aws_cognito_user_group" "role" {
  for_each     = { "dmt-admin" = 1, "dmt-operator" = 2, "dmt-viewer" = 3 }
  name         = each.key
  user_pool_id = aws_cognito_user_pool.main.id
  precedence   = each.value
}

locals {
  local_callbacks = var.local_dev ? ["http://localhost:5173/callback"] : []
  local_logouts   = var.local_dev ? ["http://localhost:5173/"] : []
}

resource "aws_cognito_user_pool_client" "dashboard" {
  name                                 = "${local.name}-dashboard"
  user_pool_id                         = aws_cognito_user_pool.main.id
  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = concat(["https://${local.dashboard_host}/callback"], local.local_callbacks)
  logout_urls                          = concat(["https://${local.dashboard_host}/"], local.local_logouts)
  explicit_auth_flows                  = ["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_SRP_AUTH"]
  prevent_user_existence_errors        = "ENABLED"
  enable_token_revocation              = true
  access_token_validity                = 1
  id_token_validity                    = 1
  refresh_token_validity               = 12

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "hours"
  }
}

resource "aws_cognito_user_pool_domain" "main" {
  # Without a domain, a prefix domain (<prefix>.auth.<region>.amazoncognito.com).
  domain                = local.custom_domain ? var.domain.auth : local.cognito_prefix
  user_pool_id          = aws_cognito_user_pool.main.id
  certificate_arn       = local.custom_domain ? var.domain.certificate_arn : null
  managed_login_version = 2

  # A custom domain needs its parent (the dashboard host) to resolve.
  depends_on = [aws_route53_record.dashboard]
}

resource "aws_route53_record" "auth" {
  count   = local.zone_id == null ? 0 : 1
  zone_id = local.zone_id
  name    = var.domain.auth
  type    = "A"

  alias {
    name                   = aws_cognito_user_pool_domain.main.cloudfront_distribution
    zone_id                = aws_cognito_user_pool_domain.main.cloudfront_distribution_zone_id
    evaluate_target_health = false
  }
}

resource "aws_cognito_managed_login_branding" "dashboard" {
  user_pool_id                = aws_cognito_user_pool.main.id
  client_id                   = aws_cognito_user_pool_client.dashboard.id
  use_cognito_provided_values = true
}

# SES sending authorizations take a while to propagate: an invitation sent right after the pool creation was dropped
# silently (2026-10-04). The bootstrap invitations wait for it.
resource "time_sleep" "ses_policy" {
  depends_on      = [aws_ses_identity_policy.cognito, aws_cognito_user_pool.main]
  create_duration = "60s"
}

resource "aws_cognito_user" "admin" {
  for_each                 = toset(var.admin_emails)
  depends_on               = [time_sleep.ses_policy]
  user_pool_id             = aws_cognito_user_pool.main.id
  username                 = each.value
  desired_delivery_mediums = ["EMAIL"]
  attributes = {
    email          = each.value
    email_verified = "true"
  }
}

resource "aws_cognito_user_in_group" "admin" {
  for_each     = aws_cognito_user.admin
  user_pool_id = aws_cognito_user_pool.main.id
  group_name   = aws_cognito_user_group.role["dmt-admin"].name
  username     = each.value.username
}

# Automated checks (dev only): a client with USER_PASSWORD_AUTH and a user whose password stays in SSM.
resource "aws_cognito_user_pool_client" "smoke" {
  count               = var.smoke_user ? 1 : 0
  name                = "${local.name}-smoke"
  user_pool_id        = aws_cognito_user_pool.main.id
  generate_secret     = false
  explicit_auth_flows = ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  id_token_validity   = 1
  token_validity_units {
    id_token = "hours"
  }
}

resource "random_password" "smoke" {
  count       = var.smoke_user ? 1 : 0
  length      = 32
  special     = false
  min_upper   = 2
  min_lower   = 2
  min_numeric = 2
}

resource "aws_cognito_user" "smoke" {
  count          = var.smoke_user ? 1 : 0
  user_pool_id   = aws_cognito_user_pool.main.id
  username       = "smoke@${local.dashboard_host}"
  message_action = "SUPPRESS"
  password       = random_password.smoke[0].result
  attributes = {
    email          = "smoke@${local.dashboard_host}"
    email_verified = "true"
  }
}

resource "aws_cognito_user_in_group" "smoke" {
  count        = var.smoke_user ? 1 : 0
  user_pool_id = aws_cognito_user_pool.main.id
  group_name   = aws_cognito_user_group.role["dmt-admin"].name
  username     = aws_cognito_user.smoke[0].username
}

resource "aws_ssm_parameter" "smoke" {
  count = var.smoke_user ? 1 : 0
  name  = "/dmt-${var.env}/manager/smoke"
  type  = "SecureString"
  value = jsonencode({
    clientId = aws_cognito_user_pool_client.smoke[0].id
    username = aws_cognito_user.smoke[0].username
    password = random_password.smoke[0].result
  })
}
