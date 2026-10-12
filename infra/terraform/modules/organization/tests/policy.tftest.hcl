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
