# Organization management account: delegation policy and StackSets (vision docs/architecture/organization-iam.md).
provider "aws" {
  region              = var.region
  profile             = var.aws_profile
  allowed_account_ids = [var.management_account_id]

  default_tags {
    tags = {
      env     = var.env
      project = "dormeto"
    }
  }
}
