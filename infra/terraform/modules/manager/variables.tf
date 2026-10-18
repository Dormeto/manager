# The Dormeto manager (vision docs/specs/2026-10-06-packaging-design.md, section 4): what a customer installs in their
# account, pinned to a release. The caller configures the AWS provider (account, region, default tags) and the state.

variable "env" {
  description = "Environment name: resource names dmt-<env>-manager-*."
  type        = string
  validation {
    # Installed routers are dmtr-<env>; their waker target groups dmtr-<env>-<16-character workload id> hold in 32.
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,8}[a-z0-9])?$", var.env))
    error_message = "env must have 1 to 10 lowercase letters, digits or inner hyphens (installed routers dmtr-<env>, waker target groups dmtr-<env>-<workload id>)."
  }
}

variable "artifacts_dir" {
  description = "The release's built artifacts (manifest.json, lambda/, dashboard/, router/). Null: artifacts/ beside this module, as the release archive has them."
  type        = string
  default     = null
}

variable "organization_id" {
  description = "AWS organization of the discovery perimeter: the manager assumes roles, and accepts router events, within it only. Null: the manager is outside any organization and works within its own account only (account deployment)."
  type        = string
  default     = null
  validation {
    condition     = var.organization_id == null || can(regex("^o-[a-z0-9]{10,32}$", var.organization_id))
    error_message = "organization_id must look like o-xxxxxxxxxx."
  }
}

variable "discovery_mode" {
  description = "The mode of the discovery perimeter's default configuration (the one an administrator has not saved yet): organization (the accounts of the organization) or account (the manager's own account). Account is required without an organization_id."
  type        = string
  default     = "organization"
  validation {
    condition     = contains(["organization", "account"], var.discovery_mode)
    error_message = "discovery_mode must be organization or account."
  }
  validation {
    condition     = var.organization_id != null || var.discovery_mode == "account"
    error_message = "Without organization_id, discovery_mode must be account (organization mode needs an organization_id)."
  }
}

variable "admin_emails" {
  description = "First administrators, invited by email."
  type        = list(string)
  default     = []
}

variable "history_days" {
  description = "How long each workload's state history is kept (R8: the timeline of the workload view, and the base of the savings): from 7 days to 10 years. A change applies to transitions written afterwards."
  type        = number
  default     = 400
  validation {
    condition     = var.history_days >= 7 && var.history_days <= 3650 && floor(var.history_days) == var.history_days
    error_message = "history_days must be a whole number of days from 7 to 3650."
  }
}

variable "states_cache_minutes" {
  description = "How long the API keeps each workload's figures (its time in each state over 7 days, its savings over 30 days) for the bar of all workloads in the Workloads view: from 1 minute to a day. Each refresh reads every workload's history."
  type        = number
  default     = 60
  validation {
    condition     = var.states_cache_minutes >= 1 && var.states_cache_minutes <= 1440 && floor(var.states_cache_minutes) == var.states_cache_minutes
    error_message = "states_cache_minutes must be a whole number of minutes from 1 to 1440."
  }
}

variable "savings_baseline" {
  description = "What the savings are counted against (R9): always (the workloads would run 24/7) or business-hours (weekdays 08:00 to 20:00 in savings_timezone)."
  type        = string
  default     = "always"
  validation {
    condition     = contains(["always", "business-hours"], var.savings_baseline)
    error_message = "savings_baseline must be always or business-hours."
  }
}

variable "savings_timezone" {
  description = "The time zone of the business-hours baseline (an IANA name, for example Europe/Paris). A name the runtime does not know is UTC, with a warning in the logs."
  type        = string
  default     = "UTC"
  validation {
    condition     = can(regex("^(UTC|[A-Za-z]+(/[A-Za-z0-9_+-]+)+)$", var.savings_timezone))
    error_message = "savings_timezone must be an IANA time zone, for example Europe/Paris, or UTC."
  }
}

variable "alert_emails" {
  description = "Addresses the health alerts are sent to (router alarms, the watchdog's own failures), each subscribed to the alert topic and pending until its owner confirms the email AWS sends. Other subscriptions: the alerts_topic_arn output."
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for e in var.alert_emails : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", e))])
    error_message = "alert_emails must be email addresses."
  }
}

variable "ip_lists" {
  description = "IP reputation lists the manager downloads once for every router (R6b), hourly at each list's refresh_hours, and its routers use for every workload: name, url (http(s), or s3://bucket/key read with the S3 API), action (defer: a listed source wakes only through the waiter page's probe; ignore: never wakes), refresh_hours. A version that lost more than half its entries is refused; to accept such a shrink, change the list's URL (a new URL is never compared with the old one's version). The URLs are readable by the organization (catalog.json) and shown to every dashboard user: never put a secret in one. Empty: none."
  type = list(object({
    name          = string
    url           = string
    action        = optional(string, "defer")
    refresh_hours = optional(number, 24)
  }))
  default = []
  validation {
    condition     = alltrue([for l in var.ip_lists : can(regex("^[A-Za-z0-9._-]{1,64}$", l.name))]) && length(distinct([for l in var.ip_lists : l.name])) == length(var.ip_lists)
    error_message = "ip_lists names must be unique, 1-64 characters among letters, digits, '.', '_' and '-'."
  }
  validation {
    condition     = alltrue([for l in var.ip_lists : can(regex("^(https?://|s3://[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]/.+)", l.url)) && contains(["defer", "ignore"], l.action) && l.refresh_hours >= 1])
    error_message = "Each ip_lists entry needs an http(s) url or an s3://bucket/key URI, action defer or ignore, and refresh_hours of at least 1."
  }
}

variable "mfa" {
  description = "The MFA policy (two-step verification with an authenticator app, set up from the dashboard's Account page): optional (any user may turn it on); operators (administrators and operators must use it, viewer rights until they do); required (everyone: managed login asks for it at sign-in, the API refuses without it)."
  type        = string
  default     = "operators"
  validation {
    condition     = contains(["optional", "operators", "required"], var.mfa)
    error_message = "mfa must be optional, operators or required."
  }
}

variable "domain" {
  description = "A custom domain: the dashboard host, the sign-in host under it (auth.<dashboard>), their certificate in us-east-1 (both names), and optionally the Route 53 zone where the records are created. Null: CloudFront's and Cognito's own domains."
  type = object({
    dashboard       = string
    auth            = string
    certificate_arn = string
    zone_id         = optional(string)
  })
  default = null
}

variable "ses_identity" {
  description = "A verified SES identity (domain or address) of this account and region, through which Cognito sends the invitations. Null: Cognito sends them itself (about 50 a day)."
  type        = string
  default     = null
}

variable "install" {
  description = "Set by `dormeto install`; leave unset. The CLI's install bucket, build project and its log group: the API then updates the manager from its dashboard (requests, results, builds, logs)."
  type = object({
    bucket    = string
    project   = string
    log_group = string
  })
  default = null
  validation {
    condition = var.install == null ? true : (
      can(regex("^dmt-install-[0-9]{12}-[a-z0-9-]+$", var.install.bucket)) &&
      can(regex("^dmt-[a-z0-9-]+-install$", var.install.project)) &&
      var.install.log_group == "/aws/codebuild/${var.install.project}"
    )
    error_message = "install.bucket must be dmt-install-<account>-<region>, install.project dmt-<env>-install and install.log_group /aws/codebuild/<project>."
  }
}

variable "email_from" {
  description = "Sender of the invitations with ses_identity, for example \"Dormeto <no-reply@example.com>\" (required with a domain identity)."
  type        = string
  default     = null
}

variable "deletion_protection" {
  description = "Protect the user pool (the users) and the table (installed routers, operations, audit) from a mistaken destroy. Set to false and apply before terraform destroy (uninstall)."
  type        = bool
  default     = true
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

variable "local_dev" {
  description = "Allow the local Vite server (http://localhost:5173) as a sign-in callback."
  type        = bool
  default     = false
}

variable "smoke_user" {
  description = "Create the smoke-test client and user (password in SSM): automated checks only."
  type        = bool
  default     = false
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "discovery_role_name" {
  description = "Read-only role the manager assumes in each account of the perimeter (module access); a path may precede the name."
  type        = string
  default     = "DmtDiscoveryRole"
}

variable "command_role_name" {
  description = "Role the manager assumes in each account to install routers and act on their rules (module access); a path may precede the name."
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

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_partition" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region
  partition  = data.aws_partition.current.partition
  name       = "dmt-${var.env}-manager"
  # The environments trusted by the organization roles created here: this one first.
  organization_role_envs = distinct(concat([var.env], var.organization_role_envs))
  # Routers (installed by the manager or written in Terraform) are named dmt-<env>.
  name_prefix = "dmt-${var.env}"
  # Routers written in Terraform, with their account (the manager's).
  routers = jsonencode([for r in var.routers : merge({ for k, v in r : k => v if v != null }, { account = local.account_id })])

  # Hosts: the custom domain, or CloudFront's and Cognito's own.
  custom_domain  = var.domain != null
  zone_id        = try(var.domain.zone_id, null)
  cognito_prefix = "${local.name}-${local.account_id}"
  dashboard_host = local.custom_domain ? var.domain.dashboard : aws_cloudfront_distribution.dashboard.domain_name
  auth_host      = local.custom_domain ? var.domain.auth : "${local.cognito_prefix}.auth.${local.region}.amazoncognito.com"
  # Known at plan: never CloudFront's host, unknown until the distribution exists (the provider fails on an unknown
  # Cognito attribute map). Never sent mail (SUPPRESS).
  smoke_username = "smoke@${local.custom_domain ? var.domain.dashboard : "${local.name}.invalid"}"

  # The release's artifacts (scripts/release/artifacts.mjs), checked by terraform_data.artifacts.
  artifacts_dir = coalesce(var.artifacts_dir, "${path.module}/artifacts")
  artifact = {
    manifest     = "${local.artifacts_dir}/manifest.json"
    api          = "${local.artifacts_dir}/lambda/api.zip"
    discovery    = "${local.artifacts_dir}/lambda/discovery.zip"
    operations   = "${local.artifacts_dir}/lambda/operations.zip"
    access_check = "${local.artifacts_dir}/lambda/access-check.zip"
    fleet        = "${local.artifacts_dir}/lambda/fleet.zip"
    watchdog     = "${local.artifacts_dir}/lambda/watchdog.zip"
    savings      = "${local.artifacts_dir}/lambda/savings.zip"
    dashboard    = "${local.artifacts_dir}/dashboard/index.html"
    router       = "${local.artifacts_dir}/router/router.zip"
    blueprint    = "${local.artifacts_dir}/router/blueprint.json"
    boundary     = "${local.artifacts_dir}/router/router-boundary.json"
  }
  missing_artifacts = [for file in values(local.artifact) : file if !fileexists(file)]
  missing_message   = "Missing release artifacts: ${join(", ", local.missing_artifacts)}. Build them (npm run build, then npm run artifacts) or use a complete release."
  manifest          = try(jsondecode(file(local.artifact.manifest)), { version = "missing", router = "missing" })
  version           = local.manifest.version
  router_version    = local.manifest.router
}

# Every reader of the artifacts waits for this check: a missing one fails the plan here, once, naming every missing file,
# rather than leaving the dashboard empty or a function without code.
resource "terraform_data" "artifacts" {
  input = local.artifact

  lifecycle {
    precondition {
      condition     = length(local.missing_artifacts) == 0
      error_message = local.missing_message
    }
  }
}
