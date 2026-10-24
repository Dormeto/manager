# Changelog

Versions of the Dormeto manager, each with the router version it installs. Releases:
https://releases.dormeto.com/manager/ (install: https://dormeto.com/get-started.html). An **Access** line says when the
member accounts' roles or the delegation policy must be applied again (the access and organization modules, or the AWS
CLI script, of the same release).

## Unreleased

Router 0.33.0. Access: apply the member accounts' access again (the access and organization modules, or the AWS CLI
script, of the same release) before the routers there are upgraded: `DmtRouterBoundary` gains the network-interface
rights of the proxies' role, `DmtCommandRole` the EC2 rights for the proxies' security groups, the authorization and
revocation of ingress rules on the EKS cluster security groups (those tagged `aws:eks:cluster-name`) and the reading of
the routers' functions' tags (`lambda:ListTags`), and `DmtDiscoveryRole` may invoke the proxies.

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
