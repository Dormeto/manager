# The Organizations delegation policy of the management account (vision docs/specs/2026-10-06-packaging-design.md,
# section 3): the manager's discovery role may read the organization (accounts, organizational units, account tags).
# Without it, organization mode is unavailable. Published with each release; one resource policy per organization.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "manager_account_id" {
  description = "Account of the Dormeto manager."
  type        = string
  validation {
    condition     = can(regex("^\\d{12}$", var.manager_account_id))
    error_message = "manager_account_id must be 12 digits."
  }
}

variable "envs" {
  description = "Environments of the manager whose discovery role (dmt-<env>-manager-discovery) reads the organization."
  type        = list(string)
  validation {
    # The manager's environment names (at most 10 characters, as its env variable).
    condition     = length(var.envs) > 0 && alltrue([for env in var.envs : can(regex("^[a-z0-9]([a-z0-9-]{0,8}[a-z0-9])?$", env))])
    error_message = "envs must list at least one environment of 1 to 10 lowercase letters, digits or inner hyphens."
  }
}

data "aws_partition" "current" {}

resource "aws_organizations_resource_policy" "dormeto" {
  content = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DormetoReadOrganization"
      Effect    = "Allow"
      Principal = { AWS = [for env in var.envs : "arn:${data.aws_partition.current.partition}:iam::${var.manager_account_id}:role/dmt-${env}-manager-discovery"] }
      Action = [
        "organizations:DescribeOrganization",
        "organizations:DescribeOrganizationalUnit",
        "organizations:DescribeAccount",
        "organizations:ListRoots",
        "organizations:ListAccounts",
        "organizations:ListAccountsForParent",
        "organizations:ListOrganizationalUnitsForParent",
        "organizations:ListParents",
        "organizations:ListChildren",
        "organizations:ListTagsForResource",
      ]
      Resource = "*"
    }]
  })
}
