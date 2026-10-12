data "aws_organizations_organization" "this" {}

locals {
  root_id             = data.aws_organizations_organization.this.roots[0].id
  discovery_principal = "arn:aws:iam::${var.manager_account_id}:role/dmt-${var.env}-manager-discovery"
}

# Read-only Organizations calls for the manager discovery role (one resource policy per organization: owned here).
resource "aws_organizations_resource_policy" "dormeto" {
  content = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DormetoReadOrganization"
      Effect    = "Allow"
      Principal = { AWS = local.discovery_principal }
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

resource "aws_cloudformation_stack_set" "discovery" {
  name             = "dmt-discovery"
  description      = "Dormeto read-only discovery role (DmtDiscoveryRole)"
  permission_model = "SERVICE_MANAGED"
  capabilities     = ["CAPABILITY_NAMED_IAM"]
  template_body    = file("${path.module}/../../org/discovery-role.yaml")
  parameters = {
    ManagerAccountId = var.manager_account_id
    ManagerRoleArns  = local.discovery_principal
    OrganizationId   = data.aws_organizations_organization.this.id
  }

  auto_deployment {
    enabled = false
  }

  # Managed by AWS for service-managed StackSets.
  lifecycle {
    ignore_changes = [administration_role_arn]
  }
}

# Only the listed accounts: the root OU intersected with discovery_accounts. IAM is global: one region.
resource "aws_cloudformation_stack_set_instance" "discovery" {
  stack_set_name            = aws_cloudformation_stack_set.discovery.name
  stack_set_instance_region = var.region

  deployment_targets {
    organizational_unit_ids = [local.root_id]
    accounts                = var.discovery_accounts
    account_filter_type     = "INTERSECTION"
  }

  operation_preferences {
    failure_tolerance_count = 0
    max_concurrent_count    = 2
  }
}
