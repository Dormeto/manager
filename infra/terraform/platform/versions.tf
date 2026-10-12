terraform {
  required_version = "~> 1.16.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.67"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.8"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.9"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.13"
    }
  }

  # The key comes from env/<env>.backend.hcl: terraform init -backend-config=env/dev.backend.hcl
  backend "s3" {
    bucket       = "terraform-states-121014831971-eu-west-1-an"
    region       = "eu-west-1"
    profile      = "kloudy-dormeto-prd"
    use_lockfile = true
    encrypt      = true
  }
}
