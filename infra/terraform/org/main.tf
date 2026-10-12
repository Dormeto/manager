data "aws_organizations_organization" "this" {}

locals {
  discovery_principal = "arn:aws:iam::${var.manager_account_id}:role/dmt-${var.env}-manager-discovery"
}

# The delegation policy: the manager's discovery role may read the organization (module organization, published with each
# release; packaging design §3).
module "organization" {
  source             = "../modules/organization"
  manager_account_id = var.manager_account_id
  envs               = [var.env]
}

moved {
  from = aws_organizations_resource_policy.dormeto
  to   = module.organization.aws_organizations_resource_policy.dormeto
}

# The organization roles of a member account (module access, published with each release; packaging design §3): the
# discovery role, the command role and its boundary. The boundary follows the router version: apply again after a router
# upgrade that changes dist/router-boundary.json (run `npm run package` in the router repository first).
module "access" {
  source             = "../modules/access"
  providers          = { aws = aws.command }
  manager_account_id = var.manager_account_id
  envs               = [var.env]
  organization_id    = data.aws_organizations_organization.this.id
  boundary_policy    = file("${path.module}/../../../../router/dist/router-boundary.json")
}

moved {
  from = module.command_role
  to   = module.access.module.command_role[0]
}
