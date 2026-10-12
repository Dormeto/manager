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
| `scripts` | `smoke.mjs` (API checks as the smoke user), `screenshots.mjs` (signed-in dashboard screenshots), `release/` (the module's artifacts from the builds, a release and its publication) |

The manager never reads the router tables or the workload resources itself: each router controller answers the `list`,
`status`, `force-wake`, `nap` and `discover` actions (router ≥ 0.11.0).

## Environments

| Environment | Dashboard | Sign-in | Routers |
|---|---|---|---|
| `dev` | `https://app.dev.dormeto.com` | `https://auth.app.dev.dormeto.com` | `dmt-dev` |

Roles come from the Cognito groups: `dmt-viewer` (read), `dmt-operator` (nap, wake), `dmt-admin` (users, audit).
Users are invited by administrators; the first administrators are listed in `env/<env>.local.tfvars` (not committed).

## Install

Customers install a release with the manager module (https://dormeto.com/get-started.html):

```hcl
module "dormeto" {
  source          = "https://releases.dormeto.com/manager/0.4.0/terraform-aws-dormeto-0.4.0.zip//modules/manager"
  env             = "prod"
  organization_id = "o-exampleorgid"
  admin_emails    = ["you@example.com"]
}
```

The module's inputs: `infra/terraform/modules/manager/README.md`. Dev runs the same module from the local build
(`infra/terraform/platform`).

## Release

A release is built from a commit whose `package.json` names the new version (and `dormeto.router` the router it
carries, built in the sibling repository), with its section in `CHANGELOG.md`:

```bash
(cd ../router && npm run package)
AWS_PROFILE=kloudy-dormeto-prd node scripts/release/release.mjs --publish --bucket dmt-releases-121014831971
```

It builds, assembles `dist/release/<version>/` (the module archive with its artifacts, the access and organization
modules, the AWS CLI script, the organization policy, `SHA256SUMS`, the changelog section), refuses a version already
published, uploads it to `releases.dormeto.com/manager/<version>/`, moves `latest.json` forward and tags `v<version>`
(pushed with the commits). Then update the website's pages to the new version.

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

Screenshots of the dashboard (the website's, for example), signed in as the smoke user, with example values in place of
real identifiers (account ids, email addresses, organization ids, and the names listed in a mask file kept outside the
repository: `{ "replacements": [["real name", "Example"]] }`); an image where one remains is not written:

```bash
node scripts/screenshots.mjs --env dev --width 1280 --height 800 --scale 2 --format webp --theme dark \
  --mask ~/dormeto-mask.json --out /tmp/shots --route / --route /discovery
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

## Health alerts, IP lists and MFA (R6)

- **Health alerts:** the watchdog (`dmt-<env>-manager-watchdog`, every 5 minutes, a second bundle of the API package)
  compares the routers the manager knows with what they report: a router silent for 3 periods of its schedule, or
  reporting problems (stable codes from router 0.24.0, its texts before), opens an alarm item (`ALARM#<subject>`); each
  opening, raise or resolution is published to `dmt-<env>-manager-alerts` (6-hour damping, 10 messages and a digest per
  run). `alert_emails` subscribes addresses; the Overview lists the open alarms (`GET /api/alerts`). CloudWatch alarms
  watch the watchdog (errors, silence), the router events' dead-letter queue and the list function.
- **IP lists:** `ip_lists` is written as `catalog.json` in `dmt-<env>-manager-ip-lists-<account>`; the list function
  (`dmt-<env>-manager-ip-lists`, the router bundle's `lists.handler`, hourly) publishes each list's data and manifest and
  `status.json`. Routers 0.24.0 read them (installed routers get the catalog in their blueprint, routers written in
  Terraform `ip_lists_catalog`); the Routers view shows them (`GET /api/ip-lists`), the watchdog alarms on a list that
  failed or grew old.
- **MFA:** `mfa` sets the user pool's MFA (`ON` only for `required`) and the API's policy (`MFA_MODE`): the API reads each
  user's MFA with `AdminGetUser` (cached 5 minutes when on, 30 seconds when off, `/api/me?fresh=1`), and lowers an
  administrator or operator without it to viewer under `operators`. The Account page sets up TOTP with the user's access
  token; Users resets another user's. The smoke user is enrolled by `scripts/smoke.mjs` at its first run (secret in SSM
  `/dmt-<env>/manager/smoke-totp`). No client may write a user's email (with the scope the Account page needs, a stolen
  access token could otherwise move the account to another address).
- **Lost authenticator:** another administrator resets it from Users (keep at least two administrators with one). The
  last administrator, with AWS credentials of the manager's account:
  `aws cognito-idp admin-set-user-mfa-preference --user-pool-id <user_pool_id> --username <email>
  --software-token-mfa-settings Enabled=false,PreferredMfa=false`, and under `required` also
  `aws cognito-idp admin-delete-software-token --user-pool-id <user_pool_id> --username <email>` (a recent AWS CLI); they
  set up a new one at their next sign-in.

## Failed wakes (R7)

- **Failure index:** the fleet ingestion writes `WF#<account>#<region>#<workloadId>` from a `FAILED` state change (the
  router's `failure` from 0.25.0: kind, step, backend, AWS's message; "no reason" before) or from a check summary that has
  a failure the index lacks; a successful wake (an `AWAKE` change or a summary without failure) deletes it, and so does
  the workload leaving its router. Nothing is written while workloads wake well.
- **Alerts:** the watchdog makes each entry an alarm subject (`workload#<account>#<region>#<workloadId>`, problem
  `wake-failed:<kind>`): one alert per kind across retries, "woke again" when the entry leaves; failing again more than
  15 minutes after waking is a new alert (routers and lists are damped 6 hours). Each message is published
  with `MessageStructure: json`: the text for `email` (and `default`), an Amazon Q Developer custom notification for
  `https` subscriptions, and the attributes `level`, `kind` (`router`, `list`, `workload`, `digest`), `account`,
  `region`, `router` and `workload` for subscription filter policies (for example `{"kind": ["workload"], "account":
  ["123456789012"]}` for one team's channel).
- **Chat:** an Amazon Q Developer in chat applications channel (Slack or Microsoft Teams) subscribed to
  `dmt-<env>-manager-alerts` (Terraform `aws_chatbot_slack_channel_configuration` or
  `aws_chatbot_teams_channel_configuration` with `sns_topic_arns`, or the console) receives the chat body.
- **Dashboard and API:** the workload view shows the last failure, the failures in a row, the next attempt and the
  fallback instance types in use; the state chip's tooltip the last failure; the Alerts card links to the workload.
  Onboarding takes `fallbackInstanceTypes` (at most 5) and `failedRetrySeconds` (10 to 600), checked by the API.
- **Access:** fallback instance types need `ec2:ModifyInstanceAttribute` in DmtRouterBoundary (router 0.25.0's
  `router-boundary.json`): apply the access module or the AWS CLI script of 0.5.0 again in every member account.

## State history (R8)

- **Store:** each `Workload state changed` event is kept as `HIST#<account>#<region>#<workloadId>` / `<at>#<to>` (a
  duplicate is the same item), with its cause, wake id and duration, failure and who asked it from the manager; the
  table's TTL removes it `history_days` (default 400) after it. A check whose state differs from the stored summary's
  writes an inferred transition dated by the router's `stateAt` (0.26.0: the event's instant, so the late event replaces
  it), else the check's time; a workload's first entry is written when the manager first sees it (`historySince`).
  Nothing is written for a check that changes nothing.
- **API and dashboard:** `GET /api/workloads/{router}/{id}/history?days=1..31` answers the period's entries, phases,
  time per state and wakes (at most 5,000 entries, then `truncated`); the workload view's History card draws them.

## Savings (R9, R9.5)

- **What is priced:** what each nap stopped, as router 0.27.0 says in its `ASLEEP` event (`stopped`, kept in the
  history): EC2 instances and Auto Scaling capacity by type and OS, Fargate tasks by size, RDS and Aurora instances by
  class, engine and deployment, Aurora Serverless v2 at its minimum capacity. Prices: the Price List API's on-demand list
  prices (`pricing:GetProducts`, us-east-1), cached as `PRICE#<region>#<item>` for 30 days (a missing one for a day)
  and an hour in each function's memory. A price is asked again at the first lookup after it expires; a day already
  computed keeps the prices it was computed with. To take a price change at once, delete its `PRICE#` items
  (`pk = T#default`) and run the job again for the days to price again.
- **Spot (R9.5):** routers 0.28.0 say what ran on Spot (`spot: true`: an instance's Spot lifecycle, a Fargate service's
  share on `FARGATE_SPOT` from its capacity provider strategy). EC2 Spot is priced from `DescribeSpotPriceHistory` in
  the item's region (the latest price of each zone averaged; cached a day as `PRICE#<region>#ec2-spot#<type>#<os>`); a
  region the manager's account has not enabled is not priced. Fargate Spot, which no AWS API prices, at 30% of
  on-demand (AWS's largest announced discount: the smallest saving).
- **Discounts (R9.5):** administrators set, on the Overview's Savings card, what Savings Plans, Reserved Instances or an
  AWS agreement take off the list prices: `compute` (EC2, Fargate) and `databases` (RDS, Aurora), whole percentages
  from 0 to 90, never off Spot (`PUT /api/savings/settings`, audited `savings-discounts`; item `T#default` /
  `SAVINGS#SETTINGS`). An average rate: a nap saves the list price of what goes beyond a commitment and nothing within.
  The job reads them once per run (a day computed keeps them; the summary records those of its latest day), the API at
  most once a minute.
- **Estimates, not bills:** AWS bills are not read (a bill cannot show what a nap did not spend, and comes a day late).
- **Baseline:** `savings_baseline` = `always` (24/7) or `business-hours` (weekdays 08:00 to 20:00 in `savings_timezone`).
- **The 7-day bar:** a Workloads row and a workload's header read the workload's last 30 days of history (its time in
  each state over 7 days, what its naps saved, its last nap priced), kept 5 minutes while its state stays the same. The
  bar of all workloads (`GET /api/workloads/states`) adds up each workload's figures kept `states_cache_minutes` (60 by
  default) whatever its state: a refresh reads every workload's history, 20 at a time.
- **Daily job:** `dmt-<env>-manager-savings` (00:30 UTC; run it by hand with `{"day": "YYYY-MM-DD"}`) puts each
  workload's day as `SAV#<date>` / `<account>#<region>#<workloadId>` (kept `history_days`) and the summary
  (`T#default` / `SAVINGS`): the last 30 days, this month, the cumulative total (each day added once), the top workloads,
  the workloads not priced, Dormeto's estimated cost. `GET /api/savings` answers it; a workload's history adds its
  period's `savings`.

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

Each release also publishes `dormeto-access-commands-<version>.sh`, the same with the AWS CLI (settings at its top;
`scripts/release/access-script.mjs`). Each discovery run checks both roles in every account (the command role through the access check function
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
