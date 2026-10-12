# The command role's trust (packaging design §3, R5a review I2): the operations roles of every manager environment that
# shares the account's roles, by name within the manager's account, so that the role can exist before the manager and
# survives its reinstallation.
mock_provider "aws" {
  override_data {
    target = data.aws_caller_identity.current
    values = { account_id = "222222222222" }
  }
  override_data {
    target = data.aws_partition.current
    values = { partition = "aws" }
  }
}

variables {
  manager_account_id = "121014831971"
  envs               = ["dev", "try"]
  boundary_policy    = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
}

run "trusts_the_operations_role_of_every_environment" {
  command = plan

  assert {
    condition = jsondecode(aws_iam_role.command.assume_role_policy) == {
      Version = "2012-10-17"
      Statement = [{
        Effect    = "Allow"
        Action    = "sts:AssumeRole"
        Principal = { AWS = "arn:aws:iam::121014831971:root" }
        Condition = { ArnLike = { "aws:PrincipalArn" = ["arn:aws:iam::121014831971:role/dmt-dev-manager-operations", "arn:aws:iam::121014831971:role/dmt-try-manager-operations"] } }
      }]
    }
    error_message = "The command role must trust the operations role of each environment, by name in the manager's account."
  }
}

run "refuses_an_environment_the_manager_cannot_have" {
  command = plan
  variables {
    envs = ["Dev"]
  }
  expect_failures = [var.envs]
}

run "refuses_no_environment" {
  command = plan
  variables {
    envs = []
  }
  expect_failures = [var.envs]
}
