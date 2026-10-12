# Dev's manager: the manager module with the local build (npm run build, then npm run artifacts), as a customer installs
# a release (vision docs/specs/2026-10-06-packaging-design.md, section 4). The state of every resource moved into the
# module is kept (moved.tf).
module "manager" {
  source        = "../modules/manager"
  env           = var.env
  artifacts_dir = "${path.module}/../../../dist/artifacts"

  organization_id = var.organization_id
  admin_emails    = var.admin_emails
  alert_emails    = var.alert_emails
  ip_lists        = var.ip_lists
  mfa             = var.mfa
  domain = {
    dashboard       = var.dashboard_domain
    auth            = var.auth_domain
    certificate_arn = aws_acm_certificate_validation.edge.certificate_arn
    zone_id         = var.zone_id
  }
  ses_identity = var.email_identity
  email_from   = var.email_from

  # Dev is rebuilt at will.
  deletion_protection          = false
  routers                      = var.routers
  local_dev                    = var.local_dev
  smoke_user                   = var.smoke_user
  log_retention_days           = var.log_retention_days
  discovery_role_name          = var.discovery_role_name
  command_role_name            = var.command_role_name
  create_organization_roles    = var.create_organization_roles
  organization_role_envs       = var.organization_role_envs
  discovery_synthetic_accounts = var.discovery_synthetic_accounts
}
