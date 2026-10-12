# The delegation policy (packaging design §3, R5a review I2): the discovery role of every manager environment reading the
# organization.
mock_provider "aws" {
  override_data {
    target = data.aws_partition.current
    values = { partition = "aws" }
  }
}

variables {
  manager_account_id = "121014831971"
  envs               = ["dev", "try"]
}

run "every_environment_reads_the_organization" {
  command = plan

  assert {
    condition     = jsondecode(aws_organizations_resource_policy.dormeto.content).Statement[0].Principal.AWS == ["arn:aws:iam::121014831971:role/dmt-dev-manager-discovery", "arn:aws:iam::121014831971:role/dmt-try-manager-discovery"]
    error_message = "The delegation policy must name each environment's discovery role."
  }
}

# An organization has one resource policy (R5b review I2): the module manages it whole, keeping the organization's other
# statements beside Dormeto's.
run "keeps_the_organization_s_other_statements" {
  command = plan
  variables {
    additional_statements = [{
      Sid       = "OtherTool"
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::333333333333:role/tool" }
      Action    = ["organizations:ListAccounts"]
      Resource  = "*"
    }]
  }

  assert {
    condition     = [for s in jsondecode(aws_organizations_resource_policy.dormeto.content).Statement : s.Sid] == ["DormetoReadOrganization", "OtherTool"]
    error_message = "Dormeto's statement first, the organization's others kept."
  }
}

run "refuses_a_second_dormeto_statement" {
  command = plan
  variables {
    additional_statements = [{ Sid = "DormetoReadOrganization", Effect = "Allow", Principal = { AWS = "*" }, Action = ["organizations:*"], Resource = "*" }]
  }
  expect_failures = [var.additional_statements]
}
