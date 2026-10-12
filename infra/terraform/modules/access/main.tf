# Dormeto's organization roles in one member account (vision docs/specs/2026-10-06-packaging-design.md, section 3): the
# read-only discovery role, and the command role with its permissions boundary (module command-role). Published with each
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

variable "env" {
  description = "Environment of the manager (its roles are dmt-<env>-manager-*)."
  type        = string
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
  description = "Create the command role and its boundary (false where they exist already, as in the manager's account)."
  type        = bool
  default     = true
}

variable "boundary_policy" {
  description = "DmtRouterBoundary with $${account} and $${partition} filled; null: router-boundary.json of the release, beside this module."
  type        = string
  default     = null
}

locals {
  manager_roles = "arn:aws:iam::${var.manager_account_id}:role/dmt-${var.env}-manager"
  parts         = split("/", var.discovery_role_name)
  boundary_file = "${path.module}/router-boundary.json"
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${var.manager_account_id}:root"]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:PrincipalArn"
      values   = ["${local.manager_roles}-discovery"]
    }
    dynamic "condition" {
      for_each = var.organization_id == null ? [] : [var.organization_id]
      content {
        test     = "StringEquals"
        variable = "aws:PrincipalOrgID"
        values   = [condition.value]
      }
    }
  }
}

resource "aws_iam_role" "discovery" {
  name                 = element(local.parts, length(local.parts) - 1)
  path                 = length(local.parts) > 1 ? "/${join("/", slice(local.parts, 0, length(local.parts) - 1))}/" : "/"
  description          = "Dormeto discovery (read-only)"
  assume_role_policy   = data.aws_iam_policy_document.trust.json
  max_session_duration = 3600
  tags                 = { "dormeto:component" = "discovery" }
}

resource "aws_iam_role_policy" "discovery" {
  name   = "discovery"
  role   = aws_iam_role.discovery.id
  policy = file("${path.module}/discovery-policy.json")
}

module "command_role" {
  source              = "../command-role"
  count               = var.create_command_role ? 1 : 0
  role_name           = var.command_role_name
  operations_role_arn = "${local.manager_roles}-operations"
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
