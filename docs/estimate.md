# Savings estimate before install

`npm run estimate -- --profile <profile>` estimates what Dormeto would save on an AWS account or organization before
anything is installed, from a laptop with read access (vision docs/specs/2026-10-10-savings-estimate-design.md; from the
vision repository: `tools/estimate/bin/dormeto-estimate`, the same options).

```
npm run estimate -- --profile prospect[,prospect-prod...] [--accounts 111111111111,222222222222] [--regions eu-west-1,eu-west-3]
  [--exclude-tags 'env=dev|test,team=web' ...] [--uptime | --ec2-uptime | --ecs-uptime | --rds-uptime] [--role <name>] [--baseline always|business-hours] [--timezone Europe/Paris] [--discount-compute 20] [--discount-databases 30]
  [--refresh discovery|metrics] [--window 60] [--max-wakes 3|none] [--min-saving 1|none] [--max-wakes-rds 2|none] [--parallel 5] [--out <dir>]
```

- **Accounts:** the organization's active accounts when the profile may list them (the management account or a
  delegated administrator), else its own account only, and the report says why. Member accounts through `--role`, else
  `OrganizationAccountAccessRole` (accounts created by AWS Organizations have it; invited ones do not): an account whose
  role cannot be assumed is listed with AWS's reason and how to include it. The profile's own account uses its own
  credentials. `--accounts` restricts the estimate to some of the organization's accounts: an id it does not have is
  listed apart, and none of them is refused (exit code 2). Several profiles, comma-separated, such as one SSO profile
  per account when none may list the organization: each reaches its accounts, merged into one estimate; an account a
  profile logs in to directly is read with it, never through another's role; `--accounts` restricts the merged accounts.
- **Excluded tags:** `--exclude-tags` leaves out the workloads with these tags on their load balancer, target group or
  listener rule, as discovery's `resourceTags`: in one value, every comma-separated key must match (and), each with one
  of its `|`-separated values (or), a key alone with any value; repeated, any of them excludes (or). For example
  `--exclude-tags 'env=dev|test,team=web' --exclude-tags dormeto:ignore`. They are left out before their requests are
  read and listed apart in the report, with the criterion that matched.
- **EC2 uptime:** `--ec2-uptime` measures when each EC2 instance without an Auto Scaling group ran over the 14 days
  (its `CPUUtilization`, which EC2 publishes every 5 minutes while an instance runs): its actual cost counts the hours
  it ran, its savings only the hours Dormeto would nap it while it ran (an instance stopped at night by a schedule saves
  less). An instance found stopped is estimated from the hours it ran (without the option, it is left out). Instances
  Dormeto already manages and Auto Scaling groups are not measured.
- **ECS uptime:** `--ecs-uptime` measures when each ECS service had a task over the 14 days (its `CPUUtilization`, which
  ECS publishes every minute while the service has a task, and not at 0 tasks): its actual cost and its savings count
  only those hours, at its desired count when discovered (a service scaled to 0 at night saves less). A service found at
  0 tasks is estimated as one task from the hours it ran (without the option, it is left out). When it had a task is
  measured, not how many: a service scaled from 4 tasks to 1 at night stays priced at its count when discovered.
  Services Dormeto already manages are not measured. `--uptime` sets `--ec2-uptime`, `--ecs-uptime` and `--rds-uptime`.
- **Busy and small workloads:** judged at each workload's recommended window (the one a customer would set),
  `--max-wakes` (3 by default) leaves out a workload that would wake more than that many times a day (its visitors would
  wait more than it saves), and `--min-saving` ($1 by default) one that would save less than that a month (not worth
  installing Dormeto for). Each is listed apart in the report with its window, wakes a day and the saving left out;
  `none` keeps them all.
- **Companion databases:** an RDS instance or an Aurora provisioned cluster (not yet Aurora Serverless) whose security
  group lets in a workload's (an instance's, its Auto Scaling group's instances', an ECS service's; not yet Kubernetes)
  naps with it, once the wakes filter has kept the workload: its saving is added to the workload's (before
  `--min-saving`) and listed apart. Left out, with why: excluded by its own tags (`--exclude-tags`), reached by another
  workload of the region (even an excluded one), a read replica or one with replicas, or its workload waking more than
  `--max-wakes-rds` times a day (2 by default: a database takes minutes to start; `none` keeps them). With
  `--rds-uptime` (in `--uptime`), each one's `CPUUtilization` says when it was available, and its saving and cost count
  only those hours: one stopped when discovered (a schedule may start it) is estimated from them, else left out. The
  table by account counts them (RDS); the summary counts those left out by reason.
- **Three phases:** discovery (`--parallel` accounts at a time, 5 by default, each scanning its regions one after the
  other; in a terminal, one progress line with a bar, the accounts done, the regions, workloads, failures and the time,
  else a line per account; discovery's scan of each enabled region, or `--regions`; what each eligible workload's
  backend would stop, as the router describes it), requests (each workload's `RequestCount` per minute over 14 days,
  five metrics per `GetMetricData` call, `--parallel` regions at a time, as the uptime; in a terminal each on one
  progress line, as discovery), estimate (R10's replay priced by the product's price book, at `--window`
  (an hour by default) and at each workload's recommended one, net of Dormeto's cost). A workload Dormeto already manages is
  estimated with its waker target group's requests added.
- **Cache:** `~/.cache/dormeto/estimate/<organization or account>/` (`$XDG_CACHE_HOME` when set): discovery and each
  account's regions for a day, requests while their 14 days end on the same UTC day, prices as the product's. An
  interrupted run resumes; `--refresh discovery` reads discovery and requests again, `--refresh metrics` the requests.
- **Output:** the terminal summary, and `estimate-<date>.md` and `.json` in `--out` (the current directory by default).
  The table by account counts each account's excluded workloads, whatever the reason (tags, left out, too many wakes,
  too small a saving); the workloads table gives each one's uptime (measured, else 100% assumed), its recommended window,
  saving and wakes a day. In a terminal, discovery redraws its progress every second and names the last accounts still
  read; a region's workloads are described eight at a time.
- **Needs the router checkout** next to the manager (`../router`, as the release does): the estimate bundles its
  description of what a nap stops.
- **Read-only:** `sts:GetCallerIdentity`, `sts:AssumeRole`, `organizations:DescribeOrganization`, `ListRoots`,
  `ListOrganizationalUnitsForParent`, `ListAccountsForParent`, `ec2:DescribeRegions`, `DescribeInstances`,
  `DescribeSpotPriceHistory`, `elasticloadbalancing:Describe*`, `autoscaling:DescribeAutoScalingGroups`,
  `ecs:ListClusters`, `ListServices`, `DescribeServices`, `DescribeTaskDefinition`, `cloudwatch:GetMetricData`,
  `pricing:GetProducts`, `eks:ListClusters`, `DescribeCluster`, `rds:DescribeDBInstances`, `DescribeDBClusters`,
  `ec2:DescribeSecurityGroups` (the `ReadOnlyAccess` managed policy covers them).
  An EKS cluster's workloads are read through its Kubernetes API, which needs the profile's own access entry (the
  view policy is enough); a cluster it cannot read is listed with the reason. CloudWatch costs about $0.01 per 1,000
  workloads.
- **Conservative:** every request counts as activity and as a wake (no waker yet to set scanners apart), a wake lasts 60
  seconds, no visitors' wait, databases not counted (not attached to load balancers).
