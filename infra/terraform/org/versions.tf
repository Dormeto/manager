terraform {
  required_version = "~> 1.16.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.67"
    }
  }

  # State with the other manager stacks (manager account); the provider itself acts in the management account.
  # The key comes from env/<env>.backend.hcl: terraform init -backend-config=env/dev.backend.hcl
  backend "s3" {
    bucket       = "terraform-states-121014831971-eu-west-1-an"
    region       = "eu-west-1"
    profile      = "kloudy-dormeto-prd"
    use_lockfile = true
    encrypt      = true
  }
}
