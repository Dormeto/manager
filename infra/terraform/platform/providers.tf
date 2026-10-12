provider "aws" {
  region              = var.region
  profile             = var.aws_profile
  allowed_account_ids = [var.account_id]

  default_tags {
    tags = {
      env     = var.env
      project = "dormeto"
    }
  }
}

# CloudFront and Cognito custom domain certificates live in us-east-1.
provider "aws" {
  alias               = "us_east_1"
  region              = "us-east-1"
  profile             = var.aws_profile
  allowed_account_ids = [var.account_id]

  default_tags {
    tags = {
      env     = var.env
      project = "dormeto"
    }
  }
}
