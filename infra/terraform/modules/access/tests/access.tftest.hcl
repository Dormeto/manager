# The organization roles of one account (packaging design §3, R5a review I2): several manager environments share them,
# each trusted by its own roles; one boundary per account.
mock_provider "aws" {
  override_data {
    target = data.aws_caller_identity.current
    values = { account_id = "222222222222" }
  }
  override_data {
    target = data.aws_partition.current
    values = { partition = "aws-us-gov" }
  }
  override_data {
    target = module.command_role[0].data.aws_caller_identity.current
    values = { account_id = "222222222222" }
  }
  override_data {
    target = module.command_role[0].data.aws_partition.current
    values = { partition = "aws-us-gov" }
  }
}

variables {
  manager_account_id = "121014831971"
  envs               = ["dev", "try"]
  boundary_policy    = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
}

run "the_discovery_role_trusts_the_discovery_role_of_every_environment" {
  command = plan
  variables {
    organization_id = "o-abcdefghij"
  }

  assert {
    condition = jsondecode(aws_iam_role.discovery.assume_role_policy) == {
      Version = "2012-10-17"
      Statement = [{
        Effect    = "Allow"
        Action    = "sts:AssumeRole"
        Principal = { AWS = "arn:aws-us-gov:iam::121014831971:root" }
        Condition = {
          ArnLike      = { "aws:PrincipalArn" = ["arn:aws-us-gov:iam::121014831971:role/dmt-dev-manager-discovery", "arn:aws-us-gov:iam::121014831971:role/dmt-try-manager-discovery"] }
          StringEquals = { "aws:PrincipalOrgID" = "o-abcdefghij" }
        }
      }]
    }
    error_message = "The discovery role must trust each environment's discovery role, in the account's partition, within the organization."
  }
  assert {
    condition     = length(module.command_role) == 1
    error_message = "One command role (and one boundary) for every environment."
  }
}

run "without_an_organization_no_organization_condition" {
  command = plan

  assert {
    condition     = keys(jsondecode(aws_iam_role.discovery.assume_role_policy).Statement[0].Condition) == ["ArnLike"]
    error_message = "Without organization_id, the trust has no organization condition."
  }
}

# An account set up without the command role declares it on its discovery role: the manager counts it as discovery only
# rather than missing a role.
run "an_account_without_the_command_role_says_so" {
  command = plan
  variables {
    create_command_role = false
  }

  assert {
    condition     = aws_iam_role.discovery.tags["dormeto:command-role"] == "none" && length(module.command_role) == 0
    error_message = "Without the command role, the discovery role is tagged dormeto:command-role = none."
  }
}

run "with_the_command_role_no_such_tag" {
  command = plan

  assert {
    condition     = !contains(keys(aws_iam_role.discovery.tags), "dormeto:command-role")
    error_message = "With the command role, the discovery role carries no discovery-only tag."
  }
}
