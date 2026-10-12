# Changelog

Versions of the Dormeto manager, each with the router version it installs. Releases:
https://releases.dormeto.com/manager/ (install: https://dormeto.com/get-started.html). An **Access** line says when the
member accounts' roles or the delegation policy must be applied again (the access and organization modules, or the AWS
CLI script, of the same release).

## Unreleased

- `npm run estimate -- --profile <profile>` (the repository's tool, not in a release): what Dormeto would save on an AWS
  account or organization before anything is installed, with read access only. Discovery, CloudWatch requests and the
  estimate, each cached; a terminal summary, and Markdown and JSON reports. EKS workloads too, read with the profile's
  own access to each cluster (a column EKS; a cluster it cannot read is listed with the reason). `--ec2-uptime` and
  `--ecs-uptime` (`--uptime`: both) count only the hours each EC2 instance ran and each ECS service had a task;
  `--max-wakes` (3 by default) and `--min-saving` ($1 by default) leave out the workloads that would wake more than
  that a day, or save less than that a month, at their recommended window (`none` keeps them); the table by account
  counts each account's excluded workloads, whatever the reason. Discovery reads `--parallel` accounts at a time (5 by
  default), with its progress on one line in a terminal.

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
