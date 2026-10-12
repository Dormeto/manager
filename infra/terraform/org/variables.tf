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

variable "command_account_id" {
  description = "Member account that gets DmtCommandRole and DmtRouterBoundary, so that the manager installs routers there by API calls (the manager's own account gets them from the platform stack)."
  type        = string
  validation {
    condition     = can(regex("^\\d{12}$", var.command_account_id))
    error_message = "command_account_id must be a 12-digit account ID."
  }
}

variable "command_profile" {
  description = "Administrator profile of command_account_id."
  type        = string
}
