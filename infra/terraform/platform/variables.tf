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

variable "routers" {
  description = "Routers written in Terraform, operated by this manager: name, region, controller and onboarder Lambda function names (same account). Routers the manager installs are registered in its table."
  type = list(object({
    name       = string
    region     = string
    controller = string
    onboarder  = optional(string)
  }))
  default = []
}

variable "admin_emails" {
  description = "Bootstrap administrators, invited by email (set in env/<env>.local.tfvars, not committed). While SES is in the sandbox, each address must be a verified SES identity."
  type        = list(string)
  default     = []
}

variable "alert_emails" {
  description = "Addresses of the health alerts (personal: env/dev.local.tfvars, git-ignored)."
  type        = list(string)
  default     = []
}

variable "ip_lists" {
  description = "The manager's IP lists (manager module ip_lists)."
  type = list(object({
    name          = string
    url           = string
    action        = optional(string, "defer")
    refresh_hours = optional(number, 24)
  }))
  default = []
}

variable "mfa" {
  description = "The MFA policy (manager module mfa)."
  type        = string
  default     = "operators"
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

variable "organization_id" {
  description = "AWS organization of the discovery perimeter: the discovery Lambda only assumes roles of this organization."
  type        = string
  validation {
    condition     = can(regex("^o-[a-z0-9]{10,32}$", var.organization_id))
    error_message = "organization_id must look like o-xxxxxxxxxx."
  }
}

variable "discovery_role_name" {
  description = "Read-only role the manager assumes in each account of the perimeter (modules/access); a path may precede the name."
  type        = string
  default     = "DmtDiscoveryRole"
}

variable "command_role_name" {
  description = "Role the manager assumes in each account to install routers and act on their rules (DmtCommandRole, modules/access); a path may precede the name."
  type        = string
  default     = "DmtCommandRole"
}

variable "create_organization_roles" {
  description = "Create the organization roles of this account (module access: DmtDiscoveryRole, DmtCommandRole, DmtRouterBoundary). False for a second environment in an account whose roles another environment creates (that one lists this one in organization_role_envs)."
  type        = bool
  default     = true
}

variable "organization_role_envs" {
  description = "Other manager environments of this account that the organization roles created here trust, besides this one."
  type        = list(string)
  default     = []
}

variable "discovery_synthetic_accounts" {
  description = "Dev only: a synthetic organization of this many accounts added to the real one by discovery (acceptance at scale); 0 in every other environment."
  type        = number
  default     = 0
  validation {
    condition     = var.discovery_synthetic_accounts >= 0 && var.discovery_synthetic_accounts <= 1000
    error_message = "discovery_synthetic_accounts must be between 0 and 1000."
  }
}
