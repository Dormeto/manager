# Operations, alerts and history

How the manager onboards workloads and operates routers, alerts on routers, IP lists and failed wakes, and keeps each workload's state history.

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

## Standalone workloads

A standalone workload (AWS here, Google Cloud [below](#on-google-cloud)) is one resource that no load balancer rule uses: an EC2 instance outside an Auto Scaling
group, an Auto Scaling group with no target group, an ECS service with no load balancer, an RDS instance or an Aurora
cluster. Its router naps it when its idle signals stay under their thresholds for its idle window, or by its schedule;
nothing wakes it on demand (a schedule, a person's Wake, or a start made in AWS that the router sees). Discovery lists them
once the perimeter's `standalone` is `on`; each is a candidate of its own resource (`kind: "standalone"`, its ARN as `id`).

- **Onboarding** (`POST /api/operations`, `type: "onboard"`, the resource's ARN as `candidateId`) runs an HTTP
  candidate's steps, its router installed first where the region has none; `lock load balancer` is skipped (there is
  none), and one operation at a time holds the resource (`RES#<arn>`, a second one is a conflict naming it): the
  router's onboarder is asked with `resourceArn`, its preview has the last word on eligibility, and `verify` waits for the
  workload awake with its resource among its backends. A waker's setting (`waitSeconds`, `drainSeconds`, `maxHolders`,
  `failedRetrySeconds`, `wakeMode`, `noWakeRules`, `wakeRules`) is refused before the operation; a router that does not know
  standalone workloads fails the preview, asking to be upgraded.
- **Offboarding** is an HTTP workload's: it wakes the workload, offboards it and gives its candidate back. A workload whose
  resource is missing (`resourceMissing`) cannot be woken: `pause` and `wait awake` are skipped, and the router offboards it
  in any state, skipping what is gone.
- **Verification** waits for the resource among the workload's backends, a poll each 15 s for 3 minutes (the tagging API
  lists an ECS service's new tag late); after that the operation fails, saying the workload is onboarded and where to see it.
- **Turning the perimeter's standalone scan off** makes the managed standalone workloads To offboard, as a workload that
  leaves the perimeter does.
- **Its settings** are `idleMinutes`, `wakeTimeoutSeconds` and the three idle signals (`idleCpuPercent`, `idleNetworkBytes`,
  `idleMetric`, each a value or `off`), at every AWS level ([Access control](access-control.md)); the router checks them.
- **What it refuses:** a waiting page, a target group exclusion naming it (409), and a nap window's `wake` (400, the router's words).
  A resource deleted or untagged sets `resourceMissing` and the router's `resource-missing` warning, which alerts: offboard it,
  or tag the resource again (`dormeto:workload` with the workload's id) and the router finds it at its next check.
- **Its history** names who started or stopped it: `schedule`, `manager` (a person), `idle`, `external-start` and
  `external-stop` (a start or stop made in AWS), `recovered`, and the check's `retry` of a failed wake. Its Activity history
  is in [Savings](savings.md#idle-window-advisor).

### On Google Cloud

A Google Cloud standalone workload is a Compute Engine VM outside a managed instance group, a managed instance group, or a
Cloud SQL instance, that no backend service uses. With the perimeter's `standalone` on, each project's scan lists them, each a
candidate of its path (`id` and `resource`, `cloud: "gcp"`), with the Google Cloud router's reasons; a VM or a group that backs
any backend service is never eligible (the router cannot see one it does not route).

- **Onboarding** takes the resource's path as `candidateId`, only from the last scan's eligible candidates. It goes to the
  router of the resource's region, else the project's only router; with several and none in that region, `router` names one
  (the dialog asks). The manager binds the tag `dormeto=managed` to the resource and its Cloud SQL companions, then the router
  records the workload; `verify` waits for it awake with its resource among its backends.
- **What marks the resource** is the tag `dormeto=managed`, which the router's roles require for every change but cannot
  read: the workload is missing (`resourceMissing`) only once Google says the resource is deleted. A tag binding removed
  shows as a permission failure naming the tag, kept on the workload until a nap or a wake succeeds.
- **Its settings** are AWS's five, at a Google Cloud router's and workload's levels, with `idleMetric` in Google Cloud's shape
  (`{ type, filter?, aligner, below }`, `${resource}` in the filter the resource's name); the organization's level and a type
  hold either cloud's metric, which a router of the other cloud ignores. A Cloud SQL instance's network is not a signal; the
  wake timeout is at most 1,700 s.
- **A Cloud SQL instance the router may not read** (a router installed without `--with cloud-sql`) is neither napped nor
  woken nor retried, and the router's health warns `cloud-sql-unreadable` with the count of such workloads: install it again
  with `--with cloud-sql`, or offboard the workload.

### A failed wake, on both clouds

A standalone workload's failed wake is retried by the router's check until it succeeds or a person naps the workload: its
page says when (`nextAttemptAt`), or that no retry is coming while a keepAsleep pause, a nap window, its unreadable settings or
resource, or a nap asked holds it. **Nap** is offered on a failed one: the router stops the retries at once and stops the
resource; its history says `manager` with who asked. A nap that fails leaves it failed with a nap's failure, tried again after
its idle window (`failed-released` in the history once it succeeds).

## Onboarding and offboarding on Google Cloud

The same operations, on the routers the CLI installed (0.40.0 or later; an older one is a 409 `router_too_old` with the
`dormeto gcp routers install` command), through the [connection](organization-access.md#google-cloud). The manager never
changes a Google IAM policy, a backend service, a URL map or a cluster: it calls the router, which changes the load
balancer, and binds and removes one resource tag, `dormeto/managed`, as the command account.

- **Onboarding** a candidate (a backend service a URL map names) runs `find router`, `slot` (the project's and the router's
  region), `lock load balancer` (the URL map), `preview`, `tag`, `onboard`, `verify` and `candidate`. The router is that of the
  candidate's region for a regional load balancer, the project's for a global one (`router` names it when the project has
  several). `preview` is the router's dry run, in AWS's onboarder payload (the URL map's and backend service's names, the
  load balancer's kind): it has the last word on eligibility, and it names the VMs and managed instance groups the router
  would stop and start. `tag` binds `dormeto/managed` to them and to the Cloud SQL instances given (`databases`), one per
  run of the step; one bound already is left alone. `verify` reads the router's status: the workload names the backend
  service, has no issue and isn't `FAILED`. The fallback machine types are Compute Engine's (at most 5, each once).
- **The router refuses, or the answer is lost:** a refusal (or a router the manager can't reach: the request never got to
  one that acted) removes exactly the bindings this operation made, never one that was there before, one per run of the
  step after the refusal's (a removal waits up to 60 s: no run outlasts the function); the operation says so. A binding
  that fails is followed the same way. A timeout, a 5xx or any lost answer removes none and names the bindings kept, because
  the router may have onboarded the workload; so does an operation the workflow fails outside a step (its function timed
  out or crashed). A step run again after a lost answer, which the router refuses as onboarded already, is done when its status
  shows the workload on the candidate's backend service; nothing is removed.
- **Offboarding** runs `locate` (the router's status), `slot`, `lock load balancer`, `pause`, `wait awake`, `offboard`
  (the router's, within 300 s), `untag` and `candidate`. `untag` removes the tag as the command account from the VMs and
  managed instance groups by the ids the onboarding stored, and from the Cloud SQL instances: one not tagged is said, a
  failure that passes (429, 5xx, no answer) is tried again, another fails the step naming what stays tagged. A VM or group
  an older onboarding stored no id for is named: its tag is removed by hand. A workload already gone from the router counts as
  offboarded.
- **What `locate` refuses,** before anything changes: a GKE workload and one whose onboarding turned request logs on (the router's
  `cli-only` words, with `dormeto gcp workloads offboard <id> --project <p> --region <r>`), a tag value or a Cloud SQL
  instance's region that can't be read (with the connect command). A VM or managed instance group workload the CLI onboarded
  offboards through the manager and loses its tag.
- **Exclusions:** an exclusion of a backend service (its path), a URL map or a project pauses its managed workloads through
  every router of the project, the next router when one has no such workload; its lift resumes them by the exclusion's id. A
  router's operator pause and an exclusion's are separate: lifting an exclusion leaves the operator's pause, and resuming
  the operator's leaves the exclusion's. A router below 0.40.0, or one that failed in the run, is not called; the errors are said
  for a workload no router paused.

## Google Cloud routers

A Google Cloud router (`dmtr-<project>-<region>` in the manager, `cloud: 'gcp'`, installed by the CLI) reports to the
manager's API (router 0.41.0), which puts its events on the manager's bus as an AWS router puts its own; nothing polls it.
The manager calls it only to act on it (through the [connection](organization-access.md#google-cloud)): `POST
<controller>/v1/actions` with the command account's ID token for the controller's URL, the actions an AWS router's
controller answers and Google Cloud's `manager-settings`, each asking for refusals (an asynchronous one too). A call gives
up after 10 s (a cold Cloud Run start), 10 are made at once and a request takes 20 s at most. The controller always answers
JSON: an answer that isn't, or an empty failure, is Google's in front of it. A router's version is compared by
major.minor.patch (a dev router's `0.41.0-dev.1` meets 0.41.0, `0.40.0-dev.3` doesn't); the registry keeps the version as
the router reports it. The manager calls a router of 0.40.0 or later; only 0.41.0 reports.

- **The reports** (router credentials design 2026-11-15; router push design 2026-11-14 §4): a router asks the manager's API
  for AWS credentials, `POST <api endpoint>/routers/credentials` (the HTTP API's own URL, not CloudFront's; no body), with an
  identity token of its service account for the API's endpoint, once an hour (it keeps them in memory and asks again when
  under 5 minutes remain). API Gateway refuses a request without a token Google signed for that audience (its JWT authorizer
  `google`); the function then takes the router's project and region from the token's verified email
  `dmtr-<region>@<project>.iam.gserviceaccount.com`, and refuses with 403 `router_unknown` a token that is not a router's, a
  manager without a Google Cloud connection, or a router not registered. Otherwise it assumes the role
  `dmt-<env>-manager-router-report` for an hour, the session named `<project>.<region>` and cut by a session policy to
  `events:PutEvents` on the manager's bus with the source `dormeto.router.gcp/<project>/<region>` alone, and answers 200
  `{ "credentials": { "accessKeyId", "secretAccessKey", "sessionToken", "expiration" }, "bus": { "name", "region" },
  "source": "dormeto.router.gcp/<project>/<region>", "managerSettings": { "etag": <settings.json's ETag, or null> } }`
  (never logged); STS failing answers 502 `no_credentials` (`RouterCredentialsNotIssued`). The route has its own throttle
  (burst 100, 50 a second). Then, after each state change and each check, the router puts its journal (from where the bus
  last took it) and its check (`Router checked`, in chunks under 64 KB, with the settings ETag it holds) on the bus itself
  (`PutEvents`), each entry under that source with its own detail. The fleet function reads such an event only from the
  manager's own account, takes the project and region from the source, never from the detail, and drops (logged
  `RouterEventRefused`) another account's event, a source that is not exactly a project and a region, and the event of a
  router not registered: a removed router's credentials last up to an hour, its events stop at once. It ingests the rest as
  an AWS router's events. An event sent again is one history entry, and an older one never sets a summary back. A report
  that fails never holds a wake (2 s at most, credentials included); the router sends again from where the bus last took
  it, at its next state change or check (5 minutes at most). A router that stops reporting gets no new summary, and the watchdog's `silent` rule applies as
  on AWS (no check within 3 periods of its schedule).
- **The watchdog's probe:** at each watchdog run (every 5 minutes), the watchdog invokes the fleet function with `{ "task":
  "probe" }` and waits for it (90 s at most): the fleet function's role holds the connection's federation, the watchdog's
  doesn't. It calls each registered Google Cloud router that is silent or never reported, never one that reports: 10 at
  once, none started after 40 s, the least recently probed first. Each one: its health (`GET /v1/health`); at 0.41.0 or
  later, `manager-settings` with where to report alone (`events: { url, audience }`: the router keeps its settings and
  answers the ETag it holds), then `settings.json` and its ETag when the router holds another (`ManagerSettingsPushed`). What
  the probe met is on the router's `RS#` item (`probe`: `probedAt`, `misses`, `lastError`, `lastRefusal`, `tooOld`,
  `askedAt`), and the watchdog says a refusal, with its command, instead of `silent`. A router that could not report before
  (never reported, or too old) and was just given where to report has 15 minutes, as a router just installed, before it is
  `silent`. A registered router whose controller discovery hasn't found yet is not called: its probe records
  `router_unknown`, once. A probe that fails (the fleet function's error, or no answer in 90 s) is logged
  (`RoutersNotProbed`) and fails the watchdog's run once the routers are compared, which the `watchdog-errors` alarm says.
- **A router removed:** one whose controller URL answers Google's own 404 (not the controller's JSON) to the probe **twice
  running** is unregistered (`RouterUnregistered`), only while its registration is the one the probe read: an uninstalled
  router leaves at the second watchdog run after it went silent, within about 25 minutes of its last report (15 minutes
  to be silent, two runs 5 minutes apart), instead of alarming. A broken connection never counts as a router gone.
- **`too-old`:** a router below 0.41.0 can't report. The probe reads its version from its health and keeps it in the
  registry (`RouterVersionRead`); it pushes it nothing, and the watchdog says `too-old`, not `silent`, with the command that
  upgrades it: `router <v> can't report to the manager: dormeto gcp routers install --project <p> --region <r> --version
  <pinned>` (never below 0.41.0). After the advised install, the next watchdog run reads the new version, gives the router
  where to report and resolves the alarm, within 5 minutes. A router of 0.40.0 is still called by the API and the operations;
  its state is not read until it is upgraded.
- **The refusals,** as a 409 `{ "error": <code>, "message" }` on every route that acts on the router (the lists answer
  200: `GET /routers` with the router's row carrying its `refusal`, `GET /workloads` with the message in its `errors`),
  with the command that fixes it in the message (a failure of the router or of Google's own stays a 502, `router_error`
  or `google_error`):
  - `no_access`: Google refuses the manager's token or the connection is broken (pool, provider or
    service account gone, a grant revoked), `the manager's accounts can't reach the router: dormeto gcp connect
    --project <host> --profile <profile> --env <env>`;
  - `router_too_old`, without a call for a router below 0.40.0, or when its controller has no `/v1/actions`:
    `router <v> can't report to the manager: dormeto gcp routers install --project <p> --region <r> --version <pinned>`;
  - `router_unknown`: discovery has not found the router's controller yet, `dormeto gcp connect` again.
  An action the router does not know is refused `unsupported` by router 0.40.0 (`unknown action: <action>`), which the
  API answers as a 502 `router_error` with that message.
- **The organization's settings:** each write of `settings.json` (`PUT /api/settings/workloads`, `/settings/types`,
  `PUT` and `DELETE /settings/waiting-page`) is pushed to every Google Cloud router with a controller, but one below
  0.40.0, as `manager-settings` (the object written and its S3 ETag), 10 at a time, with where to report, `events: { url,
  audience }` (the route's URL and the API's endpoint); it also goes to the routers `dormeto gcp connect` registers, once
  `settings.json` exists. A router that fails is logged (`ManagerSettingsNotPushed`) and the write's answer does not change:
  its next check reports another ETag, and the fleet function pushes it again (`ManagerSettingsPushed`), once a check (its
  first chunk); a silent router gets it from the watchdog's probe.
- **What stays with the CLI:** every change of an IAM policy, a backend service or a cluster. `install-router` for a project
  and `upgrade-router` and `uninstall-router` for a Google Cloud router answer 400 with the `dormeto gcp routers install`
  or `uninstall` command, and the Routers view shows them instead of its AWS buttons. The router's install, upgrade and
  uninstall, `--request-logs` and a GKE workload's Kubernetes access are CLI commands (`dormeto gcp`). A workload the CLI
  onboarded is renamed, tagged and set through the manager and, a VM or managed instance group one, offboarded; a GKE workload and one whose
  onboarding turned request logs on are not: their offboarding fails at `locate`, before anything changes, with `dormeto gcp
  workloads offboard <id> --project <p> --region <r>`. The offboarding removes the tag `dormeto/managed` the onboarding
  bound, as the command account. For either, the workload view shows that command instead of its Offboard action.
- **Alerts:** every alert carries the message attribute `cloud` (`aws` or `gcp`), for filter policies; a digest carries
  the cloud its alarms share, and both as the `String.Array` `["aws","gcp"]` when they mix, which a filter on either cloud
  matches. A Google Cloud workload's failed wake is advised in Google Cloud's words for its kind: Compute Engine's zone
  capacity and fallback machine types, its quotas, the router's service account (`dormeto gcp routers show --project <p>
  --region <r>`, then `dormeto gcp routers install` again), the backend service's health check.

## Health alerts, IP lists and MFA

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
- **Workload defaults:** the same bucket holds `settings.json`, the administrators' defaults for every router
  (hibernation, joined windows and ended windows; the `hibernate` default hibernates EC2 instances and suspends Google Cloud VMs
  instead of stopping them: `{"workloads": {"hibernate": …, "joinMinutes": …, "endedWindowDays": …},
  "updatedAt", "updatedBy"}`; a write sends any of them, the others stay; `joinMinutes` or `endedWindowDays` null removes it,
  and a router reads an absent or invalid one as unset: joined up to 15 minutes, ended windows removed after 365 days, 0
  keeping them), written
  by the API only (`PUT /api/settings/workloads`, Routers › Workload defaults), never by Terraform, so an apply keeps it; the bucket's
  `force_destroy` removes it with the bucket at uninstall. Routers 0.32.0 read it beside `catalog.json` (within 5
  minutes); a router without `ip_lists_catalog` reads none and uses its own level or the built-in default. A
  `settings.json` that is not a JSON object reads as never set (the API says it is unreadable). Only a write naming
  `hibernate` replaces it; any other, the waiting page's too, is a 409 that says why, as it would lose what the file holds. The same object holds the organization's waiting page under `waitingPage`
  (`GET|PUT|DELETE /api/settings/waiting-page`; routers 0.35.0 read it themselves, so a change reaches visitors within about a
  minute). The page keeps its own `by` and `at` inside `waitingPage`, apart from the file's `updatedBy` and `updatedAt`, which
  stay the hibernation default's. Each setting's write keeps the other's keys, and the file is rewritten whole, so two
  administrators saving at the same moment lose one of the writes.
- **MFA:** `mfa` sets the user pool's MFA (`ON` only for `required`) and the API's policy (`MFA_MODE`): the API reads each
  user's MFA with `AdminGetUser` (cached 5 minutes when on, 30 seconds when off, `/api/me?fresh=1`), and lowers an
  administrator or operator without it to viewer under `operators`; in that mode a group's grant giving `wake` or `nap` also needs a
  multi-factor session (without it the user keeps `read`). The Account page sets up TOTP with the user's access
  token; Users resets another user's. The smoke user is enrolled by `scripts/smoke.mjs` at its first run (secret in SSM
  `/dmt-<env>/manager/smoke-totp`). No client may write a user's email (with the scope the Account page needs, a stolen
  access token could otherwise move the account to another address).
- **Passkeys:** `passkeys` (true by default, not offered with `mfa = required`) lets users register passkeys from the
  Account page (managed login's `/passkeys/add`, listing and removal with the user's access token) and sign in with them.
  A passkey with user verification is multi-factor by itself: the dashboard asks for `acr_values=urn:cognito:loa:1`, the ID
  token's `amr` (`swk`, `hwk` or `mfa`) decides the session's rights, and a token without `amr` is judged by the
  authenticator check as before. With an authenticator app on, Cognito does not allow passkey sign-in. The relying party is the auth domain with a custom domain, else Cognito's default. An administrator
  cannot list or remove another user's passkeys: a lost device is answered by disabling the user. Only with passkeys on does
  the dashboard ask for `acr_values` and the API read `amr`; otherwise the enrollment decides, as before. Turning the second
  factor off (the Account page's Turn off, `optional` mode only, or an administrator's reset) leaves the account as strong as
  its password until a passkey or the app is set up again, since managed login's passkey registration needs only a sign-in:
  a user who moves from the app to passkeys asks for the reset and adds a passkey right away, and a user who never set up
  a second factor should do it at the first sign-in (anyone with the password can enrol an app today).
- **Lost authenticator:** another administrator resets it from Users (keep at least two administrators with one). The
  last administrator, with AWS credentials of the manager's account:
  `aws cognito-idp admin-set-user-mfa-preference --user-pool-id <user_pool_id> --username <email>
  --software-token-mfa-settings Enabled=false,PreferredMfa=false`, and under `required` also
  `aws cognito-idp admin-delete-software-token --user-pool-id <user_pool_id> --username <email>` (a recent AWS CLI); they
  set up a new one at their next sign-in.

## Failed wakes

- **Failure index:** the fleet ingestion writes `WF#<account>#<region>#<workloadId>` from a `FAILED` state change (the
  router's `failure` from 0.25.0: kind, step, backend, AWS's message; "no reason" before) or from a check summary that has
  a failure the index lacks; a successful wake (an `AWAKE` change or a summary without failure) deletes it, and so does
  the workload leaving its router. Nothing is written while workloads wake well.
- **Alerts:** the watchdog makes each entry an alarm subject (`workload#<account>#<region>#<workloadId>`, problem
  `wake-failed:<kind>`): one alert per kind across retries, "woke again" when the entry leaves; failing again more than
  15 minutes after waking is a new alert (routers and lists are damped 6 hours). Each message is published
  with `MessageStructure: json`: the text for `email` (and `default`), an Amazon Q Developer custom notification for
  `https` subscriptions, and the attributes `level`, `kind` (`router`, `list`, `workload`, `digest`, `update`), `cloud`,
  `account`, `region`, `router` and `workload` for subscription filter policies (for example `{"kind": ["workload"],
  "account": ["123456789012"]}` for one team's channel; a digest of both clouds' alarms has `cloud` as a `String.Array`).
- **Chat:** an Amazon Q Developer in chat applications channel (Slack or Microsoft Teams) subscribed to
  `dmt-<env>-manager-alerts` (Terraform `aws_chatbot_slack_channel_configuration` or
  `aws_chatbot_teams_channel_configuration` with `sns_topic_arns`, or the console) receives the chat body.
- **Dashboard and API:** the workload view shows the last failure, the failures in a row, the next attempt and the
  fallback instance types in use; the state chip's tooltip the last failure; the Alerts card links to the workload.
  Onboarding takes `fallbackInstanceTypes` (at most 5) and `failedRetrySeconds` (10 to 600), checked by the API.
- **Access:** fallback instance types need `ec2:ModifyInstanceAttribute` in DmtRouterBoundary (router 0.25.0's
  `router-boundary.json`): apply the access module or the AWS CLI script of 0.5.0 again in every member account.

## Daily update check

- **Setting:** off until an administrator turns it on in the Update page ("Check daily for new versions"), with a second
  choice, "Also send it to the alert topic". Stored as `UPDATE#CHECK` (`enabled`, `alert`, `updatedAt`, `updatedBy`); the
  last result as `UPDATE#RESULT` (`checkedAt`, `running`, `latest`, `error`, `notified`).
- **Run:** the `dmt-<env>-manager-update-check` function, scheduled at 07:00 UTC (`cron(0 7 * * ? *)`, no retry: the next day
  tries again). Off, it reads the setting and stops. On, it reads `versions.json` of the releases site (else `latest.json`,
  5 seconds at most), keeps the newest version above the one running and records it; an unreadable index is recorded as
  an error and sends nothing. Run it by hand from the Lambda console to try it (any test event).
- **Alert:** with the alert chosen, a newer version than the last one sent (`notified`) is published once to
  `dmt-<env>-manager-alerts`: subject `[Dormeto <env>] Manager <version> is available`, the running version, the release
  notes and the Update page's link, with the attributes `kind = update` and `level = info`. `info` is a new level:
  filter policies on `level` (`warning`, `error`) do not receive it unless widened (`{"level": ["warning", "error",
  "info"]}`); one channel can take only these with `{"kind": ["update"]}`.
- **Dashboard:** administrators see a notice on the Overview while the last result names a newer version, until they
  dismiss it for that version.

## State history

- **Store:** each `Workload state changed` event is kept as `HIST#<account>#<region>#<workloadId>` / `<at>#<to>` (a
  duplicate is the same item), with its cause, wake id and duration, failure and who asked it from the manager; the
  table's TTL removes it `history_days` (default 400) after it. A check whose state differs from the stored summary's
  writes an inferred transition dated by the router's `stateAt` (0.26.0: the event's instant, so the late event replaces
  it), else the check's time; a workload's first entry is written when the manager first sees it (`historySince`).
  Nothing is written for a check that changes nothing.
- **API and dashboard:** `GET /api/workloads/{router}/{id}/history?days=1..31` answers the period's entries, phases,
  time per state and wakes (at most 5,000 entries, then `truncated`); the workload view's History card draws them.
