# Changelog

Versions of the Dormeto manager, each with the router version it installs. Releases:
https://releases.dormeto.com/manager/ (install: https://dormeto.com/get-started.html). An **Access** line says when the
member accounts' roles or the delegation policy must be applied again (the access and organization modules, or the AWS
CLI script, of the same release).

## 0.3.1 — 2026-10-07

Router 0.23.2. Access: apply the access module or the AWS CLI script of this release again in every member account (the
routers' permissions boundary allows reading the account's Cognito user pool clients, which ELB requires to change a rule
that authenticates with Amazon Cognito).

- A workload behind a rule that authenticates with Amazon Cognito can be onboarded, napped and woken: upgrade its router
  to 0.23.2. Until the access module or script is applied again in its account, onboarding there says so.
- A shadow rule covers its rule whatever the order AWS lists their conditions in: onboarding no longer fails at its check
  for a rule with several conditions, and the idle check no longer rewrites such a shadow every 5 minutes.
- Routers shows the version an upgrade installed at once (not at the router's next check).
- Routers: the upgrade is an icon beside the router's version, animated while an upgrade runs; upgrade, uninstall, pause
  and resume explain themselves in a tooltip (uninstall asks first); a count of workloads opens that workload, or the
  list of those workloads.
- Discovery: an onboarding or offboarding running on a candidate shows in its status, and Onboard or Offboard waits for
  it.
- Routers and Discovery say what they started, and how an upgrade, onboarding or offboarding ended, in a toast linking to
  its steps in Operations.
- Discovery shows only the statuses that have candidates.
- Organization access says its status with an icon, the counts and event-driven refresh explained in its tooltip; the
  panel lists only what needs attention.

## 0.3.0 — 2026-10-06

Router 0.23.0. Access: apply the access module or the AWS CLI script of this release again in every member account (the
discovery role reads CloudTrail trails and its own role's tags; the command role passes the forwarder's role to
EventBridge).

- Accounts set up for discovery only (the access module with `create_command_role = false`, or the AWS CLI script
  without a command role) say so on their discovery role: the manager counts them apart instead of listing them as
  missing the command role, and refuses onboarding there with that reason.
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
