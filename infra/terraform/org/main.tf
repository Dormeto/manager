data "aws_organizations_organization" "this" {}

locals {
  discovery_principal = "arn:aws:iam::${var.manager_account_id}:role/dmt-${var.env}-manager-discovery"
}

# The delegation policy: the manager's discovery role may read the organization (module organization, published with each
# release; packaging design §3).
module "organization" {
  source             = "../modules/organization"
  manager_account_id = var.manager_account_id
  env                = var.env
}

moved {
  from = aws_organizations_resource_policy.dormeto
  to   = module.organization.aws_organizations_resource_policy.dormeto
}

# DmtCommandRole and DmtRouterBoundary in a member account (vision docs/specs/2026-10-05-onboarding-design.md): only the
# manager's operations role may assume it. The boundary follows the router version: apply again after a router upgrade
# that changes dist/router-boundary.json (run `npm run package` in the router repository first).
module "command_role" {
  source              = "../modules/command-role"
  providers           = { aws = aws.command }
  operations_role_arn = "arn:aws:iam::${var.manager_account_id}:role/dmt-${var.env}-manager-operations"
  boundary_policy     = replace(replace(file("${path.module}/../../../../router/dist/router-boundary.json"), "$${account}", var.command_account_id), "$${partition}", "aws")
}
