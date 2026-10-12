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

variable "operations_role_arn" {
  description = "Role of the manager's operations Lambda, the only principal allowed to assume DmtCommandRole."
  type        = string
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

data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "AWS"
      identifiers = [var.operations_role_arn]
    }
  }
}

resource "aws_iam_role" "command" {
  name                 = element(local.role_parts, length(local.role_parts) - 1)
  path                 = local.role_path
  description          = "Dormeto manager: installs, upgrades and removes routers by API calls, onboards workloads through them."
  assume_role_policy   = data.aws_iam_policy_document.trust.json
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
