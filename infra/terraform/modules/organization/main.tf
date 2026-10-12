# The Organizations delegation policy of the management account (vision docs/specs/2026-10-06-packaging-design.md,
# section 3): the manager's discovery role may read the organization (accounts, organizational units, account tags).
# Without it, organization mode is unavailable. Published with each release. An organization has one resource policy:
# this module manages it whole, with the organization's other statements in additional_statements.
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

variable "additional_statements" {
  description = "The organization's other statements of its resource policy (other tools or teams), kept beside Dormeto's: the policy is one per organization, and this module writes it whole. Read the current one with aws organizations describe-resource-policy."
  type        = any
  default     = []
  validation {
    condition     = alltrue([for s in var.additional_statements : try(s.Sid, "") != "DormetoReadOrganization"])
    error_message = "DormetoReadOrganization is Dormeto's statement: the module writes it."
  }
}

data "aws_partition" "current" {}

# The policy as a document (one source with the release's dormeto-organization-policy.json), its principal filled, then
# the organization's other statements.
locals {
  dormeto = jsondecode(replace(file("${path.module}/organization-policy.json"), "\"$${principals}\"", jsonencode([for env in var.envs : "arn:${data.aws_partition.current.partition}:iam::${var.manager_account_id}:role/dmt-${env}-manager-discovery"])))
}

resource "aws_organizations_resource_policy" "dormeto" {
  content = jsonencode({ Version = local.dormeto.Version, Statement = concat(local.dormeto.Statement, var.additional_statements) })
}
