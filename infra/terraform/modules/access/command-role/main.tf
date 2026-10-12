# DmtCommandRole and DmtRouterBoundary in one account (vision docs/specs/2026-10-05-onboarding-design.md, R4b): the
# manager's operations assume the role to install, upgrade and remove routers by API calls. Installed routers are named
# dmtr-<env> with roles under /dormeto/router/: the role reaches that namespace only, never a router written in Terraform
# (dmt-<env>) nor the manager (dmt-<env>-manager); every role it creates carries the boundary. It invokes the controllers
# and onboarders of every router (onboarding through a router written in Terraform).
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
  description = "Environments of the manager whose operations role (dmt-<env>-manager-operations) may assume the role: several managers may share an account's roles."
  type        = list(string)
  validation {
    # The manager's environment names (at most 10 characters, as its env variable).
    condition     = length(var.envs) > 0 && alltrue([for env in var.envs : can(regex("^[a-z0-9]([a-z0-9-]{0,8}[a-z0-9])?$", env))])
    error_message = "envs must list at least one environment of 1 to 10 lowercase letters, digits or inner hyphens."
  }
}

variable "role_name" {
  description = "The command role's name, a path may precede it (path/name)."
  type        = string
  default     = "DmtCommandRole"
}

variable "boundary_policy" {
  description = "DmtRouterBoundary policy document: the router's dist/router-boundary.json with $${account} and $${partition} filled."
  type        = string
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  role_parts = split("/", var.role_name)
  role_path  = length(local.role_parts) > 1 ? "/${join("/", slice(local.role_parts, 0, length(local.role_parts) - 1))}/" : "/"
  account    = data.aws_caller_identity.current.account_id
  arn        = "arn:${data.aws_partition.current.partition}"
  roles      = "${local.arn}:iam::${local.account}:role/dormeto/router/*"
  boundary   = "${local.arn}:iam::${local.account}:policy/DmtRouterBoundary"
}

resource "aws_iam_policy" "boundary" {
  name        = "DmtRouterBoundary"
  description = "Permissions boundary of every role Dormeto creates for a router."
  policy      = var.boundary_policy
}

resource "aws_iam_role" "command" {
  name        = element(local.role_parts, length(local.role_parts) - 1)
  path        = local.role_path
  description = "Dormeto manager: installs, upgrades and removes routers by API calls, onboards workloads through them."
  # By name within the manager's account (R5a review I2): the role can exist before the manager does, and a reinstalled
  # manager is trusted again (a role ARN as principal is bound to the role it named then).
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { AWS = "${local.arn}:iam::${var.manager_account_id}:root" }
      Condition = { ArnLike = { "aws:PrincipalArn" = [for env in var.envs : "${local.arn}:iam::${var.manager_account_id}:role/dmt-${env}-manager-operations"] } }
    }]
  })
  max_session_duration = 3600
}

# The policy as a document with $${account} and $${partition} (packaging design §3): the AWS CLI procedure fills the same.
resource "aws_iam_role_policy" "command" {
  name   = "command"
  role   = aws_iam_role.command.id
  policy = replace(replace(file("${path.module}/command-policy.json"), "$${account}", local.account), "$${partition}", data.aws_partition.current.partition)
}

output "role_arn" {
  value = aws_iam_role.command.arn
}

output "boundary_arn" {
  value = aws_iam_policy.boundary.arn
}
