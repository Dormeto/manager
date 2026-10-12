variable "env" {
  description = "Environment name: resource names dmt-<env>-manager-*."
  type        = string
}

variable "region" {
  type    = string
  default = "eu-west-1"
}

variable "aws_profile" {
  type    = string
  default = "kloudy-dormeto-prd"
}

variable "account_id" {
  type    = string
  default = "121014831971"
}

variable "zone_id" {
  description = "Route 53 hosted zone of dormeto.com."
  type        = string
  default     = "Z01943593T1RNPIO8DLPX"
}

variable "dashboard_domain" {
  description = "Dashboard host name, for example app.dev.dormeto.com."
  type        = string
}

variable "auth_domain" {
  description = "Cognito managed login host name, under the dashboard host so that its parent resolves (auth.<dashboard_domain>)."
  type        = string
}

variable "routers" {
  description = "Routers operated by this manager: name, region and controller Lambda function name (same account)."
  type = list(object({
    name       = string
    region     = string
    controller = string
  }))
  default = []
}

variable "admin_emails" {
  description = "Bootstrap administrators, invited by email (set in env/<env>.local.tfvars, not committed). While SES is in the sandbox, each address must be a verified SES identity."
  type        = list(string)
  default     = []
}

variable "email_identity" {
  description = "Verified SES identity used by Cognito to send invitations (managed by the website stack)."
  type        = string
  default     = "dormeto.com"
}

variable "email_from" {
  type    = string
  default = "Dormeto <no-reply@dormeto.com>"
}

variable "local_dev" {
  description = "Allow the local Vite server (http://localhost:5173) as a sign-in callback."
  type        = bool
  default     = false
}

variable "smoke_user" {
  description = "Create the smoke-test client and user (password in SSM): automated checks only, dev only."
  type        = bool
  default     = false
}

variable "log_retention_days" {
  type    = number
  default = 30
}

locals {
  name    = "dmt-${var.env}-manager"
  version = jsondecode(file("${path.module}/../../../package.json")).version
}
