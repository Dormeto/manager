# Dormeto manager module

The Dormeto manager in your AWS account: the dashboard and API, organization discovery, the operations that install
routers and onboard workloads, sign-in with Cognito. Install, upgrade and uninstall: https://dormeto.com/get-started.html

```hcl
module "dormeto" {
  source          = "https://releases.dormeto.com/manager/<version>/terraform-aws-dormeto-<version>.zip//modules/manager"
  env             = "prod"
  organization_id = "o-exampleorgid"
  admin_emails    = ["you@example.com"]
}

output "dormeto" {
  value = module.dormeto.dashboard_url
}
```

The provider you configure sets the account and region. Outside any organization, leave `organization_id` out (null) and set `discovery_mode = "account"`: the manager then
assumes roles and accepts router events within its own account only (`dormeto install` deploys it this way). Optional
inputs: `discovery_mode` (the mode of the discovery perimeter's default configuration, the one an administrator has not
saved yet: `organization` by default, or `account`; `account` is required without `organization_id`), `domain` (a custom domain with its
certificate in us-east-1 and the Route 53 zone), `ses_identity` and `email_from` (Cognito sends the invitations through
your SES identity; without, it sends them itself, about 50 a day), `install` (`{ bucket, project, log_group }`: set by `dormeto install`; leave unset), `discovery_role_name` and `command_role_name` (the
roles the manager assumes in each account, `DmtDiscoveryRole` and `DmtCommandRole` by default), `create_organization_roles`
(false for a second environment in an account whose roles another one creates), `deletion_protection` (true: the users and the table are protected; set
it to false and apply before `terraform destroy`), `log_retention_days`, `mfa` (two-step verification with an
authenticator app: `optional`, `operators` by default — administrators and operators keep viewer rights until they set it
up from the Account page — or `required`), `alert_emails` (the addresses of the health alerts, each confirming the email
AWS sends; other channels subscribe to the `alerts_topic_arn` output), `ip_lists` (IP reputation lists the manager
downloads once for every router: `name`, `url`, `action` defer or ignore, `refresh_hours`; no secret in a URL, readable by
the organization).

A daily check for new manager versions runs from a function of its own (`<name>-update-check`, scheduled at 07:00 UTC); it does
nothing until an administrator turns it on in the Update page, and may publish to the alert topic then. A failed run raises the `update-check-errors` alarm.

To uninstall: offboard the workloads and uninstall the routers from the manager, turn event-driven refresh off and let a
discovery run disconnect the accounts (Run now), then set `deletion_protection = false`, apply, and `terraform destroy`.

The module carries the release's built artifacts (`artifacts/`): nothing is fetched at plan or apply time. The member
accounts get their roles from the `dormeto-access` module or the AWS CLI procedure of the same release
(https://dormeto.com/organization-access.html).
