# Changelog

Versions of the Dormeto manager, each with the router version it installs. Releases:
https://releases.dormeto.com/manager/ (install: https://dormeto.com/get-started.html). An **Access** line says when the
member accounts' roles or the delegation policy must be applied again (the access and organization modules, or the AWS
CLI script, of the same release).

## Unreleased

Router 0.23.0. Access: apply the access module or the AWS CLI script of this release again in every member account (the
discovery role reads CloudTrail trails; the command role passes the forwarder's role to EventBridge).

- Event-driven discovery refresh (off by default, Perimeter settings): the manager connects the ready accounts with a
  CloudTrail trail (a forwarder: a role and a rule per region, by API calls through the command role); their load
  balancer changes appear within about 5 minutes; turned off, the forwarders are removed. Before uninstalling, turn it off
  and let a run disconnect the accounts.

## 0.2.2 — 2026-10-06

Router 0.22.6. Access: nothing to apply again.

- Without an SES identity, invitations from the dashboard go out at once through Cognito (no SES identity created, no
  SES permission).
- `deletion_protection` protects the table (installed routers, operations, audit) as well as the users.
- The functions' code ships zipped in the release: nothing is written in your configuration at plan time, so a plan
  applied in another job or by HCP Terraform works.
- The organization module keeps the organization's other statements of its one delegation policy
  (`additional_statements`); the website's procedure merges with the current policy and removes Dormeto's statement only.

## 0.2.1 — 2026-10-06

Router 0.22.6.

- An install without a custom domain and with `smoke_user` no longer fails at apply (the smoke user is named
  `smoke@dmt-<env>-manager.invalid`, known at plan).

## 0.2.0 — 2026-10-06

Router 0.22.6.

- Installed with a Terraform module from a release (`terraform-aws-dormeto-<version>.zip//modules/manager`), carrying
  the manager's built code and the router it installs; optional custom domain and SES identity (without, Cognito sends
  the invitations); `deletion_protection` for the users.
- Organization access without CloudFormation: the `dormeto-access` and `dormeto-organization` modules or the AWS CLI
  script of the release, shared by several environments; both roles checked at each discovery run, the Organization
  access panel, onboarding and router installs refused where the command role is missing.
- Scale to 1,000 accounts: routers push their state, discovery fanned out by account, bulk onboarding.
- Onboarding, offboarding and router installation by API calls; router management (health, pause, exclusions);
  organization discovery with filters and multi-rule workloads.

## 0.1.0 — 2026-10-04

- First version: dashboard and API on the routers written in Terraform, nap and wake, discovery of the load balancer
  rules Dormeto could manage.
