# Organization discovery (vision docs/specs/2026-10-04-org-discovery-design.md): the discovery Lambda reads the
# organization through its delegation policy and assumes the read-only DmtDiscoveryRole in each account of the perimeter.

resource "aws_iam_role" "discovery" {
  name               = "${local.name}-discovery"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "discovery" {
  statement {
    sid       = "ReadOrganization"
    actions   = ["organizations:Describe*", "organizations:List*"]
    resources = ["*"]
  }
  statement {
    sid       = "AssumeDiscoveryRoles"
    actions   = ["sts:AssumeRole"]
    resources = ["arn:aws:iam::*:role/${var.discovery_role_name}"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceOrgID"
      values   = [var.organization_id]
    }
  }
  statement {
    sid       = "DiscoveryItems"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:BatchWriteItem"]
    resources = [aws_dynamodb_table.manager.arn]
  }
}

resource "aws_iam_role_policy" "discovery" {
  name   = "discovery"
  role   = aws_iam_role.discovery.id
  policy = data.aws_iam_policy_document.discovery.json
}
