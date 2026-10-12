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

## Failed wakes

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

## State history

- **Store:** each `Workload state changed` event is kept as `HIST#<account>#<region>#<workloadId>` / `<at>#<to>` (a
  duplicate is the same item), with its cause, wake id and duration, failure and who asked it from the manager; the
  table's TTL removes it `history_days` (default 400) after it. A check whose state differs from the stored summary's
  writes an inferred transition dated by the router's `stateAt` (0.26.0: the event's instant, so the late event replaces
  it), else the check's time; a workload's first entry is written when the manager first sees it (`historySince`).
  Nothing is written for a check that changes nothing.
- **API and dashboard:** `GET /api/workloads/{router}/{id}/history?days=1..31` answers the period's entries, phases,
  time per state and wakes (at most 5,000 entries, then `truncated`); the workload view's History card draws them.
