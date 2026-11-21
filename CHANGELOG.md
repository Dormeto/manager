# Changelog

Versions of the Dormeto manager, each with the router version it installs. Releases:
https://releases.dormeto.com/manager/ (install: https://dormeto.com/get-started.html). An **Access** line says when the
member accounts' roles or the delegation policy must be applied again (the access and organization modules, or the AWS
CLI script, of the same release).

## Unreleased

- **Standalone workloads on AWS and Google Cloud: resources with no load balancer, napped when idle or by schedule.** A
workload is now of one of two kinds. An HTTP workload is behind a load balancer, as before: its requests wake it, and its
rows and answers are unchanged (no `kind`; absent means HTTP). A standalone workload is one resource that no load balancer
uses: on AWS an EC2 instance outside an Auto Scaling group, an Auto Scaling group with no target group, an ECS service with
no load balancer, an RDS instance or an Aurora cluster; on Google Cloud a Compute Engine VM outside a managed instance group,
a managed instance group, or a Cloud SQL instance, that no backend service uses. It naps when its idle signals stay under
their thresholds for its idle window, or by its schedule; nothing wakes it on demand: a schedule, a person (Wake) or a start
made in the cloud does. A wake that fails is retried by the router's check until it succeeds or a person naps the workload
(Nap is offered on a failed one, and ends the retries); the workload's page says when the next attempt comes, or that none is
coming while a pause, a nap window, its resource or a nap asked holds it, and a failed nap is tried again after the idle
window. It needs the router that knows standalone workloads, on either cloud; an older one refuses its preview and asks to be
upgraded. What differs between the clouds: the resources above; the custom metric's shape (a CloudWatch metric on AWS, a
Cloud Monitoring metric type with an optional filter and an aligner on Google Cloud: the dashboard's form takes the level's
cloud's, and the organization's level and a type pick the cloud, a router of the other cloud ignoring it); what marks the
resource (AWS's tag `dormeto:workload` with the workload's id, which the router reads, so an untagged resource is missing;
on Google Cloud the tag `dormeto=managed` the manager binds, which the router's roles require but cannot read, so a resource
is missing only once Google says it is deleted, and a permission failure names that tag); a Cloud SQL instance's network,
not a signal; the wake timeout, at most 1,700 s on Google Cloud; and Spot capacity: every Spot instance is refused on AWS,
while Google Cloud accepts Spot and preemptible VMs (a VM Google preempts is read as a stop made outside Dormeto).
  - **Google Cloud's discovery:** with the same switch on, each project's scan also lists its Compute Engine VMs, managed
  instance groups and Cloud SQL instances, each a candidate of its own path (`id` and `resource`, `cloud: "gcp"`, no
  `resourceArn`): eligible, ineligible in the Google Cloud router's words (a managed group's member, a GKE node, a GPU, a local
  SSD, a stateful group, a regional group with the target shape EVEN, a read replica), or managed by a router's standalone
  workload. A VM or a group that backs any backend service is never eligible: the backend of an HTTP candidate is left out,
  one behind another backend service is listed with it (`… backs backend service <s>: it belongs to an HTTP workload`).
  Criteria take its labels, region and kind (`cloudsql-instance` too); an exclusion takes its path. Its idle share is
  read from Cloud Monitoring: a VM's CPU, each VM of a group's, a Cloud SQL instance's connections. **Run `dormeto gcp connect`
  again to list Cloud SQL instances:** the discovery account's role `dormetoDiscovery` gains `cloudsql.instances.list` and
  `cloudsql.instances.get`; until then, or in a project whose Cloud SQL Admin API is off, the VMs and groups are listed, the
  stored Cloud SQL candidates stay as they were, and the run says which of the two it is.
  - **Google Cloud standalone workloads:** onboarding (`POST /operations`, the resource's path as `candidateId`) goes to the
  router of the resource's region, else the project's only router (`router` names one among several), takes only a resource the
  last scan listed as eligible (another is refused with its reason, an unlisted one with what to do: the router cannot see a
  backend service), binds the tag `dormeto/managed` to the resource (a VM or a group by its id) and its Cloud SQL companions,
  and verifies it awake with its resource among its backends; offboarding wakes it first, unless its resource is missing. The
  rows and statuses keep `kind`, `resource`, `resourceMissing` and the five settings (`idleMetric` in Google Cloud's shape:
  `{ type, filter?, aligner, below }`); an exclusion takes a resource by its path (`target.path`). The settings routes take the
  idle signals at a Google Cloud router's and workload's level in Google Cloud's shape, and either cloud's at the
  organization's, the answer saying which cloud each applies to (`idleMetricCloud`, `idleMetricClouds`). The organization's
  idle signals are pushed to a Google Cloud router whose version knows them, never before; the gate and the watchdog's
  `idle-signals-unknown` warning hold a router of either cloud only while it is older than its cloud's first version that
  knows them. The Activity history reads Cloud Monitoring with the router's queries. A router's `cloud-sql-unreadable`
  warning says what to do.
  - **Turn it on:** the discovery perimeter's `standalone` is `off` (the built-in, also when absent: an upgraded install
  sees no new candidate and makes no new call) until set to `on` (the Discovery view's Standalone resources switch). On,
  each region's scan lists those resources, each a candidate of its own resource (`kind: "standalone"`, its ARN as `id`
  and `resourceArn`, its `backend { kind, id, arn }`, its name and its own tags; no load balancer, rule, host or target
  group field), eligible, or ineligible in the router's words (in an Auto Scaling group, an instance store root volume, a
  Spot instance, it feeds a target group, EKS nodes, the daemon scheduling strategy, an Aurora member, a read replica,
  Aurora Serverless v1), or managed once onboarded. The account, region, resource tag and backend kind criteria apply to
  the resource (`backendKinds` takes `rds-instance` and `rds-cluster`); exclusions take a resource (`target.kind:
  "resource"`). Its idle share is its hours of the last 7 days with its type's default signal under its threshold at every
  5-minute point (a server's CPU under 5 %, a database's connections under 1); a resource with no point all week has none.
  `kind=http|standalone` filters `GET /discovery/candidates` and `GET /workloads`.
  - **Apply the access module (or the AWS CLI script) again to see databases:** `DmtDiscoveryRole` gains
  `rds:DescribeDBInstances`, `rds:DescribeDBClusters` and `rds:ListTagsForResource`. Until then the scan lists the other
  kinds, says in the run which RDS list it may not read, and keeps the RDS candidates it had.
  - **The idle signals:** `idleCpuPercent` (0 to 100), `idleNetworkBytes` (bytes a minute, a whole number up to
  10000000000), `idleMetric` (a CloudWatch metric: namespace, name, dimensions where `${resource}` is the resource's id, a
  statistic and a threshold), each a value or `off`, with `idleMinutes` and `wakeTimeoutSeconds`: the five settings of a
  standalone workload. They are set at every AWS level, as the HTTP settings are: the organization's defaults, a type, a
  router, the workload. A workload refuses the other kind's keys (a standalone one the waker's, an HTTP one the idle
  signals, at its onboarding too). **An idle signal at the organization's level (its defaults or a type) is refused (409,
  naming them: `the organization's idle signals need every router at <version> or later: <n> router(s) must be upgraded first: …`)
  while any router does not know them yet**: a router of either cloud before its cloud's first version that knows them, or
  one whose version is unknown. Upgrade those
  routers first; the idle window and a write that keeps or removes the signals are not held back. A router that does not
  know them refuses its own level's (409).
  - **Onboarding:** `POST /operations` with `type: "onboard"` and the candidate's resource ARN as `candidateId`
  (claim `RES#<arn>`): the router's preview, then its onboarding with `resourceArn`, verified awake with its resource
  among its backends. A waker's setting is refused before the operation. Offboarding wakes it, then gives its candidate
  back. The dialog says what a nap does to the resource, that nothing wakes it on demand, takes its idle signals and
  links to Schedules.
  - **The workload:** its row and status carry `kind: "standalone"`, `resourceArn`, `resourceMissing` (its resource
  deleted or untagged: the router warns `resource-missing`; offboard it or tag it again) and its five settings with
  their `settingsFrom`; no `url`, waiting page, rules, targets or wake filtering (a waiting page and a target group
  exclusion naming it are refused). Its page has an Activity card: each signal's threshold, where it comes from, its last
  value and since when it is under, when it may nap, and its history: `GET /workloads/{router}/{id}/activity` reads the
  signals of the last 7 days through the discovery role, draws each against its threshold with the hours asleep, and
  replays them through the idle window advisor from 5 minutes to 24 hours (hours asleep and stops a day; the
  recommendation from 5 minutes to 2 hours). A point is activity when a signal is at or over its threshold or missing
  while awake; a read that fails answers 502 `metrics_unreadable` and the card says so, never an idle week. The history
  names the causes `external-start`, `external-stop`, `recovered` and the check's `retry`; a person's nap of a failed one
  is `manager` with who asked, the check's own release `failed-released`. The demo mode has one standalone workload of each
  kind and state on both clouds (on Google Cloud a VM with its own Cloud Monitoring metric, a group asleep by its schedule, a
  Cloud SQL instance asleep on its connections, a VM whose wake is retried, a Cloud SQL instance with a kept permission
  failure), candidates eligible and not, the scan on, and a run that could not list a project's Cloud SQL instances.
  - **A resource deleted or untagged:** the router's health warns `resource-missing` and nothing is stopped or started;
  offboarding such a workload no longer wakes it: it is offboarded in any state, what is gone skipped. Tag the resource
  again (`dormeto:workload` with the workload's id) to keep it.
  - **When it naps, and what the manager says:** the router reads the signals 10 minutes behind, at its 5-minute check, so
  an idle nap comes 10 to 15 minutes after the idle window; the Activity card gives the nap's latest time. Onboarding
  verifies the resource among the workload's backends for up to 3 minutes (an ECS service's tag is listed late). The
  Discovery view shows what a run could not read in an account and region (the RDS lists, the services' tags, an idle
  share). Turning the standalone scan off makes the managed standalone workloads To offboard. A router that does not know
  the idle signals while the organization holds them gets a health warning (`idle-signals-unknown`) naming the levels it
  ignores, and the watchdog's role reads `settings.json` for it: apply the manager's module.
  - **The router's side:** the Terraform `workload` module takes `resource_arn` in place of `app_target_group_arn`, with
  `idle_cpu_percent`, `idle_network_bytes`, `idle_metric` and `databases`, and refuses the waker's variables
  (`wait_seconds`, `drain_seconds`, `max_holders`, `failed_retry_seconds`, `wake_mode`, `no_wake_rules`, `wake_rules`,
  `instance_ids`, `waiting_page`, `admin_enabled`, `rule_arn(s)`) with it; tag the resource and its databases
  `dormeto:workload` yourself. Every Spot instance is refused. A standalone workload refuses a waiting page, a route repair
  and a target group pause. The router needs no new permission.
- **Workloads' marks explained:** every icon of the Workloads view's Workload column has a tooltip and an accessible name:
the standalone kind ("Standalone: a resource with no load balancer. A schedule, a person or a start made in AWS wakes it.")
and a schedule ("Has a schedule: it naps and wakes at set hours (its Schedule card says when)."). The Kind filter of
Workloads and Discovery shows each kind's icon, the web for HTTP and the server for standalone, in its list and its value.
- **Groups have a view of their own:** the dashboard's custom groups leave the Users view for Groups (Administration,
right after Users, for administrators only, at `/groups`): a table in the dashboard's form (search, sort, exports, a row's
menu with Edit and Delete), with each group's name, description, grants, members (how many users hold it, a link to Users
showing only them, `/users?group=<name>`) and last change (when and by whom); a row opens its dialog, as does a link
`/groups?group=<name>`. The Users view keeps each user's groups: the column, each group linking to it in Groups, the
user's "Groups…" and the invitation's groups.
- **Google Cloud routers report to the manager's event bus:** a router 0.41.0 asks the manager's API for AWS credentials
once an hour, `POST <api endpoint>/routers/credentials`, with an identity token of its own service account (no key, no
grant in Google Cloud), and puts its state changes and its checks on the bus itself. API Gateway checks the token (issuer
`https://accounts.google.com`, audience the API's endpoint), the API takes the router's project and region from its email
(`dmtr-<region>@<project>.iam.gserviceaccount.com`), refuses a router not registered (403 `router_unknown`), and answers an
hour's session of the new role `dmt-<env>-manager-router-report`, cut by a session policy to `events:PutEvents` with the
source `dormeto.router.gcp/<project>/<region>` alone, with the bus's name and region (STS failing: 502 `no_credentials`).
The API function's role loses `events:PutEvents` and may assume that role only. The fleet function ingests such an event as
an AWS router's, from the manager's own account only, under the source's project and region, and drops a malformed source
and the event of a router not registered (a removed router's credentials last up to an hour). The route has its own
throttle (burst 100, 50 a second). Each `manager-settings` push now says where to ask for credentials (`events: { url,
audience }`), also to the routers `dormeto gcp connect` registers, and a check whose router holds another settings ETag gets
the organization's settings pushed again.
- **The poll of Google Cloud routers ends:** the schedule `<name>-poll`, its role and the fleet function's `{ task: 'poll' }`
are removed, with the journal cursor on each router's `RS#` item (`poll`, removed at the router's first probe). A Google
Cloud router below 0.41.0 can't report: the watchdog says `too-old`, `router <v> can't report to the manager: dormeto gcp
routers install --project <p> --region <r> --version <pinned>` (never below 0.41.0), and a router 0.40.0's state is not read
until it is upgraded (the API and the operations still call it). Update the manager before upgrading its Google Cloud
routers; between the two, a router 0.41.0 is read by nothing (it does not answer the poll's `events`).
- **The watchdog probes silent Google Cloud routers:** at each run (every 5 minutes) the watchdog has the fleet function
(`{ task: 'probe' }`, waited for 90 s at most; its role gains `lambda:InvokeFunction` on the fleet function, nothing in Google
Cloud) call each registered Google Cloud router that is silent or never reported, never one that reports: its health, then
`manager-settings` with where to report, and the organization's settings when the router holds another ETag. A router whose
controller answers Google's own 404 twice running is unregistered, now at the watchdog's pace: within about 25 minutes of its
last report, instead of two minutes. A refusal is said with its command as before; its hint is now "The manager's call to
the router is refused: once the command has run, the watchdog calls it again at its next run (every 5 minutes)." A router
just given where to report that could not report before has 15 minutes before it is `silent`, whose advice now names
`dormeto gcp routers show` and the router's `ReportFailed` and `ReportRefused` logs. A probe that fails fails the watchdog's
run (the `watchdog-errors` alarm).
- **Router 0.41.0 on Google Cloud:** the router reports to the manager after each state change and each check: it asks the
manager's API for credentials (`POST /routers/credentials`) with its service account's identity token, keeps them in memory
for the hour, and puts its journal and its state on the manager's bus itself (`PutEvents`, signed with Signature Version 4).
No new role or permission in Google Cloud. A report that fails never holds a wake more than 2 s, credentials included, and
the next one resends from where the bus last took it. `manager-settings` takes `events: { url, audience }`, or that alone. `GET /v1/health` and the
`router` action show where the reports stand (`report`). The `events` action is gone: a manager below 0.25.0 that polls such
a router gets `unsupported` and shows its state stale until the manager is updated.
- **Router 0.41.0 on AWS:** the router's roles may put on the manager's bus only with the source `dormeto.router`, and the
boundary `DmtRouterBoundary` only `dormeto.router` and `aws.elasticloadbalancing`. Until an AWS router in the manager's own
account is upgraded to 0.41.0 it could still send a Google Cloud router's source; the boundary reaches the member accounts only when the
access module is applied again.
- **The bus admits the AWS routers' and the forwarders' sources only:** its policy allows the organization's principals (the
manager's account without an organization) `events:PutEvents` for `events:source` `dormeto.router` and
`aws.elasticloadbalancing` (the forwarders of event-driven refresh) alone, so no other account can send a Google Cloud
router's source. An AWS router installed in the manager's own account is allowed by its role, which router 0.41.0 limits to
the same source; until it is upgraded, it could still send `dormeto.router.gcp/<project>/<region>`.
- **Workloads, four columns fewer:** Since, Wake mode, Wakes (7 days) and Wakes (total) are gone; a row's "Last 7 days" bar says
them in its tooltip, a labelled line each after the states (`Asleep since: 2 h ago (Nov 13, 2026, 08:02:00 AM GMT+1)`, `Wake mode`,
`Wakes in the last 7 days`, `Wakes in total`), and in its name for screen readers; a fact the row does not have is left out. The
column's CSV and PDF text carries them too, the date as ISO 8601 (`awake 17 %, asleep 83 % · idle 89 % · Asleep since:
2026-10-09T10:00:00.000Z · Wake mode: browser · …`).

## 0.24.0 — 2026-11-12

Router 0.40.0. Access: nothing to apply again (the access and organization modules, the AWS CLI script, the routers'
boundary and Kubernetes rights are unchanged).

The manager reaches Google Cloud routers, installed by the CLI, as it does AWS ones: it reads them every minute and calls them,
through a connection `dormeto gcp connect` makes, with no key and no change of a Google IAM policy by the manager. An AWS router,
row, event or call behaves as before. The CLI commands it names are CLI 0.14.0's (`dormeto gcp connect`, `dormeto gcp routers
install`, `uninstall` and `show`).

- **Onboarding and offboarding on Google Cloud from the dashboard:** the onboarding dialog of a Google Cloud candidate asks for its
name, labels (copied from the VMs on request), Cloud SQL companions by name, fallback machine types (at most 5, each once, as the
router's pattern), idle minutes, wake mode and suspension, and a router when a `global` candidate's project has several (only those
of 0.40.0 and later are offered, the only one left chosen already, and Onboard waits for the list); it says the
manager binds and removes the tag `dormeto/managed` and shows no Terraform or EC2 text. Offboard and Exclude (by the backend
service's path) are offered for a Google Cloud workload but the Offboard of a GKE one and of one whose onboarding turned request
logs on, which show the CLI's command instead. The demo onboards and offboards Google Cloud
candidates and workloads in the Google Cloud steps. The API finds a `global` Google Cloud candidate's workload, router and running
operation by its backend service, not by a region, and names the router as the manager lists it (`dmtr-<project>-<region>`, by
the workload row's project and region).
- **A refusal of a Google Cloud router says what Google answered:** the poll's error, the API's 409 and the watchdog's problem for
`no_access` end with `(Google: <host> <status> <reason>: <message>)`, the host being STS, iamcredentials or the
controller's, the message cut to 200 characters; never a token or a signature.
- **One model for both clouds:** an `account` is an AWS account or a Google Cloud project; a row that can be of either
cloud carries `cloud` (event refresh's accounts are AWS's), and a region is checked against its account's cloud
(`@dormeto/fleet/clouds`). The manager accepts a Google Cloud router's rows and events (a backend service instead of a
target group, VM names in `hibernated`), names its router `dmtr-<project>-<region>`, and reads a `*/N * * * *` check
schedule. An AWS router behaves as before.
- **The manager's Google identity (`@dormeto/google`):** its Lambda roles act as the two service accounts of a Google Cloud host
project through workload identity federation (a signed `GetCallerIdentity` exchanged at Google's STS, then
`iamcredentials`), with no key and nothing stored; tokens are kept in memory until 5 minutes before they expire, and every
call gives up after 3 s without a connection or 10 s of silence, but a router's: its controller answers once its action is
done, so the call may be silent up to its own bound (300 s for `preview`, `onboard` and `offboard`), and is aborted there.
- **The Google Cloud connection:** `PUT` and `DELETE /iam/discovery/google`, for IAM callers only (`dormeto gcp connect` and
`disconnect`; a dashboard session's write is refused with 403), and `GET` for viewers under `/iam` and `/api`, keep the record
`dormeto gcp connect` writes (`DISC#GOOGLE`), each field checked against what connect writes: the projects and regions, the pool
`dmt-<env>` and its provider `aws-<account>` (the manager's AWS account), scopes `organizations/<n>`, `folders/<n>` or `projects/<id>`, that env's two service accounts in
the host project, a controller URL ending in `run.app`, a version `x.y.z` with an optional prerelease (a dev router's
`0.40.0-dev.1`). `GET` answers `{ connection }`, `null` when there is none. A `PUT` registers each of its routers
as `ROUTER#<project>#<region>` under its own name `dmtr-<region>` (shown in the manager as `dmtr-<project>-<region>`; `cloud: 'gcp'`),
with the controller URL and version the record carries (a router's entry may leave them empty: discovery then learns them, and
the poll the version of a router too old to poll; a later record that leaves them empty keeps what they learnt) and unregisters
the Google Cloud routers a later record drops; a `DELETE` removes the record and every Google Cloud registration. AWS
registrations are never touched. Audited as `google-connection`.
- **Discovery lists Google Cloud routers:** with a connection, each run (in its finalize step) lists the Cloud Run services
`dmtr-<region>-controller` of the run's projects (those at the connection's scopes, listed once, when the run starts; a listing that
fails keeps the last run's), and adds, updates (controller URL, `DMT_VERSION`) or removes the `ROUTER#` registrations;
a project that fails is recorded in the run and keeps its routers, Cloud Run turned off means no router there. AWS registrations are
never touched.
- **Discovery of Google Cloud projects:** with a connection, the projects at its scopes join every run, in both modes, as accounts
of the inventory (their folders and organization as their path, their labels as account tags), each scanned as the discovery
account. A candidate is a backend service a URL map names (`id` and `backendService` its path, `targetGroup` its name, `urlMap`
the map's path, `region` the map's region or `global`, `lb` the load balancer's kind): eligible, ineligible with the router's own
onboarding reason (the first one; a GKE workload's backend is `k8s`, its reason `a GKE workload is onboarded with dormeto gcp
workloads onboard, after dormeto gcp workloads access grant`), or managed when a router's workload row names it. Its idle share
comes from Cloud Monitoring's request counts over 7 days (estimated: Google samples them); when Monitoring fails or is turned off a
candidate keeps the one it had, `null` for one never read. A region Compute Engine answers unreachable fails the project's pair there
only where a candidate is stored or a candidate's backend is; Compute Engine turned off is nothing to find. The API takes them:
`PUT /discovery/config` criteria take project IDs in `accountIds`, `folders/<n>` and `organizations/<n>` in `ouIds`, Google Cloud
regions and `global` in `regions`, and URL map and backend service paths in `loadBalancers`; `POST /exclusions` takes a Google
Cloud target by `target.path` (a backend service's or a URL map's); `GET /discovery/candidates` takes a project as `account` and
`region=global`. AWS's discovery is unchanged.
- **Access on Google Cloud projects:** each project's step records whether the discovery account could read it (Compute Engine
turned off is nothing to find) and, where a router is, whether the command account holds what the manager does there: the
permissions of `dormetoCommand` on the project, `run.routes.invoke` on each router's controller and
`resourcemanager.tagValueBindings.create` on the tag value `<project>/dormeto/managed`, checked by the access check function (now also
reading `DISC#GOOGLE`, so it needs the table); a refusal of the command account's token itself (STS or iamcredentials: the
federation or the account's grant) says the manager can't act as the command account instead of listing every permission. The
Organization access panel lists projects as accounts, its chips and counts naming the discovery and command accounts, and links to
the Google Cloud connection's page for them; onboarding a candidate of a
project that misses access is refused with 409 and the `dormeto gcp connect` command that fixes it. A Google failure that is no
refusal keeps the last verdict. AWS accounts behave as before.
- **Onboarding on Google Cloud:** `POST /api/operations` `{type: 'onboard'}` takes a candidate of a project, on the router of its
region for a regional load balancer, on the project's router for a global one (`router` names it when the project has several,
else 400 listing them); no router there is a 400 with `dormeto gcp routers install --project <p> --region <region> --version <pinned>`, one
before 0.40.0 a 409 `router_too_old`. Its `settings.fallbackInstanceTypes` are Compute Engine machine types (at most 5, each once) and
its `databases` Cloud SQL instances, `{kind: 'cloudsql-instance', id: <name>}`; the project's number is read as the discovery
account (a refusal: 502 with Google's words). The operation runs `find router`, `slot` (the project's and the router's region),
`lock load balancer` (the URL map), `preview`, `tag`, `onboard`, `verify`, `candidate`: the router's dry run and onboarding in
AWS's onboarder payload (the URL map's and backend service's names, the load balancer's kind), the tag `dormeto/managed` bound as
the command account to the VMs and managed instance groups the preview names and to the Cloud SQL instances given, one per run of
the step (one bound already, Google's 409 `ALREADY_EXISTS`, is left alone). A refused onboarding, or a binding that fails, removes
the bindings the operation made, one per run of the step after the failure's, and says so; one whose answer was lost (a timeout, a
failure) removes none and names them, as does an operation the workflow fails outside a step. A step run again after a lost answer that the router refuses as
onboarded already is done when the router's status shows the workload on the candidate's backend service, nothing removed. The
workload is verified by the router's status (its backend service, no issue, not `FAILED`). AWS onboardings are unchanged.
- **Offboarding and exclusions on Google Cloud:** `POST /api/operations` `{type: 'offboard'}` takes a workload of a Google Cloud
router, the project's number read as the discovery account (a refusal: 502 with Google's words). The operation runs `locate` (the
router's status), `slot`, `lock load balancer` (the URL map), `pause`, `wait awake`, `offboard` (the router's, within 300 s),
`untag` and `candidate`. A GKE workload, or one whose onboarding turned request logs on, fails at `locate` before anything changes,
in the router's words with `dormeto gcp workloads offboard <id> --project <p> --region <r>`; so does a tag value that can't be read
(with `dormeto gcp connect --project <host> --profile <profile> --env <env>`) or a Cloud SQL instance whose region Google refuses (one answering 404 is gone: said, nothing to untag
there). After the router's offboarding the tag `dormeto/managed` is removed as the command account from the VMs and managed
instance groups its status names (by the ids the onboarding stored) and from its Cloud SQL instances, one per run of the step: one
not tagged is said, a failure that passes (429, 5xx, no answer) is tried again later, another fails the step naming what stays
tagged, and a VM or group an older onboarding stored no id for is named, its tag to remove by hand. The candidate is eligible again.
An `offboard` step run again after a lost answer that finds the workload gone is done. An exclusion of a backend service, a URL map
or a project pauses its managed workloads through every router of the project, with the backend service's path instead of a target
group (`{action: 'pause', workloadId, backendService, by, reason, until?, exclusionId}`), the next router tried when one has no such
workload; its lift resumes them by the exclusion's id. A router below 0.40.0 is never called, and one that fails (a refusal other
than `not_found`, a timeout) is not called again in that run of the step; their errors are said for a workload no router paused,
and a lift keeps the pauses on them. AWS offboardings and exclusions are unchanged.
- **The watchdog watches Google Cloud routers:** one below 0.40.0 (by major.minor.patch: a dev router's `0.40.0-dev.1` meets it), or
whose controller answered the poll that it has no `/v1/actions`, is `too-old` with the `dormeto gcp routers install` command (never
`silent`); one the poll is refused at says that refusal with its command (`no-access`, `router-unknown`) instead of
`silent`, once its 15 minutes of grace are over; a silent one gets the advice for Cloud Run, its Scheduler job
`dmtr-<region>-check` and the controller's logs. A Google Cloud workload's failed wake is advised in Google Cloud's words for its
kind (Compute Engine's zone capacity and fallback machine types, its quotas, the router's service account and `dormeto gcp
routers show`, the backend service's health check). Every alert gains the message attribute `cloud` (`aws` or `gcp`); the update
check's is `aws`, a digest carries the cloud its alarms share, and both as the `String.Array` `["aws","gcp"]` when they mix (a
subscription filter on either cloud receives it).
- **The manager calls Google Cloud routers:** every action it sends an AWS router's controller goes to a Google Cloud router's
`POST <controller>/v1/actions` with the command account's ID token for the controller's URL, 10 s per call (a cold Cloud Run
start; an AWS router keeps its 5 s), 10 at once and 20 s per request as before, each asking for refusals (an asynchronous one too),
read as the AWS controller answers them; an empty failure at the controller URL is Google's, as its pages are.
A Google Cloud router the manager can't use answers 409 `{ error, message }` with the command that fixes it: `no_access` when Google
refuses the manager's token or the connection is broken (its pool, provider or service account gone, its grant revoked), with `the manager's accounts can't reach the router: dormeto gcp connect --project <host> --profile <profile> --env <env>`,
`router_too_old` for a router below 0.40.0 (by major.minor.patch), without calling it, or one whose controller has no `/v1/actions`
(`router <v> can't report to the manager: dormeto gcp routers install --project <p> --region <r> --version <pinned>`), and `router_unknown`
while discovery hasn't found its controller; `GET /routers` lists such a router with its `refusal` and the version the registry
knows. `install-router` for a project, and `upgrade-router` and `uninstall-router` for a Google
Cloud router, answer 400 with the `dormeto gcp routers install` or `uninstall` command: they change IAM policies, which stays with the CLI.
Each write of `settings.json` (`PUT /settings/workloads`, `/settings/types`, `PUT` and `DELETE /settings/waiting-page`) is pushed to
every Google Cloud router with a controller, but one below 0.40.0, as `manager-settings` (the object written and S3's ETag), 10 at a time; a router that
fails is logged (`ManagerSettingsNotPushed`) and gets it at the next poll, and the write's answer is unchanged. A workload the CLI
onboarded is renamed, tagged and set through the manager, and offboarded unless it is a GKE workload or its onboarding turned request logs on (the CLI's). AWS routers are called as before.
- **The poll:** the manager polls its Google Cloud routers, which push nothing: every minute (the schedule `<name>-poll` invokes the fleet
function with `{ task: 'poll' }`, never retried), 10 at once for at most 50 s a run, the least recently polled first, each
router at 0.40.0 or later (by major.minor.patch) or of an unknown version. Its journal (`events`), read again from 5 minutes before the newest event already
read, comes in as an AWS router's `Workload state changed` events (an event read twice is one history entry, an older one
never sets a summary back); when its check is newer than its summary, its rows (`list`) come in as `Router checked` chunks of
1000; when the organization's settings it holds aren't `settings.json`'s, `settings.json` is pushed whole with its ETag
(`ManagerSettingsPushed`), read once a run. The identity is the router called, its project and region, never the payload's.
A router whose controller URL answers Google's own 404 twice in a row is unregistered (`RouterUnregistered`); a broken
connection never counts as a router gone. A router too old to poll (below 0.40.0, or whose controller has no `/v1/actions`) is
kept and not polled until its version changes, nor pushed to: its version is read from its health (`GET /v1/health`, as the
command account) at most every 10 minutes and kept in the registry (`RouterVersionRead`), so the advised `dormeto gcp routers install`
clears `too-old` within 10 minutes. Each router's poll (where its journal was read up to, its 404s in a row, its last error with
the command that fixes it and the refusal it met, `router_unknown` for one whose controller discovery hasn't found yet, the
ETag it holds, when its version was read) is kept on its `RS#` item, beside the summary. The fleet function reads
`settings.json` (`s3:GetObject`; `s3:ListBucket` on the lists bucket for that object's name alone, so a missing one answers
404), updates its table's items (`dynamodb:UpdateItem`) and writes a registration's new version. A Google Cloud row's Cloud SQL backend is kept as `cloudsql-instance`.
- **The dashboard's lists show both clouds:** a cloud mark (Material Design Icons' AWS and Google Cloud marks) before the account or project of a router
and a workload, "Account or project" columns, the Google Cloud regions (every region Google lists, with the location Google names) in the region labels, which say
"AWS location" or "Google Cloud location", the Google Cloud backend kinds (Compute Engine VM, managed instance group, Kubernetes workload, Cloud SQL instance) as
Material Design icons, and Discovery's filter taking a project ID. `npm run dev:mock` gains a Google Cloud router `dmtr-dormeto-dev-europe-west2` (0.40.0) and two workloads.
- **Discovery shows Google Cloud candidates:** a candidate's row names its backend service and URL map, linked to the Google Cloud console, with its load balancer's
kind, `global` for a global load balancer, its backend's name and a Google Cloud icon; its idle share is marked estimated (Google samples its load balancer metrics).
Exclude offers the backend service, the URL map and the project, sent by their paths; the Region filter takes `global`; an offboarding uses the router the candidate's workload
names; Organization access lists a project with its cloud mark and the API's reason, which names the `dormeto gcp connect` command. Discovery settings words its regions
for both clouds and takes Kubernetes workloads as a backend type. A workload's backend services and URL map, named by the router's row, are linked from their built paths.
`npm run dev:mock` gains the project's candidates (managed, to onboard, a GKE workload and a backend service two URL maps name) and a project in the access report.
- **The dashboard's Google Cloud router and workload views:** a router installed by the CLI (`source: 'cli'`) shows its version, health (a `too-old`
router, its version known or not, with the `dormeto gcp routers install ... --version <pinned>` command), pauses, settings (its hibernate
setting as suspension, inherited from the organization's level the manager pushed, and no Lambda or failure queue figure),
waiting page and description, and no install, upgrade,
uninstall or Terraform control: the `dormeto gcp routers install` and `uninstall` commands and its controller's page in the Google Cloud console instead;
the Routers install form stays AWS's with one line naming `dormeto gcp routers install`. A Google Cloud workload shows its backend service, waker backend
service and URL map with the console link (a regional URL map links the project's list of load balancers), its VM, group and Cloud SQL
instance with theirs and their Google Cloud icons, "suspended" where AWS says "hibernated", fallback machine types, a failure, a wake,
its tags and settings in Google Cloud's words (no EC2, target or Lambda; the values Google Cloud fixes said so), no target group,
targets or ARN (its idle window advice and requests heatmap are described below, with Google Cloud's request counts); the workload the CLI
onboarded is renamed, tagged and set from the dashboard, which offers Offboard for it, but a GKE workload's and that of one whose
onboarding turned request logs on stay with the `dormeto gcp workloads offboard` command: the workload view shows that command
(Discovery's Offboard on its candidate fails at `locate`, before any change). Discovery settings shows the Google Cloud connection read-only
(`GET /api/discovery/google`: the host project, scopes, the two service accounts, its routers, who connected it and when), or the command that connects one.
- **Google Cloud's savings:** a nap's VMs and Cloud SQL companions, as router 0.40.0 names them in its `ASLEEP` event, are priced
at Google's USD list prices from the Cloud Billing Catalog, read by the daily savings job as the discovery account (no new role;
60 s a page and 300 s a service, each read logged `GooglePricesRead`, a failed one `GooglePricesFailed` at `warn`, a service's pages once a run) and cached as AWS's prices (30 days, a day for
none; a failed read cached nowhere and asked again after five minutes); the API reads the cache only, so a Google price first met is
priced by the next daily job. Compute Engine by family (predefined and custom, the shared cores, Spot never discounted), a suspended
VM less its memory still billed, Windows as Linux, Cloud SQL MySQL and PostgreSQL by custom, Enterprise Plus N and shared-core tier;
what the rules don't name (another family, SQL Server, an ambiguous match) and GKE pods are listed "not priced" with their hours,
never $0. The `compute` and `databases` discounts take Google's committed use and sustained use discounts. `docs/savings.md` has a
Google Cloud section.
- **Google Cloud's energy:** Cloud Carbon Footprint's Google Cloud figures (watts by machine family, PUE 1.1, Cloud SQL `ha` twice)
and its grid factors by region, from each item's own region; AWS's figures are unchanged.
- **Google Cloud's idle window:** the card and the requests heatmap read Cloud Monitoring's request counts per minute (14 days at most,
the workload's URL map, its application and waker backend services added up) and say they are estimates; the step reads the
connection's record first, so a cold execution environment answers, and with no connection the 502 names `dormeto gcp connect`,
not Cloud Monitoring.
- **The dashboard shows Google Cloud's savings:** the VMs and Cloud SQL databases a nap stopped priced as AWS's items, the tooltips'
notes (Windows licenses not counted, suspended memory subtracted, Cloud SQL tiers priced), both clouds' words for the discounts, the
savings and the energy, and the demo's naps priced at europe-west2.
- **Fixed, a Google Cloud workload's idle window advice:** the requests are asked with the paths of its backend service, its waker's
and its URL map, built from the names its row holds in the scope of its load balancer, where the advice failed with `requests_unreadable`.
- **Fixed, what a router's newer than the manager writes:** a nap's item the manager can't read (a kind it doesn't know, a shape out
of its bounds) is kept as an unknown item, so its hours show as not priced, never as $0 saved.
- **The Google Cloud refusals in snake_case, one answer on every route:** a router the manager can't use is a 409
`{ "error": "no_access" | "router_too_old" | "router_unknown", "message" }` on every route that acts on one (the lists,
`GET /routers` and `GET /workloads`, answer 200 with it), the message carrying the command that fixes it; 502 stays for
`router_error` and `google_error`. The router row's `refusal` and the poll record hold the same codes; a record an earlier
build stored (`manager-access-missing`, `router-too-old`, `router-unknown`) is read as the new one. The router floor is one value (0.40.0), declared in two packages and pinned equal
by a test, read by the manager and the dashboard.
- **A Google Cloud candidate and an operation say their cloud:** a Google Cloud candidate has no `targetGroupArn`, `loadBalancerArn`,
`listener` or `priority` (absent, not empty or `null`; an AWS reader can no longer mistake it) and `cloud: 'gcp'`; its `targetGroup`
and `loadBalancer` are the backend service's and the URL map's names. Operations (the 202 answers too), exclusions and the
workloads they paused, the candidates a dismissal or a restore answers, the discovery run's targets, and the savings' top and
history rows carry `cloud`; an AWS answer's idle window advice says `estimated: false`; an AWS onboarding given a
`cloudsql-instance` database and a Google Cloud one given an `rds-instance` are refused 400 in one message form. A candidate or
operation an earlier build stored reads as before.
- **A Google Cloud project's candidates in their own words:** a managed candidate of a project the connection no longer reaches
is "out of scope: the Google Cloud connection was removed" (no offboarding proposed, as the manager can't offboard without
it) or, out of a connected perimeter, "out of scope: project no longer at the connection's scopes" (pending offboarding), decided
again when the connection comes or goes after the project left; a failed listing leaves its candidates as they were; a managed backend service gone reads "managed backend service not found in the last scan:
offboard it" (AWS's keeps "rule"). One rule, `brokenConnection`, tells a revoked federation in the router calls, the access check
and the scan; the workloads list joins a workload to its candidate by its backend service; an operation's title and step detail
read right for Google Cloud.
- **The dashboard and the documents name both clouds:** the rename dialog, the groups' grants, the Operations and Routers views
word their Google Cloud case (a Google Cloud workload's rename says nothing changes in Google Cloud). The README lists the actions
the manager sends the routers and names Google Cloud beside AWS; `docs/operations.md` says the organization's hibernation default
suspends Google Cloud VMs, `docs/access-control.md` the labels copied on Google Cloud, and the development organization stack
moved from `docs/organization-access.md` to `docs/development.md`.
- **The settings problem texts in one form:** an invalid setting is `<key>: must be a whole number from <min> to <max>` (or the
key's own rule: `wakeMode: must be any or browser`, `type: must be a type's name …`, `settings: fallbackInstanceTypes: must be a
list of at most 5 EC2 instance types, such as t3a.medium`), where some had no colon. `hibernate must be …` and `unknown setting <key>`
are as they were, which released CLIs match. A Google Cloud router's and workload's settings are checked as that router takes
them: the wake timeout from 60 to 1700 (`wakeTimeoutSeconds: must be a whole number from 60 to 1700`), the hold, the drain and
the holders left to the router, which says why they are 0 there; the organization's and the types' keep 60 to 3600.
- **Router 0.40.0, what changes in its API:** an action a router doesn't know answers AWS's `unsupported` refusal on a Google Cloud
router, as AWS's does. Its REST workload answer has `workloadId` and `pauses` beside `id` and `paused`, and its onboarding takes
`databases` and `settings.fallbackInstanceTypes` beside `cloudSql` and the top-level `fallbackInstanceTypes`. Its waiting page
answers `x-dormeto-failure` and `x-dormeto-retry-at` as AWS's does, and its status has AWS's six settings keys. **AWS's router
now refuses a `keepAsleep` that is not true or false** (a change to a released action: a value such as `"false"` or `1`, once taken
as it was, is a refusal now; the manager always sends a boolean). The router's own settings problem texts take the same
`<key>: must be …` form, and the Google Cloud wake timeout says 60 to 1700 in one text.
- **A Google Cloud router checks every workload in turn when its check runs out of time** (router 0.40.0, a fix): its check, which
starts 8 workloads at a time and none after 240 s, started at the first workload by id every time, so on a crowded router the workloads
late in id order were never checked: never napped by their idle window, a failed one never released, a stuck wake or nap never ended,
a URL map's drift never repaired. It now starts after the last workload the previous check started, as an AWS router's does
(`CheckBudgetReached`'s `next` names the first one left). Where it stopped is written in `router/check` as `cursor` right after the
check's workloads, a write made only when it moves (a check cut short, or the first to reach every workload after one that did not),
and again in the check's summary; it is absent once a check reached every workload. The `events` action's `check` holds it, and a
record holding only the cursor (a check whose summary was never written) is answered `{ "cursor", "checkedAt": null,
"lastScheduledCheckAt": null }`, which the manager's poll skips. Each check reads `router/check` once more, at its start. A cursor that
cannot be written is logged `CheckCursorNotStored`, and one that cannot be read `CheckCursorUnread`, on an AWS router too: that check
starts at the first workload.
- **An AWS router skips a workload offboarded while its check ran** (router 0.40.0, a change to a released behaviour): a workload whose
check fails because its offboarding removed it meanwhile is logged `CheckSkipped` (info, `{ workloadId, reason: 'offboarded' }`) and
answered `{ "workloadId", "skipped": "offboarded" }` in the check's results, as a Google Cloud router's is, instead of a `CheckFailed`
error line and `{ "workloadId", "error" }`; a workload still configured whose check fails stays a `CheckFailed`, and the check reads
its configuration once more to tell. `CheckSkipped` now says two things on AWS: the whole check skipped while the previous one still
runs (warn, `{ reason: 'previous check still running' }`, no `workloadId`), as before, and one workload offboarded under the check
(info, with its `workloadId`).
- **An AWS router shows a schedule it cannot read** (router 0.40.0, a change to a released answer): `status` answered a schedule whose
next events the router cannot compute as no schedule (`schedule: null`) when its time zone was one the runtime refuses, and failed for
any other error computing them, so the dashboard and `dormeto aws workloads schedule show` said "no schedule" for a workload that has
one. It is now answered as stored, with no `next` event and its own `joinMinutes`, and logged `ScheduleSkipped`, as a Google Cloud
router's is; the check still leaves such a schedule out, so its `maxNapDays` shows no maintenance wake due. A stored schedule that does
not parse, or whose time is none, is still answered as none. The dashboard's schedule card then shows the time zone, the windows, Edit
and Clear, and no next events; CLI 0.11.0 prints the schedule, with `unknown time zone "<zone>"; times in UTC` when its Go runtime
does not know the zone either.
- **AWS's router refuses the resume of a workload it does not know** (router 0.40.0, a change to a released action): `resume` with a
`workloadId` the router has no configuration for is refused `not_found` (`workload not configured: <id>`), as a Google Cloud router's
is, instead of answering `{ "resumed": false }`; the API answers it 404 `not_found` and audits the error, and `dormeto aws workloads
resume <router>/<id>` says `<router>/<id>: workload not configured: <id>` and exits 1 instead of "resumed". An exclusion's lift of such a
workload still answers `{ "resumed": false }`. An operator's pause left on a workload the router no longer knows (a Terraform destroy of
its workload module removes its configuration, not its pause; an offboarding removes both) cannot be resumed while it is unconfigured,
and holds the workload again if it is configured again.
- **A pause's `woken` lists the wakes it started or set** (router 0.40.0): an AWS router no longer lists a napping workload whose pending
wake was set before the pause, nor an asleep one whose wake another started first; a router pause's wakes put on its work queue still
count. A Google Cloud router's already did.
- **A Google Cloud router's `WakeRequested` and `PendingWake` log lines name who asked as `trigger: { kind, by }`** (router 0.40.0, a
change to its log lines), as an AWS router's lines and its own waker's do: router 0.37.0's carried the kind alone, as `reason`. `by`
is there when the manager or a pause names who asked. The `WakeRequested` a nap logs at its end for a pending wake keeps `reason:
'pendingWake'`, on both clouds.
- **Fixed, discovery of an AWS region whose CloudWatch fails:** a region whose CloudWatch request counts cannot be read (a
throttling, a refusal) is scanned all the same (a change to a released behaviour): the target groups of the batch CloudWatch failed
for keep their candidates' stored idle share (none for a candidate never read; the account's shares are read only then), and the
failure is logged `CloudWatchIdleFailed` (warn, `{ account, region, targetGroups, error }`, once a batch of 500 target groups), as a
Google Cloud project's candidates keep theirs when Monitoring fails (`GoogleIdleFailed`). Such a failure used to fail the region's
scan: its pair was recorded with the error (`DiscoveryPairFailed`), the run was partial, and the region's candidates stayed as they
were until a run CloudWatch answered (a new target group not listed, a removed one not marked gone, its hosts and tags not updated).
- **An AWS onboarding whose workload is FAILED fails at its `verify` step:** as a Google Cloud onboarding does (a change to a released
behaviour), `verify` refuses a workload the router's status says is `FAILED`, and the operation fails there with `verify: <name>
FAILED`, its locks and slots released, instead of succeeding. Its `candidate` step does not run, so the candidate stays eligible
until the next discovery run reads the router's rule; nothing is undone: the router keeps the workload it onboarded (Offboard
removes it), listed at the router's next check. A route that is not the application's, or an issue, fails `verify` as before
(`verify: route <route>, issues: …`; the route and the issues are said first: a FAILED workload still on the waker fails with
`verify: route waker`).
- **Fixed, a Google Cloud workload's 7-day bar:** its tooltip's requests line says `backend service`, as the rest of the dashboard
does, where it said `target group` (a workload's page and its Workloads row).
- **The dashboard's tables, one component:** Routers, Workloads, Discovery, Operations, Users, Audit, the IP lists and a workload's
History of changes share one table: a search field reading what the columns say (Workloads' sent to the API as before), sort on the
headers (Workloads and Discovery keep the API's order), pages of 25, 50, 100 or all rows (50 at first, all only up to 1,000 rows;
Workloads and the History 25 a page, Workloads without "all"; Discovery its Previous and Next along the API's cursor), and an Actions
column, last: each row's "⋮" opens that row's actions (a destructive one in red, a disabled one saying why in its tooltip), the
header's "⋮" the table's (a phone's, and a scrolling table's whose rows have no action, at the toolbar's end), with Export CSV and Export PDF; a page's search fields and menus are named by their table ("Search routers",
"Table actions: IP lists"). An export holds the rows of the search and filters in force, every page (Workloads and Discovery read the
API's pages one at a time, 5,000 rows at most; the CSV's last line and the PDF's heading lines say where it was cut or stopped), each
column in words (a status' word, dates as ISO 8601, money as a number with its currency in the column's title, `Saved (30 days, $)`,
a router's version with the upgrade offered), the Actions column left out: the CSV in UTF-8 with a byte order mark, a cell a
spreadsheet would run as a formula (`=`, `+`, `-`, `@`, a tab or a carriage return, a plain number aside) starting with `'`; the PDF in
A4 landscape with the view's title, the date with its time zone, the search and filters and page numbers, each column as wide as its
longest word (a wide table in a smaller font), no row split across two pages, made in the browser by jsPDF and jsPDF-AutoTable
(loaded when asked; a character its standard font cannot print shows as `?`, the PDF says how many). The files are named
`dormeto-<view>-<YYYY-MM-DD>.csv|pdf`. A table wider than its card scrolls sideways, keeping its Actions column in view at its end when its rows have
actions.
- **Statuses as their icons alone:** a workload's state, a pause, a router's health (and the Overview's routers card), an operation's
status and its steps', an audit result, a user's status and two-step verification, a discovery candidate's status, Discovery's last run
and an exclusion's (expired, lift incomplete), an IP list's last download, a backend's state, a workload's changes in its History and
a manager update's build show their icon in its color, no word beside it. The word is the icon's name for screen readers, the first
line of its tooltip (the mouse's or the keyboard's: every mark is focusable, but inside a link, which carries its word), and the
exports' text. Statuses that had no icon got one. A workload's header says "since 1 d ago" beside its state's icon, a router's Health
card "since 3 d ago" beside an open alert's bell, and a Google Cloud idle share is read "about 79 %" by a screen reader.
- **Routers:** the Workloads column shows one chip per state, its icon and `×N` (a click still opens those workloads), and the paused
ones as one more chip, the pause icon and `×N`, outlined (it opens nothing); the Health column the health's icon alone, a bell beside
it for an open alert and a muted cloud for a router that does not report (the Overview's routers card shows it too), the problems
with their levels, the alert's date, the error and why it does not report in its tooltip. Each row's "⋮" holds Pause… or Resume and
Uninstall…, opening the dialogs they did. A router's page shows the same marks, and its Health card each problem's level and an
unreachable router as icons.
- **Discovery:** the Idle column says a Google Cloud share is estimated by its `~` alone (no "estimated" beside it; its tooltip says
why), and the Region column a `global` candidate by the earth alone. The table has a search field: it reads every candidate of the
status within the filters (5,000 at most, said above the table and at an export's end when cut) and searches them as one list, read
again quietly every 30 s while an onboarding or offboarding runs. The selection is kept across pages and searches, and when an
operation ends; each candidate's actions are in its row's menu (Onboard…, Offboard, Exclude…, Dismiss… or Restore), acting on that
candidate alone, the rows ticked staying ticked. A dismissal or restore of more than 100 is sent 100 at a time (the API's most), one
request after the other; a batch refused says how many were done and leaves the others ticked. While a Run now is in progress the page
reads the run's state alone, and the list once when it ends, without the loader.
- **Operations as a table:** a row per operation (its kind and title, target and id, status, progress with the step running, who
started it and when), newest first, sorted on its headers; its steps open under the row with the error and a manager update's
CodeBuild link, the error also in the status' tooltip. A link to an operation (`/operations?id=…`, a toast's "Follow it in Operations")
opens it on the page that holds it, also while on Operations.
- **The demo (`npm run dev:mock`)** proxies nothing to the dev manager, and has a router that does not report and 53 candidates to
onboard (two pages).
- **Documentation:** the README (Google Cloud in "How it works" and the highlights), `docs/organization-access.md` (the host
  project, the two service accounts, the pool and provider, the scopes, what a disconnect leaves, discovery of projects and the command account's check) and `docs/operations.md`
  (onboarding, offboarding and exclusions on Google Cloud, the tag, the poll, the journal's 5 minutes, `too-old`, the refusals, the organization's push, what stays with the CLI).

## 0.22.0 — 2026-11-05

Router 0.37.0. Access: nothing to apply again (the access and organization modules, the AWS CLI script, the routers'
boundary and Kubernetes rights are unchanged).

The Overview's Savings card shows the last 30 days, this month and since the start as three figures, each over a few words,
without the hours asleep. The energy card says in one sentence how many workloads its estimate comes from; the method is in
the tooltip of an icon beside it. The Workloads page's figures read "saved in 30 days" and "a month", as does a workload's
monthly figure. A new window's Workload field shows each workload's service icons before its name. Every amount has three
significant digits, thousands as K and millions as M ($73.8, $951, $2.71K; an hourly price $0.0819).

A router's refusal (renaming a workload Terraform wrote, a workload offboarded meanwhile, a bad name, tags or pause) no
longer counts as a Lambda error in its health with routers 0.37.0 and later: the manager asks for refusals as answers.
The API answers a refusal it had no status for with 400, 404 or 409 instead of 502.

A workload onboarded from the manager shows in the Workloads view as soon as its onboarding ends, instead of at its
router's next check (routers 0.37.0 and later).

Workload settings at scale (routers 0.37.0): a workload's idle window, hold, drain, wake timeout, held requests, retry after a
failed wake and wake mode each come from the first level that sets them: the workload, its type, its router, the organization,
then the built-in value. Its no-wake and wake rules add up across the levels, the organization's first. A type is built in
(EC2 instance, Auto Scaling group, ECS, Kubernetes, or databases for a workload with RDS or Aurora, whose wake timeout is 30
minutes) or one of the organization's, picked on the workload or by its tags. The Routers page sets the organization's
defaults (Workload defaults, Settings) and the types (Workload types), a router's page its own, and a manager workload's page
its own and its type; each value says where it comes from, and a dialog says how many workloads follow a level before it is
saved. The idle window advisor's recommendation applies in one click. The Onboard dialog leaves the idle window and the wake
mode to the levels unless set. A workload written by Terraform keeps what its module sets: the module's settings are null by
default from router 0.37.0, which then follows the levels. No default is set at the upgrade, so no workload changes, but a
workload with databases whose configuration leaves its wake timeout to the levels waits up to 30 minutes instead of 10.

## 0.21.0 — 2026-11-03

Router 0.36.0. Access: nothing to apply again (the access and organization modules, the AWS CLI script, the routers'
boundary and Kubernetes rights are unchanged).

Every page takes the full width of the window (Update, Operations, Users, Account and Discovery's settings were capped), and
its title is one line, its section beside its name ("FLEET / Schedules"). What Routers and Discovery are, the IP lists, and
each workload default (Hibernate, Join windows, Ended windows) is said in the tooltip of an icon beside its title or name,
no longer in a paragraph under it. A page opened before an update loads the view a menu item leads to in full when that
view's files are gone, instead of the click doing nothing; in the demo (npm run dev:mock), a view's first visit no longer
reloads the page and drops the click. On
the Update page, Prepare and Confirm show a loading indicator from the click until the plan or the update ends. The waiting
page's title and description take Markdown, in the preview too (routers 0.36.0 and later draw it for visitors). A card's or
a dialog's title is centered on its icon.

The commands the dashboard's Update page and the docs tell you to run are `dormeto aws install` and the like
(`dormeto aws estimate`, `dormeto aws install status`): they need a CLI that has `aws`, which comes with the CLI after
0.8.0. The old names (`dormeto install`) go on working with that CLI, with a notice, until a later release removes them.

A schedule's window repeats on more than chosen weekdays (routers 0.36.0 and later): daily, weekly, monthly on a day or on
the first to fourth or last weekday, every N days, weeks or months, yearly, or by a cron expression (crontab's five fields,
minutes multiples of 5). It can have a start date and an end date, the end optional. A day past a month's end falls on the
month's last day. The window's editor says it back in a sentence and shows its next occurrences; the card and the calendars
read the same words. A cron expression starting every 15 minutes or less brings a warning: each start applies again, so a
manual Nap or Wake lasts until the next start, and an awake window blocks naps. A router before 0.36.0 refuses these windows
(`unknown field`), and the dialog says it needs that version; plain weekly windows go on working on any router. A calendar
draws at most 1,200 occurrences of a workload in a view, and says when it leaves some out.

"Do not repeat" is a new choice for a window: one date, written as a daily window from that date until that date. Drag an
item on the Schedules calendar, or its top or bottom edge (a handle shows on hover in the day and week views), to move it or
change its times. For a window that repeats, the dashboard asks on the drop: only this occurrence, or the whole series. The
series moves every occurrence by the same offset on the schedule's clock. This occurrence alone needs router 0.36.0 or later:
its date goes into the window's own dates without it (`exceptions` on a window, router 0.36.0), and a window of that one date
runs at the new times. The dialog says why a choice can't be made: a cron window's series starts by its expression, a series
whose occurrences a shift would not move alike, a window past 24 hours, a cron window starting twice that day. A bar of joined
windows moves both; its top edge changes the first, its bottom edge the last. Everything starts from a fresh read of the
schedule, and is put back on Cancel or a refusal. A window's own dates show in its tab of the Schedule dialog and in its
sentence ("except 4 Jan 2027"), and can be removed there. A schedule takes 100 windows (20 before router 0.36.0). Each save, move or clear of a schedule shows a notification naming the workload.
The dialogs' help moved to tooltips: what a schedule overrides, what wins over it, and drawn samples of the overlap rules. A
window shows its next occurrence, the next 5 in a tooltip. Calendar items have a real tooltip, titled by the workload's name and a chip of the window's kind with its sun or moon. In the Schedule dialog, each window's tab
starts with its sun or moon on a chip of its kind's color (awake green, nap blue, as on the Schedule card), the + buttons stay
beside the tabs however many there are (the tabs scroll; on a phone, the buttons are under them), the title highlights the workload
after its services' icons, and the maximum nap's hint is one line, its explanation in a tooltip. The Workload field of New window
autocompletes, and workloads are sorted by name.

Windows of one kind with a short gap read as one (routers 0.36.0 and later), so a workload is neither woken nor napped for the
gap. The gap is 15 minutes at most by default, 0 never joins. Set it at the organization (Workload defaults), the router (its
Configuration) or the workload (its schedule): the most specific wins, and routers read the organization's within 5 minutes. A
joined gap draws as one bar on the calendars, and the next occurrence and the card say the value in force. An older router does not join, and refuses a value. The organization's and the
router's routes (`PUT /api/settings/workloads`, `PUT /api/routers/{router}/settings`) take `joinMinutes` without `hibernate`,
and keep what a write does not send.

This applies to schedules already saved, at 15 minutes by default. The case to know: a daily nap 00:00–23:45 with `wake: never`
and no maximum nap has no gap left for a visitor to wake it. Set `joinMinutes` to 0 to keep a gap.

A `settings.json` that cannot be read is replaced only by a write naming `hibernate`: setting `joinMinutes` or the
organization's waiting page answers 409 and says why, so that an organization's hibernation off is not lost. Workload defaults
shows it. A drag compares the fresh schedule with the window as drawn, moves by the calendar's own days and time, and is put
back when it would change which occurrence a date without a window skips. A month cell's Do not repeat starts on the date
clicked. After a router's rollback, a save or a drag drops a stored `joinMinutes` the router no longer knows.

In a custom waiting page, `napUntil.at` and `napUntil.local` of the `dormeto:state` event can be null, for a nap with no end known.

The Schedule dialog is wider and puts each window in a tab, named by its kind's icon and its window in a few words, marked when
the window can't be saved. A window keeps its kind: the + buttons after the tabs add a nap or an awake window. The time zone,
the dates without a window and the maximum nap stay above the tabs, the join below them. A window's fields share rows, and its
next occurrence ends the row of its sentence. The join is offered from two windows, or for one window that comes back within
120 minutes, or a schedule with a value of its own. It reads "Override default join: windows of one kind up to N minutes apart",
the checkbox unchecked while it inherits and the minutes enabled once checked, the default in force beside it and what joining
does in a tooltip; the router's and the organization's dialogs read the same.

Windows that ended long ago leave their schedule (routers 0.36.0 and later): a router's check removes a window with no valid
occurrence within the last year and none to come (its pattern, range and dates without a window decide, not its end date alone),
and the dates without a window as old, the schedule's and each window's; a schedule left with
nothing is removed. Routers › Workload defaults › Ended windows sets the delay for the organization (`endedWindowDays` in
`settings.json`, `PUT /api/settings/workloads`): 0 keeps them, else 30 to 3650 days. A router removes nothing while it has never
read the settings (nor before it has read them once since its upgrade), never while a window is active, and never over a schedule
saved since its check read it.

The Schedules panel takes an organization of 1,000 workloads: past 100 rows it draws only those in sight, so a search, a tick or
"Scheduled only" answers at once, and it fills the height of the page. The demo takes `workloads=1000` in its scenario
(`?demo=dormeto,workloads=1000`).

A first tap on a tooltip no longer opens and closes it at once on a phone (a pause, a setting, a router's health, an
organization's access).

## 0.20.0 — 2026-11-01

Router 0.35.0. Access: nothing to apply again (the access and organization modules, the AWS CLI script, the routers'
boundary and Kubernetes rights are unchanged).

- Branded waiting page (router 0.35.0). While a workload wakes, its visitors see a page you set at three levels, each
  overriding the one above: the organization (Routers, beside Workload defaults), a router and a workload. A template
  takes an icon, a title and a description, field by field; the dashboard previews it in each state (waking, taking
  longer, failed, nap window), in English or French, light or dark. Routers read the organization's page directly, so a
  change at any level reaches visitors within about a minute. A custom HTML page, uploaded as a file, replaces the
  template; it runs on the application's own address, so only administrators can set, replace or clear one (operators
  can still set a workload's template), and the dashboard only draws one in the edit dialog's preview, never in a
  card. Viewers and members who may read a workload read its page, never change it. The icon is the application's
  favicon by default: the router reads it just before a nap, at most once a day. `icon: none` turns the read off for the
  level's scope (every workload at the organization, a router's workloads, one workload), except where a lower level
  says `auto`. A
  workload written in Terraform is changed with `waiting_page` in its workload module (a page the manager set before
  the workload moved to Terraform can be reset from the dashboard). Visitors read their own language, and the page shows
  a progress bar from the workload's recent wake times.
  Access: nothing to apply again. Upgrade the routers to 0.35.0 (a router before it answers that it must be upgraded).
- The Onboard dialog gives the lines a Terraform that writes the workload's resources must keep: the AWS provider's
  `ignore_tags` for `dormeto:`, `ignore_changes = [action]` on a rule Dormeto changes in place, and the backend's own fields.
  Without them every apply removes what onboarding added, until the router repairs it. It also says that a rule Dormeto
  cannot cover, such as one that acts before its forward, gets the waker itself, and that the operation's steps name it.

## 0.19.0 — 2026-10-24

Router 0.33.0. Access: apply the access module (or the organization configuration) or the AWS CLI script of this release
again in every member account, before upgrading its routers: DmtRouterBoundary gains the network-interface rights of the
Kubernetes proxies' role, DmtCommandRole the EC2 rights for the proxies' security groups, the ingress rules on the EKS
cluster security groups (tagged aws:eks:cluster-name) and the reading of the routers' functions' tags (lambda:ListTags),
and DmtDiscoveryRole may invoke the proxies.

- Private EKS endpoints. A cluster whose Kubernetes endpoint is private, or public but limited to some addresses with
  private access on, is now eligible: Dormeto reaches it through a small proxy function in the cluster's VPC, one per
  cluster (`<router>-kube-<cluster>`), which forwards the calls to the endpoint and nothing else. A cluster whose public
  endpoint is open to every address keeps direct calls. A cluster with private access off and a public endpoint limited
  to some addresses stays ineligible: turn on private access. The manager creates, updates and removes the proxies of
  the routers it installs, in a `kubernetes proxies` step of the router's install, upgrade, onboarding and cluster
  access operations (and `remove kubernetes proxies` at uninstall); apply the access again, then upgrade the routers. In
  an account whose access was not applied again, installs and upgrades go on without the proxies, saying "apply the
  organization access of manager <version>" (the version running), while an onboarding that needs a proxy fails with it.
  A router written in Terraform gets its proxies from the router repository's module `kubernetes-proxy`, one instance
  per cluster beside `eks-access`. Discovery reads such clusters through the proxy and says why one is not eligible (no
  router in the account and region, a router without its proxy, or private access off); the router's page and `GET
  /api/routers/{router}` say for each cluster "directly" or "through its proxy <name> (<version>)". The proxy costs
  Lambda invocations only (a few cents a month): no NAT gateway, no VPC endpoint.
- EC2 hibernation. A nap hibernates a standalone EC2 instance that was launched with hibernation, instead of stopping
  it, so it wakes with its memory and processes as they were. It is on by default: an instance launched without
  hibernation, or one AWS refuses to hibernate, is stopped as before, so no nap fails. The most specific setting wins:
  the workload, then the router, then the manager's default (Routers › Workload defaults, on when never set). A
  workload with fallback instance types does not hibernate unless its own setting says on, because a hibernated
  instance cannot change type. A workload hibernated for 59 days is woken for maintenance, and the nap after that wake
  stops the instance, since AWS keeps a hibernation 60 days at most; a pause that keeps the workload asleep holds that
  wake, as it holds a schedule's maintenance wake. The workload's and the router's pages show the setting, where it
  comes from and which instances can hibernate; the history shows "hibernated N instances". The onboard dialog has a
  Hibernate choice (Inherit, On, Off). New API routes (and the same under `/iam/`): `GET|PUT /api/settings/workloads`
  (administrators write), `PUT /api/routers/{router}/settings` (administrators) and
  `PUT /api/workloads/{router}/{id}/settings` (operators and administrators; refused for a workload written by
  Terraform, whose module has the `hibernate` variable). A router before 0.32.0 answers 409 "upgrade the router to
  0.32.0" on the two settings routes, and an onboarding with Hibernate on such a router is refused with a 409 that
  says so. Upgrade the routers to 0.32.0; set Hibernate off in Routers › Workload defaults first if instances launched
  with hibernation must keep stopping. A router just upgraded stops its instances plainly until it has read the
  manager's settings (within 5 minutes; its health warns while its reads fail), so an administrator's off holds from
  the first nap. A router written in Terraform without `ip_lists_catalog` reads no manager settings and ignores the
  manager's default (built-in default on): set its own Hibernate on its page instead. The manager's API role gains read
  and write on `settings.json` of the lists bucket (the manager's own Terraform, applied by the update).
- Descriptions of routers and workloads: an optional Markdown text (up to 4,000 characters) for people. Administrators
  write a router's, operators and administrators a workload's. It shows in a Description card on the router's and the
  workload's page, read even while the router cannot be reached, and as one line under the name in the Routers and
  Workloads lists. `PUT|DELETE /api/workloads/{router}/{id}/description` and `PUT|DELETE
  /api/routers/{router}/description`; `GET` of the same routes answers `{description}` from the manager alone; the
  details (`GET /api/workloads/{router}/{id}`, `GET /api/routers/{router}`) carry `description` (null without one) and
  the rows of `GET /api/workloads` and `GET /api/routers` a one-line `summary` (all under `/iam/` too).
- Fix: a dashboard test no longer depends on the real date.

## 0.18.0 — 2026-10-21

Router 0.31.0. Access: nothing to apply again (the access and organization modules, the AWS CLI script, the routers'
boundary and Kubernetes rights are unchanged).

- The last enabled administrator can no longer be demoted or disabled: the API answers 409 "the last administrator: give
  the admin role to another user first", whoever asks. A caller signed with AWS credentials
  (the CLI) is never "yourself", so this guard is what stops it from removing the last administrator.

## 0.17.1 — 2026-10-20

Router 0.31.0. Access: nothing to apply again (the access and organization modules, the AWS CLI script, the routers'
boundary and Kubernetes rights are unchanged).

- The Pause dialog said a paused workload "is napped while paused": it now says it is not napped, and, for a router,
  that none of its workloads is napped.
- The Schedules view's New window dialog shows its Workload field's label whole; it was cut off at the top.

## 0.17.0 — 2026-10-20

Router 0.31.0. Access: nothing to apply again (the access and organization modules, the AWS CLI script, the routers'
boundary and Kubernetes rights are unchanged).

- Schedules view in the dashboard (the Schedules item under Fleet): the windows of enabled workloads as Day, Work week,
  Week and Month calendars. A calendars panel lists workloads with a search and a "Scheduled only" filter; up to 20 can
  be enabled, each with its color, and the choice is kept per user in the browser. Awake windows are filled, nap windows
  outlined, and a marker shows the maintenance wake of a maximum nap. Dragging over a range, or the New window button,
  creates a weekly window for one workload the user may edit, saved through `PUT …/schedule`; clicking a window opens
  the workload's Schedule dialog. The view reads each enabled workload's schedule, so routers before 0.31.0 show none.
- The Schedule dialog, on the workload page and from the calendar, has "Clear schedule" (confirmed), and removing
  every window with no maximum nap clears the schedule.

## 0.16.0 — 2026-10-19

Router 0.31.0. Access: nothing to apply again (the access and organization modules, the AWS CLI script, the routers'
boundary and Kubernetes rights are unchanged).

Upgrade the routers to 0.31.0 for schedules (a router before 0.31.0 answers a schedule change with a 409 and reports
none; its check stays on `rate(5 minutes)` until upgraded). Routers the manager installs or upgrades get the check on
the clock's 5-minute marks, and the dashboard reads `cron(0/N * * * ? *)` check schedules.

- Workload schedules (R12): weekly awake and nap windows in a time zone, exception dates (dates the weekly windows skip),
  and a maximum nap (1 to 60 days) after which the workload is woken for maintenance. The router applies them at its
  check, now on the clock's 5-minute marks (`cron(0/5 * * * ? *)`). Set and cleared from the Schedule card of the
  workload's page (an Edit dialog with window rows, weekday chips, 5-minute times and the zone, defaulting to the
  browser's), or with `PUT` and `DELETE /api/workloads/{router}/{id}/schedule` (and the same under `/iam/`), allowed to
  whoever may both wake and nap the workload and audited as `schedule` and `schedule-clear`; the router's problems come
  back as a 400. The workload's status carries `schedule`, the next events and the maintenance due date; workload rows
  carry `scheduled`.
- The timeline names the new causes, `schedule` and `maintenance`, and the Workloads list shows a calendar icon on
  scheduled workloads.

## 0.15.0 — 2026-10-19

Router 0.30.0. Access: nothing to apply again (the access and organization modules, the AWS CLI script, the routers'
boundary and Kubernetes rights are unchanged).

- IAM routes for the CLI (`dormeto routers list|upgrade`, `dormeto workloads list`, CLI 0.4.0): `ANY /iam/{proxy+}`
  (`AWS_IAM`) on the same API, handled as `/api/...` with an administrator identity named by the caller's ARN, outside the
  MFA policy; a request without an IAM identity answers 401. Only the principals of the manager's account allowed
  `execute-api:Invoke` on the new `api_iam_arn` output can call them. `/api/*` and its Cognito authorizer are unchanged.

## 0.14.0 — 2026-10-19

Router 0.30.0. Access: nothing to apply again (the access and organization modules, the AWS CLI script, the routers'
boundary and Kubernetes rights are unchanged).

Router 0.30.0. Access: nothing to apply again; upgrade the routers to 0.30.0 for their workloads' tags (a router before
0.30.0 reports none: its workloads are seen only by the built-in roles and by grants on every workload).

- Workload tags (R11): Dormeto's own labels (`team=payments`), at most 50 per workload, `dormeto:` reserved, kept by the
  router. Administrators set them at onboarding (the dialog can copy the target group's AWS tags on request; nothing is
  copied otherwise) and from the workload's page (`PUT /api/workloads/:router/:id/tags`, audited); a Terraform workload's
  are its module's `tags`. The Workloads list gains a Tags column and a tag filter (`?tag=key=value`, repeatable).
- Groups and grants (R11): custom groups, created and deleted by administrators in the Users view (`GET` and `POST
  /api/groups`, `PUT` and `DELETE /api/groups/:name`, `PUT /api/users/:email/groups`), each with up to 20 grants (a tag
  selector and `read`, `wake` or `nap`; `wake` and `nap` imply `read`; no tag means every workload). Groups are Cognito
  groups of the user pool, their grants are kept in the manager's table; the API's role gains `cognito-idp:CreateGroup`,
  `DeleteGroup`, `UpdateGroup`, `ListGroups` and `AdminListGroupsForUser`. Group membership applies at the user's next
  token (within an hour), grants within a minute, retags at once.
- Members (R11): a user in no built-in group is a member and sees the workloads their groups' grants give, in lists,
  counts, savings, alerts, operations, history and idle windows, and nothing else of the fleet; the dashboard hides
  Routers, Discovery, Operations and the administration pages from them. Invitations take `role` `member` and `groups`.
- Enforcement (R11): every workload route checks the caller's grants; a workload they cannot read is a 404, one they can
  read without the permission a 403. Workload payloads carry `tags` and `can: { wake, nap }`; `GET /api/me` carries
  `groups` and the effective `grants`; the dashboard shows only the actions allowed. A pause that wakes a workload also
  needs `wake`. Under the `operators` MFA mode, a grant giving `wake` or `nap` needs a multi-factor session, like the
  operator role.
- Audit (R11): refused workload actions are audited with `result: refused` and the reason, and every entry records the
  caller's groups.
- Documentation: [Access control](docs/access-control.md).
- Upgrade note: before 0.14.0 a user in no built-in group was a viewer; they are now a member and see nothing until a group
  grants them access. Users invited through the dashboard always have a built-in group; add any user created by hand in
  Cognito to `dmt-viewer` or to a custom group.
- Review fixes (R11): tags at onboarding need an administrator (403 for operators, audited; the dialog hides the Tags section
  from them), and an onboarding with tags fails on a router before 0.30.0; the API returns `tags` only when the router reports
  them and the workload's page says "Tags unknown"; Edit tags only on manager workloads; members see router names as text, no
  Routers list or map on the Overview; the tag filter takes `key=value` only (splits at the first `=`), encodes values with
  `%20`, and its chips are keyboard-reachable; the Users page says when the groups cannot be read. With `passkeys = false`
  (or `mfa = required`) the user pool's `sign_in_policy` is written with `PASSWORD` alone, so turning passkeys off reverts a
  pool that allowed them (an in-place update).
- Passkeys, in the `optional` and `operators` MFA modes. The module's new `passkeys` variable (true by default; not
  offered with `mfa = required`, where Cognito enforces the authenticator app) turns on choice-based sign-in: the user
  pool's `sign_in_policy` allows `PASSWORD` and `WEB_AUTHN`, its `web_authn_configuration` requires user verification (the
  relying party is the auth domain when the module has a custom domain), and the dashboard client gains `ALLOW_USER_AUTH`
  and the `/account` callback. Both pool blocks update in place; the user pool is not replaced. The dashboard asks for
  `acr_values=urn:cognito:loa:1`, so that the ID token carries `amr`; the API counts a session as multi-factor when `amr`
  holds `mfa`, `swk` or `hwk` (a password-only session of an enrolled operator is a viewer's), and falls back to the
  authenticator check for a token without `amr`. `GET /api/me`'s `mfa` gains `method` (`passkey`, `app`, `password` or
  `null`) and `passkeys`. The Account page has a Passkeys card (list, add through managed login, remove) and the sign-in
  method of the session; the MFA banner offers a passkey. With an authenticator app on, Cognito does not allow passkey
  sign-in: in the `optional` mode the user turns the app off once a passkey is registered; in `operators`, an
  administrator's reset moves them to passkeys (a password alone could otherwise register a passkey). An administrator cannot remove a passkey (Users says so).
  The dashboard asks for `acr_values` and the API reads `amr` only with passkeys on. Access: nothing to apply again.
- A daily check for new manager versions, off until an administrator turns it on in the Update page's "Daily check" card.
  A function (`<name>-update-check`, with its role and an EventBridge schedule at 07:00 UTC) reads the setting, then the
  release index, and records the newest version above the running one. Administrators see a notice on the Overview
  (dismissed per version, kept in their preferences); when chosen, the version is also sent once to the alert topic
  (attributes `kind = update`, `level = info`, a new level that the `warning` and `error` filter policies do not receive).
  New routes `GET` and `PUT /api/update/check` (administrators, the change audited); `PUT /api/preferences` accepts
  `dismissedUpdate`. The module gains the function, its log group, role, scheduler role and schedule; the release
  carries `lambda/update-check.zip`.

## 0.13.0 — 2026-10-18

Router 0.29.0. Access: nothing to apply again (the access and organization modules, the AWS CLI script, the routers'
boundary and Kubernetes rights are unchanged).

- The dashboard's sidebar shows the manager's version at its bottom, and the brand mark and favicon are the website's
  logo. The Operations icon is two meshing cogs, each turning on its own axis.
- The Update page shows the CLI's commands for this install (installing the CLI, updating from a laptop with this
  install's region and environment, following the install), with copy buttons, links to the CLI and the manager on
  GitHub and to the CLI's documentation, and a "Check for updates" action with the time of the last check. `GET
  /api/update` gains the install's `env` and `region`.

## 0.12.0 — 2026-10-18

Router 0.29.0. Access: nothing to apply again (the access and organization modules, the AWS CLI script, the routers'
boundary and Kubernetes rights are unchanged).

- The dashboard's redesign, in the website's design: night and light themes (the system's until the user chooses one in
  the top bar), the Dormeto fonts and animated icon (loaders, the navigation's own icons), every view restyled. The
  Overview shows the fleet live (the icons of its first 96 workloads by router, each router's count, "+N more" to its
  workloads) and the energy the naps did not use, with its carbon (below).
- A demo mode, for development only: `npm run dev:mock -w @dormeto/manager-dashboard` answers the API, the sign-in and
  Cognito in the browser from a generated organization (`?demo=acme,workloads=60,routers=5`, see `src/mock/scenario.ts`).
  A build refuses `VITE_MOCK`, and the release refuses a dashboard holding the demo.
- `GET /api/workloads/states` and each workload's figures (a Workloads row with `states=1`, a workload's view) gain
  `energy`: the kWh and kg CO2e its naps did not use over the last 30 days, an estimate from what each last nap stopped
  over the hours asleep within the savings baseline, with Cloud Carbon Footprint's coefficients for AWS and each
  region's grid intensity (docs/savings.md). With prices only; the Overview's energy card reads it.
- The dashboard's Update page, for administrators of a manager installed with `dormeto install` 0.2.0 or later: it
  shows the version running and the newer published versions with their release notes; an administrator prepares an
  update (the plan of what changes), confirms it, and follows its progress until the new version answers.
- The menu's Update entry shows administrators how many versions the manager can be updated to
  (`GET /api/update/available`). Each request of the Update page is an operation, "Manager update", in the Operations
  list of administrators only, that ends with its build. The page's build and the operation link to the build in the
  CodeBuild console.
- The manager module's new optional `install` input (`bucket`, `project`, `log_group`), set by `dormeto install`: leave
  it unset otherwise. When set, the API gains rights on the install bucket (requests, results, plans and the release's
  files), on the install CodeBuild project and on its logs.
- Each publication writes `manager/versions.json` beside `latest.json`: the published versions, newest first, with their
  router, the oldest CLI whose install they can update, and their date. The Update page reads it.

## 0.11.0 — 2026-10-17

Router 0.29.0. Access: nothing to apply again (the access and organization modules and the AWS CLI script are
unchanged).

- The manager module's `organization_id` is optional, for `dormeto install`'s account deployment (a manager in an account
  outside any organization): without it the manager assumes the discovery and command roles, and accepts the routers'
  events and lists, within its own account only. The new `discovery_mode` input (`organization` by default, or
  `account`, required without an organization) is the mode of the discovery perimeter's default configuration, the one an
  administrator has not saved yet (`DISCOVERY_MODE` of the API and of discovery).
- The savings estimate before install is now the Dormeto CLI (https://github.com/Dormeto/cli, 0.1.0 on 2026-10-13:
  Homebrew, the install script, `go install`, and the release's zip on Windows): `dormeto estimate --profile <profile>`.
  The repository's `npm run estimate` and `packages/estimate`, never released, are removed.
- The release script's `--version` and `--out` build a release locally, before it is published (the changelog's Unreleased
  section stands for a version without its own); `--publish` stays for the package's version.

## 0.10.0 — 2026-10-11

Router 0.29.0. Access: apply the access module or the AWS CLI script of this release again in every member account:
`DmtDiscoveryRole` reads the EKS clusters (`eks:ListClusters`, `eks:DescribeCluster`) and the instances behind a target
group (`ec2:DescribeInstances`: a cluster's nodes are never offered to nap); `DmtCommandRole` manages the
routers' EKS access entries (statements `EksClusters`, `EksAccessEntries`, `EksAccessEntriesDiscovery`,
`EksAccessEntriesRemoved`, `EksDiscoveryView`: the routers' roles in the Kubernetes group `dormeto:router` and
`DmtDiscoveryRole` with `AmazonEKSViewPolicy`, in no group, nothing else); the routers' permissions boundary allows `eks:DescribeCluster`. Then upgrade the routers to 0.29.0 (the upgrade
makes the access entries in the account and region's clusters) and apply `dormeto-kubernetes-0.10.0.yaml` of the release
in each cluster whose workloads Dormeto should nap (`kubectl apply -f`). Without them nothing changes for the other
workloads: a router upgraded first skips its access entries and says what to apply, and Kubernetes candidates are not
onboardable, with the reason.

- Kubernetes workloads on Amazon EKS: a target group of the AWS Load Balancer Controller (from an Ingress or a
  TargetGroupBinding) serving the pods of one Deployment or StatefulSet is napped by scaling it to 0 and woken by giving
  back its replicas (routers 0.29.0). A KEDA ScaledObject is paused for the nap; an HPA needs nothing. The cluster's API
  endpoint must be public and open to every address (private clusters wait for the in-cluster agent).
- Discovery reads the clusters of each account and region and traces each Kubernetes target group to its owner (pods by
  address, the ReplicaSet, the Deployment or StatefulSet), with its Ingress or TargetGroupBinding, HPA, KEDA
  ScaledObject, GitOps owner (Argo CD, Flux), capacity (Fargate or nodes) and node autoscaler (Karpenter, Cluster
  Autoscaler). Ineligible, with the reason: a private endpoint, pods of several owners, pods of a DaemonSet or a Job, a
  ScaledObject that already scales to zero, access missing. A cluster's nodes behind an instance target group (a
  NodePort Service, a TargetGroupBinding in instance mode) and a node group's Auto Scaling group are never offered as
  instances or a group to nap.
- Installing or upgrading a router makes the access entries of its roles in the clusters of its account and region,
  and asks the router what it may do there (the router's view lists the clusters, their reach and the rights missing);
  a cluster on `aws-auth` only, or one the router cannot reach, is left with the procedure. Removing a router deletes
  its roles' entries (EKS keeps an entry whose role is gone, and it does not work for a router installed again).
- Onboarding a Kubernetes workload adds Dormeto's Ingress to the customer's IngressGroup (the customer's Ingress is never
  changed), or patches a lone Ingress (restored exactly at offboarding), or instruments a TargetGroupBinding's rules as
  any other; the dialog says which, gives the Argo CD or Flux snippet when a GitOps owner was found, and the access
  check's result. Its wake timeout defaults to 5 minutes (pods may wait for a node).
- Savings: Fargate pods are priced as Fargate; pods on EC2 nodes as their share of their node's price (the larger of
  their CPU and memory requests over the node's allocatable, Spot as Spot, the compute discount applied), only where a
  node autoscaler removes the nodes they free ("nothing saved: the nodes stay" otherwise). The control plane and the
  nodes' DaemonSets are not saved; pods without requests are not priced.
- The release carries `dormeto-kubernetes-<version>.yaml`: the rights of the group `dormeto:router` (a ClusterRole with
  exactly what the router checks, its binding, and an admission policy keeping the group's Ingress creations and
  deletions to Dormeto's own, Kubernetes 1.30 or later).

## 0.9.0 — 2026-10-10

Router 0.28.1. Access: nothing to apply again in the member accounts; the manager's own IAM changes with its module (the
API may invoke the discovery function). 0.8.1 was not published: its change ships in this version. Upgrade the routers
to 0.28.1.

- The Idle window card on each workload's page: its last 14 days of requests replayed against idle windows from 5 to
  120 minutes (and its own), each window's estimated savings a month, wakes and visitors' wait a day, and a
  recommendation: the shortest window that already avoids 90% of the wakes the longest one avoids. Every request counts
  (the requests the waker ignores are not known per minute): the card compares the replay with the real wakes and says
  when it counts clearly more. Read through the discovery role, kept a day.
- Every AWS call of the routers is bounded (router 0.28.1): connected within 3 seconds, answered within 10 seconds of
  silence, else retried on a new connection. The AWS SDK waits forever by default: a scheduled check could wait 15
  minutes for an answer that never came, its lease skipping the next three checks.

## 0.8.1 — 2026-10-09 (not published: in 0.9.0)

Router 0.28.1. Access: nothing to apply again.

- Every AWS call of the routers is bounded: connected within 3 seconds, answered within 10 seconds of silence, else
  retried on a new connection. The AWS SDK waits forever by default: a scheduled check could wait 15 minutes for an
  answer that never came (its function ending at its timeout, in the controller's failure queue), its lease skipping the
  next three checks. Upgrade the routers to 0.28.1.

## 0.8.0 — 2026-10-09

Router 0.28.0. Access: as 0.7.0, which was not published (its Access note and changes below ship in this version): apply
the access module or the AWS CLI script of this release again in every member account. Router 0.28.0 itself needs
nothing more (it reads only what it already describes); the manager's module adds `ec2:DescribeSpotPriceHistory` to its
API and savings job. Then upgrade the routers to 0.28.0: older routers' Spot capacity stays priced on-demand.

- Spot at Spot prices: routers 0.28.0 say what ran on Spot (an instance's Spot lifecycle, a Fargate service's share on
  Fargate Spot from its capacity provider strategy); EC2 Spot is priced from the region's Spot price history (the
  zones' latest averaged, cached a day), Fargate Spot at 30% of on-demand (AWS publishes no Fargate Spot price; its
  largest announced discount gives the smallest saving).
- Discounts for commitments: administrators set on the Savings card what Savings Plans, Reserved Instances or an AWS
  agreement take off the list prices, for compute (EC2, Fargate) and databases (RDS, Aurora), as an average rate; never
  off Spot; audited. A change applies from the next day computed (the card says so) and to the workload figures within
  their cache.
- Spot items say so ("2 × t3.medium (Linux, Spot)"); the 7-day bars', the backends' and the History card's estimates
  say when they are after discounts.
- A Fargate service whose capacity provider strategy mixes Fargate and EC2 capacity counts only its Fargate share
  (routers 0.27.0 counted its whole desired count): its estimate drops after the upgrade.

## 0.7.0 — 2026-10-08 (not published: in 0.8.0)

Router 0.27.0. Access: apply the access module or the AWS CLI script of this release again in every member account (the
routers' permissions boundary allows `ecs:DescribeTaskDefinition`, the size of a Fargate service; without it a Fargate
service is not priced), which also brings 0.5.0's `ec2:ModifyInstanceAttribute`. Then upgrade the routers to 0.27.0.
0.5.0 and 0.6.0 were not published: their changes below ship in this version.

- Savings, estimated: what each nap stopped (EC2 instances and Auto Scaling capacity by type, Fargate tasks by size, RDS
  and Aurora by class, Aurora Serverless v2 at its minimum) priced at AWS's on-demand list prices (the Price List API,
  cached), for the time asleep that the baseline would have run (`savings_baseline`: `always`, or `business-hours` in
  `savings_timezone`). A daily job (00:30 UTC) sums each workload's day; the Overview's Savings card shows the last 30
  days, this month and since the start, net of Dormeto's own estimated cost, and the top workloads; the History card
  gives its period's estimate. Storage, load balancers and data transfer are not counted; discounts are not known.
- Routers 0.27.0 say what each nap stopped.
- Workloads: a bar of each workload's time in each state over the last 7 days, from its history, on the Workloads list
  (instead of the idle share) and in the workload's header; its tooltip gives each state's share, time and meaning, the
  time without history, the hours without requests, what the naps saved in the last 30 days and a month's saving at that
  rate. The Workloads view's header has the same bar for all workloads, from each workload's figures kept an hour
  (`states_cache_minutes`). Napping has a color of its own, the same in the state chip, the history and the bar. The workload's actions are
  in one menu; each backend and target has its id, ARN and service in a tooltip, a backend its list price an hour and a
  month and its saving a month. A router written in Terraform shows a chip saying where it is changed; one the manager
  installed shows none.
- Audit: a long action or target is cut on one line, its full text in a tooltip.

## 0.6.0 — 2026-10-08 (not published: in 0.7.0)

Router 0.26.0. Access: as 0.5.0 (0.5.0 was not published: its Access note and changes below ship in this version). Then
upgrade the routers to 0.26.0; older routers' history is kept too, dated less exactly when an event is lost.

- State history: every state change of every workload is kept (`history_days`, 400 days by default), from the events
  the routers send; a lost event is made good from the next check, and the history starts when the manager first sees a
  workload (for those already known, at the upgrade).
- The workload view's History card: over 24 hours, 7 or 30 days, the asleep share, the awake time and the wakes (median
  and longest), a row per day of the phases, what started each one (a request, the idle check, a manager user, a
  failure), and the transitions.
- Routers 0.26.0 date each state change and say who asked a nap or a wake from the manager.
- Routers have their own view, reached from Routers (no row expands any more), Workloads, the workload view, the Overview
  and alerts: version and upgrade, health and alert, workloads by state, pauses, figures, and the configuration with
  where each setting is changed. A router installed by the manager no longer shows its configuration as Terraform's.
- The IP lists panel says what the lists are and what defer and ignore do.

## 0.5.0 — 2026-10-08 (not published: in 0.6.0)

Router 0.25.0. Access: apply the access module or the AWS CLI script of this release again in every member account (the
routers' permissions boundary allows `ec2:ModifyInstanceAttribute`, for fallback instance types; from 0.3.0, it also
allows reading the account's Cognito user pool clients, as 0.4.0 said). Then upgrade the routers to 0.25.0. 0.4.0 was not
published: its changes and upgrade note below ship in this version.

- Failed wakes say why: the router records the kind (no capacity, quota, permission, configuration, no healthy target,
  throttled, timeout, unknown), the step and backend that failed and AWS's message. It reads the Auto Scaling activities
  and ECS service events while it waits, so that a launch that cannot happen fails at once instead of at the wake timeout.
- Capacity: a start refused for capacity is tried again within the wake timeout (after 30 s, 60 s, then every 2 minutes).
  An EC2 instance can fall back to other instance types (`fallback_instance_types` of the workload module, or the
  onboarding dialog); the next nap gives it its own type back.
- Between failed wakes, requests retry after `failed_retry_seconds` (60 s by default), doubled after each failure, at
  most 30 minutes; a wake from the manager does not wait. A failed workload whose backends run without a healthy target
  is stopped after its idle window, so a failure does not run up the bill. The waiting page says what happened and when
  the next attempt is.
- Alerts: each failed wake is an alert of the watchdog within 5 minutes (one per kind across retries, "woke again" when it
  wakes), with the workload, its account and region, the backend, AWS's message, the next attempt and what to do. Each
  message has a chat body for Amazon Q Developer in chat applications (Slack, Microsoft Teams) on `https` subscriptions,
  and the attributes `level`, `kind`, `account`, `region`, `router` and `workload` for subscription filter policies.
- The workload view shows the last failure, the failures in a row, the next attempt and the fallback types in use; the
  state chip's tooltip has the last failure; the Alerts card links to the workload.

## 0.4.0 — 2026-10-08 (not published: in 0.5.0)

Router 0.24.0. Access: apply the access module or the AWS CLI script of this release again in every member account (from
0.3.1, which was not published: the routers' permissions boundary allows reading the account's Cognito user pool clients).
Then upgrade the routers to 0.24.0. 0.3.1's changes below ship in this version.

Upgrade note: `mfa` is `operators` by default, so after the upgrade every administrator and operator acts as a viewer
until they set up an authenticator app from the Account page (sessions opened before the upgrade sign in again first).
Set `mfa = "optional"` to keep today's behavior, and keep at least two administrators with an authenticator: the last one
who loses theirs is reset with the AWS CLI (the README's Lost authenticator).

- Health alerts: every 5 minutes the manager's watchdog checks what each router reports. A router that stops reporting
  (its idle check stopped, as a broken schedule does), or reports a problem, opens an alert sent to the addresses of
  `alert_emails` and to any subscription of the `alerts_topic_arn` topic, and its resolution. A problem that comes back
  within 6 hours is not sent again; a burst sends 10 messages and a digest. CloudWatch alarms watch the watchdog, the
  router events not stored and the list function. The Overview lists the open alerts (instead of a banner per late
  router), Routers dates them.
- IP lists from the manager (`ip_lists`): downloaded once for every router, hourly at each list's refresh period, checked
  (a version that lost more than half its entries is refused; change the URL to accept it), and published to a bucket the
  organization's routers read. Routers 0.24.0 read them every 5 minutes, only what changed, the data checked against its
  SHA-256; a catalog change reaches them without an upgrade; nothing goes to the router table. Installed routers get them
  on their own, a router written in Terraform with `ip_lists_catalog` (output `ip_lists_catalog`). Routers shows them; the
  watchdog alarms on a list that failed or grew old.
- Two-step verification (`mfa`, `operators` by default): administrators and operators set up an authenticator app from
  the Account page, and keep viewer rights until they do; `optional` or `required` for everyone otherwise. Users shows
  who has it, and an administrator resets another user's lost authenticator (audited).
- Router health no longer blames infrastructure as code for every drift repair; each of its problems carries a stable
  code.

## 0.3.1 — 2026-10-07 (not published: in 0.4.0)

Router 0.23.3. Access: apply the access module or the AWS CLI script of this release again in every member account (the
routers' permissions boundary allows reading the account's Cognito user pool clients, which ELB requires to change a rule
that authenticates with Amazon Cognito).

- A workload behind a rule that authenticates with Amazon Cognito can be onboarded, napped and woken: upgrade its router
  to 0.23.3. Until the access module or script is applied again in its account, onboarding there says so.
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
- Workloads: the AWS account first; the kinds of each workload's backends as icons (routers 0.23.3); its idle share over
  7 days, as in Discovery.
- The views take the whole width of the window.
- A workload's state shows with an icon and a tooltip saying what it means, dated from when it began (Awake since, Asleep
  since…), not from its last write; Routers names its Actions column and cuts a long health problem short.
- Routers: a router written in Terraform with an older version says that a newer one is available, upgraded by applying
  its Terraform.
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
