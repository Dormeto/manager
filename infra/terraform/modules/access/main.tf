# Dormeto's organization roles in one member account (vision docs/specs/2026-10-06-packaging-design.md, section 3): the
# read-only discovery role, and the command role with its permissions boundary (module command-role, nested: the module is self-contained). Published with each
# release; the manager supposes these roles are there, under these names unless its Terraform names others.
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
  description = "Environments of the manager (its roles are dmt-<env>-manager-*): several managers may share the account's roles, each trusted by its own."
  type        = list(string)
  validation {
    # The manager's environment names (at most 10 characters, as its env variable).
    condition     = length(var.envs) > 0 && alltrue([for env in var.envs : can(regex("^[a-z0-9]([a-z0-9-]{0,8}[a-z0-9])?$", env))])
    error_message = "envs must list at least one environment of 1 to 10 lowercase letters, digits or inner hyphens."
  }
}

variable "organization_id" {
  description = "Organization of the accounts (o-…): the discovery role trusts the manager within it only. Null: no such condition."
  type        = string
  default     = null
}

variable "discovery_role_name" {
  description = "The discovery role's name, a path may precede it (path/name)."
  type        = string
  default     = "DmtDiscoveryRole"
}

variable "command_role_name" {
  description = "The command role's name, a path may precede it (path/name)."
  type        = string
  default     = "DmtCommandRole"
}

variable "create_command_role" {
  description = "False: an account discovered but never napped (no command role, no boundary); its discovery role is then tagged dormeto:command-role = none, and the manager counts it as discovery only."
  type        = bool
  default     = true
}

variable "boundary_policy" {
  description = "DmtRouterBoundary with $${account} and $${partition} filled; null: router-boundary.json of the release, beside this module."
  type        = string
  default     = null
}

locals {
  parts         = split("/", var.discovery_role_name)
  boundary_file = "${path.module}/router-boundary.json"
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  manager = "arn:${data.aws_partition.current.partition}:iam::${var.manager_account_id}"
}

resource "aws_iam_role" "discovery" {
  name        = element(local.parts, length(local.parts) - 1)
  path        = length(local.parts) > 1 ? "/${join("/", slice(local.parts, 0, length(local.parts) - 1))}/" : "/"
  description = "Dormeto discovery (read-only)"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { AWS = "${local.manager}:root" }
      Condition = merge(
        { ArnLike = { "aws:PrincipalArn" = [for env in var.envs : "${local.manager}:role/dmt-${env}-manager-discovery"] } },
        var.organization_id == null ? {} : { StringEquals = { "aws:PrincipalOrgID" = var.organization_id } },
      )
    }]
  })
  max_session_duration = 3600
  # Without the command role, the account says it is set up for discovery only: the manager counts it apart.
  tags = merge({ "dormeto:component" = "discovery" }, var.create_command_role ? {} : { "dormeto:command-role" = "none" })
}

resource "aws_iam_role_policy" "discovery" {
  name   = "discovery"
  role   = aws_iam_role.discovery.id
  policy = replace(replace(file("${path.module}/discovery-policy.json"), "$${account}", data.aws_caller_identity.current.account_id), "$${partition}", data.aws_partition.current.partition)
}

module "command_role" {
  source             = "./command-role"
  count              = var.create_command_role ? 1 : 0
  role_name          = var.command_role_name
  manager_account_id = var.manager_account_id
  envs               = var.envs
  boundary_policy = replace(replace(coalesce(var.boundary_policy, fileexists(local.boundary_file) ? file(local.boundary_file) : "missing"),
  "$${account}", data.aws_caller_identity.current.account_id), "$${partition}", data.aws_partition.current.partition)
}

output "discovery_role_arn" {
  value = aws_iam_role.discovery.arn
}

output "command_role_arn" {
  value = var.create_command_role ? module.command_role[0].role_arn : null
  precondition {
    condition     = !var.create_command_role || var.boundary_policy != null || fileexists(local.boundary_file)
    error_message = "boundary_policy is required: router-boundary.json was not found beside the module."
  }
}
