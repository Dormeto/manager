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

variable "boundary_policy" {
  description = "DmtRouterBoundary policy document: the router's dist/router-boundary.json with $${account} and $${partition} filled."
  type        = string
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  account  = data.aws_caller_identity.current.account_id
  arn      = "arn:${data.aws_partition.current.partition}"
  roles    = "${local.arn}:iam::${local.account}:role/dormeto/router/*"
  boundary = "${local.arn}:iam::${local.account}:policy/DmtRouterBoundary"
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
  name                 = "DmtCommandRole"
  description          = "Dormeto manager: installs, upgrades and removes routers by API calls, onboards workloads through them."
  assume_role_policy   = data.aws_iam_policy_document.trust.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "command" {
  statement {
    sid       = "RouterRolesWithBoundary"
    actions   = ["iam:CreateRole", "iam:PutRolePolicy", "iam:DeleteRolePolicy"]
    resources = [local.roles]
    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [local.boundary]
    }
  }
  statement {
    sid       = "RouterRoles"
    actions   = ["iam:UpdateAssumeRolePolicy", "iam:TagRole", "iam:DeleteRole"]
    resources = [local.roles]
  }
  statement {
    # Reads: a role that does not exist yet is authorized without its path (its ARN is unknown).
    sid       = "RouterRolesRead"
    actions   = ["iam:GetRole", "iam:GetRolePolicy", "iam:ListRolePolicies"]
    resources = [local.roles, "${local.arn}:iam::${local.account}:role/dmtr-*"]
  }
  statement {
    sid       = "PassRouterRoles"
    actions   = ["iam:PassRole"]
    resources = [local.roles]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["lambda.amazonaws.com", "scheduler.amazonaws.com"]
    }
  }
  statement {
    sid = "RouterFunctions"
    actions = [
      "lambda:CreateFunction", "lambda:TagResource", "lambda:GetFunction", "lambda:GetFunctionConfiguration", "lambda:UpdateFunctionCode",
      "lambda:UpdateFunctionConfiguration", "lambda:GetFunctionEventInvokeConfig", "lambda:PutFunctionEventInvokeConfig", "lambda:GetPolicy",
      "lambda:AddPermission", "lambda:DeleteFunction", "lambda:InvokeFunction",
    ]
    resources = ["${local.arn}:lambda:*:${local.account}:function:dmtr-*"]
  }
  statement {
    sid       = "InvokeRouters"
    actions   = ["lambda:InvokeFunction"]
    resources = ["${local.arn}:lambda:*:${local.account}:function:dmt-*-controller", "${local.arn}:lambda:*:${local.account}:function:dmt-*-onboarder"]
  }
  statement {
    sid       = "RouterTables"
    actions   = ["dynamodb:CreateTable", "dynamodb:TagResource", "dynamodb:DescribeTable", "dynamodb:DescribeTimeToLive", "dynamodb:UpdateTimeToLive", "dynamodb:DescribeContinuousBackups", "dynamodb:UpdateContinuousBackups", "dynamodb:DeleteTable"]
    resources = ["${local.arn}:dynamodb:*:${local.account}:table/dmtr-*"]
  }
  statement {
    sid       = "RouterQueues"
    actions   = ["sqs:CreateQueue", "sqs:TagQueue", "sqs:GetQueueUrl", "sqs:GetQueueAttributes", "sqs:DeleteQueue"]
    resources = ["${local.arn}:sqs:*:${local.account}:dmtr-*"]
  }
  statement {
    sid       = "RouterLogs"
    actions   = ["logs:CreateLogGroup", "logs:TagResource", "logs:TagLogGroup", "logs:PutRetentionPolicy", "logs:DeleteLogGroup"]
    resources = ["${local.arn}:logs:*:${local.account}:log-group:/aws/lambda/dmtr-*"]
  }
  statement {
    sid       = "DescribeLogGroups"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }
  statement {
    sid       = "RouterSchedules"
    actions   = ["scheduler:CreateSchedule", "scheduler:GetSchedule", "scheduler:UpdateSchedule", "scheduler:DeleteSchedule"]
    resources = ["${local.arn}:scheduler:*:${local.account}:schedule/default/dmtr-*"]
  }
}

resource "aws_iam_role_policy" "command" {
  name   = "command"
  role   = aws_iam_role.command.id
  policy = data.aws_iam_policy_document.command.json
}

output "role_arn" {
  value = aws_iam_role.command.arn
}

output "boundary_arn" {
  value = aws_iam_policy.boundary.arn
}
