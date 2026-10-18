variable "env" {
  description = "Environment name: resource names dmt-<env>-manager-*."
  type        = string
  validation {
    # Installed routers are dmtr-<env>; their waker target groups dmtr-<env>-<16-character workload id> hold in 32.
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,8}[a-z0-9])?$", var.env))
    error_message = "env must have 1 to 10 lowercase letters, digits or inner hyphens (installed routers dmtr-<env>, waker target groups dmtr-<env>-<workload id>)."
  }
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
