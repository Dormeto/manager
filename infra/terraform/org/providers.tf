# Organization management account: delegation policy and StackSets (vision docs/architecture/organization-iam.md).
provider "aws" {
  region              = var.region
  profile             = var.aws_profile
  allowed_account_ids = [var.management_account_id]

  default_tags {
    tags = {
      env     = var.env
      project = "dormeto"
    }
  }
}

# A member account where the manager installs routers, through an administrator profile of that account (an account
# invited into the organization has no OrganizationAccountAccessRole): DmtCommandRole and DmtRouterBoundary are created by
# API calls (no CloudFormation).
provider "aws" {
  alias               = "command"
  region              = var.region
  profile             = var.command_profile
  allowed_account_ids = [var.command_account_id]

  default_tags {
    tags = {
      env     = var.env
      project = "dormeto"
    }
  }
}
