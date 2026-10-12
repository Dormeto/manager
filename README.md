# Dormeto manager

Management plane of **Dormeto** ("nap" in Esperanto), which puts idle web workloads to sleep and wakes them
just-in-time. The MVP operates the routers already deployed: dashboard and API with the workloads, their live status,
nap and wake, and the discovery of the load balancer rules that Dormeto could manage.

- Design: [Dormeto/vision · docs/specs/2026-10-04-manager-mvp-design.md](https://github.com/Dormeto/vision/blob/main/docs/specs/2026-10-04-manager-mvp-design.md)
- Target architecture: [Dormeto/vision · docs/architecture/manager.md](https://github.com/Dormeto/vision/blob/main/docs/architecture/manager.md)

| Path | Content |
|---|---|
| `packages/api` | API Lambda (TypeScript, HTTP API payload 2.0): identity and roles, routers, workloads, actions, discovery, users, audit |
| `packages/dashboard` | Vue 3 + Vuetify 4 single-page application, sign-in with the Cognito managed login (PKCE) |
| `infra/terraform/platform` | DynamoDB, API Lambda, HTTP API + JWT authorizer, Cognito, CloudFront + S3, ACM, Route 53 |
| `scripts` | `smoke.mjs` (API checks as the smoke user), `screenshots.mjs` (signed-in dashboard screenshots) |

The manager never reads the router tables or the workload resources itself: each router controller answers the `list`,
`status`, `force-wake`, `nap` and `discover` actions (router ≥ 0.11.0).

## Environments

| Environment | Dashboard | Sign-in | Routers |
|---|---|---|---|
| `dev` | `https://app.dev.dormeto.com` | `https://auth.app.dev.dormeto.com` | `dmt-dev` |

Roles come from the Cognito groups: `dmt-viewer` (read), `dmt-operator` (nap, wake), `dmt-admin` (users, audit).
Users are invited by administrators; the first administrators are listed in `env/<env>.local.tfvars` (not committed).

## Usage

Requirements: Node.js ≥ 24, Terraform 1.16.5 (tfenv reads `.terraform-version`), AWS CLI v2, profile
`kloudy-dormeto-prd`.

```bash
npm install
npm test && npm run typecheck
npm run build                                   # API, discovery and operations bundles, dashboard (published by Terraform)
(cd ../router && npm run package)               # the router bundle the manager installs (sibling repository)
cd infra/terraform/platform
echo 'admin_emails = ["you@example.com"]' > env/dev.local.tfvars
tfenv exec init -backend-config=env/dev.backend.hcl
tfenv exec apply -var-file=env/dev.tfvars -var-file=env/dev.local.tfvars
cd ../../.. && node scripts/smoke.mjs --env dev  # API checks as the smoke user
npm run dev -w @dormeto/manager-dashboard       # local dashboard on http://localhost:5173 against the dev API
```

While SES is in the sandbox, an invited address must be a verified SES identity: inviting from the dashboard creates
the identity (AWS sends a verification email), and the administrator resends the invitation once it is verified.

## Operations (onboarding)

Operators onboard a discovered candidate, giving it a name for people (the target group name by default, renamed from
the workload view; the router derives the workload id from the target group), and offboard a workload; administrators
install, upgrade and uninstall routers
(Discovery, workload and Routers views, `POST /api/operations`). Each operation runs in the Step Functions state machine
`dmt-<env>-manager-operations`, one step at a time in the operations Lambda, and is listed in the Operations view with
its steps. Routers are installed by AWS API calls from the router blueprint of the manager's router version (artifacts
bucket), through `DmtCommandRole` in the target account: installed routers live in their own namespace (`dmtr-<env>`,
roles under `/dormeto/router/`), and the role may only create roles there carrying the permissions boundary
`DmtRouterBoundary`, and change or delete only `dmtr-*` resources, never a router written in Terraform nor the manager. In the manager's account both are created by `infra/terraform/modules/command-role`; one operation at a
time per target group, router or workload, one per load balancer (lock), three per account and region.

## Organization access (discovery)

Discovery reads the AWS organization from the manager account and scans each account of its perimeter through a
read-only role, `DmtDiscoveryRole` (template `infra/org/discovery-role.yaml`). The organization management account
grants this once (vision `docs/architecture/organization-iam.md`):

```bash
cd infra/terraform/org                         # acts in the management account (profile kloudy-master)
tfenv exec init -backend-config=env/dev.backend.hcl
tfenv exec plan -var-file=env/dev.tfvars -out=dev.tfplan
tfenv exec apply dev.tfplan                    # delegation policy, StackSet dmt-discovery and its instances
```

Only the accounts of `discovery_accounts` get the role, so discovery can never read any other account of the
organization.

The same stack creates `DmtCommandRole` and `DmtRouterBoundary` in `command_account_id` (dev: 038606077307), by API
calls through that account's administrator profile `command_profile` (an account invited into the organization has no
`OrganizationAccountAccessRole`): only the manager's operations role may assume it, to install routers there. Apply it
again after a router version that changes `dist/router-boundary.json`.
