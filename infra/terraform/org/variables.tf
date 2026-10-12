variable "env" {
  description = "Manager environment whose discovery role reads the organization (dmt-<env>-manager-discovery)."
  type        = string
}

variable "region" {
  type    = string
  default = "eu-west-1"
}

variable "aws_profile" {
  description = "Profile of the organization management account."
  type        = string
  default     = "kloudy-master"
}

variable "management_account_id" {
  type = string
}

variable "manager_account_id" {
  description = "Account of the manager (its discovery role is trusted by the member roles)."
  type        = string
}

variable "discovery_accounts" {
  description = "Accounts that get DmtDiscoveryRole. Only these can ever be read by discovery."
  type        = list(string)
  validation {
    condition     = alltrue([for a in var.discovery_accounts : can(regex("^\\d{12}$", a))])
    error_message = "discovery_accounts must be 12-digit account IDs."
  }
}
