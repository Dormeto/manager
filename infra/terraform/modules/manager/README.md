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

The provider you configure sets the account and region. Optional inputs: `domain` (a custom domain with its
certificate in us-east-1 and the Route 53 zone), `ses_identity` and `email_from` (Cognito sends the invitations through
your SES identity; without, it sends them itself, about 50 a day), `discovery_role_name` and `command_role_name` (the
roles the manager assumes in each account, `DmtDiscoveryRole` and `DmtCommandRole` by default), `create_organization_roles`
(false for a second environment in an account whose roles another one creates), `deletion_protection` (true: set it to
false and apply before `terraform destroy`), `log_retention_days`.

The module carries the release's built artifacts (`artifacts/`): nothing is fetched at plan or apply time. The member
accounts get their roles from the `dormeto-access` module or the AWS CLI procedure of the same release
(https://dormeto.com/organization-access.html).
