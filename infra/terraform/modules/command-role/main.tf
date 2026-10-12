# DmtCommandRole and DmtRouterBoundary in one account (vision docs/specs/2026-10-05-onboarding-design.md, R4b): the
# manager's operations assume the role to install, upgrade and remove routers by API calls. Every role it creates must carry
# the boundary; it changes and deletes only resources tagged dormeto:router (what it installed), never a router written by
# Terraform; it invokes any dmt-* function (onboarding through any router).
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
  roles    = "${local.arn}:iam::${local.account}:role/dmt-*"
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
    sid       = "RouterRolesRead"
    actions   = ["iam:GetRole", "iam:GetRolePolicy", "iam:ListRolePolicies"]
    resources = [local.roles]
  }
  statement {
    sid       = "RouterRolesTag"
    actions   = ["iam:TagRole"]
    resources = [local.roles]
    condition {
      test     = "Null"
      variable = "aws:RequestTag/dormeto:router"
      values   = ["false"]
    }
  }
  statement {
    sid       = "RouterRolesInstalled"
    actions   = ["iam:UpdateAssumeRolePolicy", "iam:DeleteRole"]
    resources = [local.roles]
    condition {
      test     = "Null"
      variable = "iam:ResourceTag/dormeto:router"
      values   = ["false"]
    }
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
    sid       = "RouterFunctionsCreate"
    actions   = ["lambda:CreateFunction", "lambda:TagResource"]
    resources = ["${local.arn}:lambda:*:${local.account}:function:dmt-*"]
    condition {
      test     = "Null"
      variable = "aws:RequestTag/dormeto:router"
      values   = ["false"]
    }
  }
  statement {
    sid       = "RouterFunctionsInstalled"
    actions   = ["lambda:UpdateFunctionCode", "lambda:UpdateFunctionConfiguration", "lambda:PutFunctionEventInvokeConfig", "lambda:AddPermission", "lambda:DeleteFunction"]
    resources = ["${local.arn}:lambda:*:${local.account}:function:dmt-*"]
    condition {
      test     = "Null"
      variable = "aws:ResourceTag/dormeto:router"
      values   = ["false"]
    }
  }
  statement {
    sid       = "RouterFunctionsReadInvoke"
    actions   = ["lambda:GetFunction", "lambda:GetFunctionConfiguration", "lambda:GetFunctionEventInvokeConfig", "lambda:GetPolicy", "lambda:InvokeFunction"]
    resources = ["${local.arn}:lambda:*:${local.account}:function:dmt-*"]
  }
  statement {
    sid       = "RouterTables"
    actions   = ["dynamodb:CreateTable", "dynamodb:TagResource", "dynamodb:DescribeTable", "dynamodb:DescribeTimeToLive", "dynamodb:DescribeContinuousBackups"]
    resources = ["${local.arn}:dynamodb:*:${local.account}:table/dmt-*"]
  }
  statement {
    sid       = "RouterTablesInstalled"
    actions   = ["dynamodb:UpdateTimeToLive", "dynamodb:UpdateContinuousBackups", "dynamodb:DeleteTable"]
    resources = ["${local.arn}:dynamodb:*:${local.account}:table/dmt-*"]
    condition {
      test     = "Null"
      variable = "aws:ResourceTag/dormeto:router"
      values   = ["false"]
    }
  }
  statement {
    sid       = "RouterQueues"
    actions   = ["sqs:CreateQueue", "sqs:TagQueue", "sqs:GetQueueUrl", "sqs:GetQueueAttributes"]
    resources = ["${local.arn}:sqs:*:${local.account}:dmt-*"]
  }
  statement {
    sid       = "RouterQueuesInstalled"
    actions   = ["sqs:DeleteQueue"]
    resources = ["${local.arn}:sqs:*:${local.account}:dmt-*"]
    condition {
      test     = "Null"
      variable = "aws:ResourceTag/dormeto:router"
      values   = ["false"]
    }
  }
  statement {
    sid       = "RouterLogs"
    actions   = ["logs:CreateLogGroup", "logs:TagResource", "logs:TagLogGroup", "logs:PutRetentionPolicy", "logs:DeleteLogGroup"]
    resources = ["${local.arn}:logs:*:${local.account}:log-group:/aws/lambda/dmt-*"]
  }
  statement {
    sid       = "DescribeLogGroups"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }
  statement {
    sid       = "RouterSchedules"
    actions   = ["scheduler:CreateSchedule", "scheduler:GetSchedule", "scheduler:UpdateSchedule", "scheduler:DeleteSchedule"]
    resources = ["${local.arn}:scheduler:*:${local.account}:schedule/default/dmt-*"]
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
