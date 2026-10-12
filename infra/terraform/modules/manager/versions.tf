terraform {
  required_version = ">= 1.9"
  required_providers {
    aws     = { source = "hashicorp/aws", version = ">= 6.67, < 7.0" }
    archive = { source = "hashicorp/archive", version = ">= 2.8, < 3.0" }
    random  = { source = "hashicorp/random", version = ">= 3.9, < 4.0" }
    time    = { source = "hashicorp/time", version = ">= 0.13, < 1.0" }
  }
}
