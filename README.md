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
| `infra/terraform/modules/manager` | The manager module (what a release installs): DynamoDB, the Lambdas, HTTP API + JWT authorizer, Step Functions, EventBridge, Cognito, CloudFront + S3, optional custom domain and SES |
| `infra/terraform/modules/access`, `organization` | The organization roles of an account, the delegation policy of the management account |
| `infra/terraform/platform` | Dev: the manager module with the local build, its certificate and DNS |
| `scripts` | `smoke.mjs` (API checks as the smoke user), `screenshots.mjs` (signed-in dashboard screenshots), `release/artifacts.mjs` (the module's artifacts from the builds) |

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
npm run artifacts                               # dist/artifacts: the module's layout, as a release carries it
cd infra/terraform/platform
echo 'admin_emails = ["you@example.com"]' > env/dev.local.tfvars
tfenv exec init -backend-config=env/dev.backend.hcl
tfenv exec plan -var-file=env/dev.tfvars -var-file=env/dev.local.tfvars -out=dev.tfplan
tfenv exec apply dev.tfplan
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
`DmtRouterBoundary`, and change or delete only `dmtr-*` resources, never a router written in Terraform nor the manager. In the manager's account both are created by the `access` module (see below); one operation at a
time per target group, router or workload, one per load balancer (lock), three per account and region.

## Organization access (discovery)

Discovery reads the AWS organization from the manager account and scans each account of its perimeter through a
read-only role, `DmtDiscoveryRole`; operations act through `DmtCommandRole` (vision
`docs/architecture/organization-iam.md`). Dormeto never deploys these roles (no CloudFormation): they are created with the
Terraform modules of `infra/terraform/modules`, published with each release, and the manager supposes them there:

- `access`, in each member account: `DmtDiscoveryRole`, `DmtCommandRole` and `DmtRouterBoundary`, trusted by the manager
  roles of every environment listed in `envs` (several environments may share an account's roles). In the manager's own
  account the platform stack creates them (`create_organization_roles`); a second environment of that account sets it to
  `false` and is listed in the first one's `organization_role_envs`.
- `organization`, in the management account: the Organizations delegation policy.

`node scripts/access-cli.mjs --account <id> --manager-account <id> --env <env>[,<env>…]` prints the same as AWS CLI
commands. Each discovery run checks both roles in every account (the command role through the access check function
`dmt-<env>-manager-access-check`, which only assumes it) and the Discovery view's Organization access panel lists what is
missing: onboarding and router installs are refused where the command role is missing.

Dev: the org stack applies `organization` in the management account and `access` in `command_account_id`
(038606077307), through that account's administrator profile `command_profile` (an account invited into the
organization has no `OrganizationAccountAccessRole`):

```bash
cd infra/terraform/org                         # acts in the management account (kloudy-master) and command_account_id
tfenv exec init -backend-config=env/dev.backend.hcl
tfenv exec plan -var-file=env/dev.tfvars -out=dev.tfplan
tfenv exec apply dev.tfplan
```

Apply it again after a router version that changes `dist/router-boundary.json`. The modules' tests run offline with a
mocked provider: `cd infra/terraform/modules/<module> && tfenv exec init -backend=false && tfenv exec test`.
