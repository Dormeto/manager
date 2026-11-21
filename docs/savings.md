# Savings and the idle window advisor

What the manager prices for each nap, how it adds savings up, and how a workload's idle window card replays its requests.

## Savings

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
  The job reads them once per run (a day computed keeps them; the summary records those of its latest day); the API's
  figures at most once a minute (a read in progress shared; a change seen from another function prices the figures it
  keeps again; while the reads fail, the last ones known, else no costs), and the Savings card with the summary.
- **Estimates, not bills:** AWS bills are not read (a bill cannot show what a nap did not spend, and comes a day late).
- **Baseline:** `savings_baseline` = `always` (24/7) or `business-hours` (weekdays 08:00 to 20:00 in `savings_timezone`).
- **The 7-day bar:** a Workloads row and a workload's header read the workload's last 30 days of history (its time in
  each state over 7 days, what its naps saved, its last nap priced), kept 5 minutes while its state stays the same. The
  bar of all workloads (`GET /api/workloads/states`) adds up each workload's figures kept `states_cache_minutes` (60 by
  default) whatever its state: a refresh reads every workload's history, 20 at a time.
- **Energy (an estimate):** with a workload's costs, its figures carry `energy: { kwh, co2Kg, estimated }`, what its
  naps did not use over the last 30 days: its last nap's items (as priced above) over its hours asleep within the
  baseline (`costs.saved.hours`), in its own region. Cloud Carbon Footprint's coefficients for AWS: 0.74 to 3.5 W per
  vCPU at 50% use, 0.392 W per GB of memory, a PUE of 1.135; EC2 and RDS shapes from the type's family and size (an RDS
  Multi-AZ instance twice), Fargate by its size, Aurora Serverless v2 at its minimum capacity (an ACU: 0.25 vCPU and
  2 GB); then the region's grid factor in kg CO2e per kWh (a region it does not list at the average of those it does).
  Left out: items of unknown size, pods on nodes without a node autoscaler (the nodes stay); `estimated` counts the
  items it could weigh. The bar of all workloads adds up those with an estimate: `energy: { kwh, co2Kg, workloads,
  estimated }` (`workloads`: how many). Absent without prices (no `savings`, or discounts unreadable: no costs), and
  `workloads: 0` while no nap stopped anything of a known size: the Overview's energy card then says "No estimate yet".
  That card reads `GET /api/workloads/states` (when the Overview opens, then every 10 minutes), never the workloads one
  by one; the computation is the API's (`@dormeto/fleet/energy`), the dashboard only says it.
- **Daily job:** `dmt-<env>-manager-savings` (00:30 UTC; run it by hand with `{"day": "YYYY-MM-DD"}`) puts each
  workload's day as `SAV#<date>` / `<account>#<region>#<workloadId>` (kept `history_days`) and the summary
  (`T#default` / `SAVINGS`): the last 30 days, this month, the cumulative total (each day added once), the top workloads,
  the workloads not priced, Dormeto's estimated cost. `GET /api/savings` answers it; a workload's history adds its
  period's `savings`.

## Google Cloud

What a Google Cloud router (0.40.0 and later) stopped is priced as AWS's, by the same job, discounts, baseline, bars and energy
card; only the prices, the items and the energy figures are Google's. Estimates, as above: no bill is read.

- **What is priced:** the router's `ASLEEP` event names what the nap stopped (`stopped`, at most 50 items): VMs by machine type,
  zone, system, Spot and suspension, with their count (`gce`), and Cloud SQL companions by tier, engine, edition and
  availability (`cloudsql`). What the router could not describe (a VM deleted during the nap, a refused read) is an `unknown` item
  with its reason, listed "not priced" with its hours. GKE pods are not priced yet (`unknown`: "GKE pods are not priced").
- **Where the prices come from:** Google's USD list prices from the Cloud Billing Catalog API (`cloudbilling.googleapis.com`),
  read as the discovery service account `dmt-<env>-discovery`, which the savings job and the API already act as: no new role.
  The Catalog has no filter, so the daily job reads a service's pages once per run (Compute Engine: about 33,600 SKUs in 7
  pages; Cloud SQL has its own service), at most 60 seconds a page and 300 seconds a whole service (the end fails the read as a page failing), and logs each
  complete read (`GooglePricesRead`: the service, its pages, SKUs and milliseconds) and each failed one (`GooglePricesFailed`
  at `warn`: the service and the error, once per failed read). Each price priced is cached as `PRICE#<region>#...` for 30 days, a price the rules leave
  unpriced as `null` for a day, as AWS's; the keys are by region, family and resource (`core` and `ram` for a VM, `vcpu`,
  `ram`, `micro` and `small` for Cloud SQL). A read that fails (no connection, a refusal, a page failing midway) caches nothing,
  prices the Google items of that run "not priced", and is asked again after five minutes (within one execution environment; a fresh run asks at once); AWS items are priced as before.
- **The API never reads the Catalog**, since a request would wait for 45 MB: it reads the table's cache only. A Google price
  not cached yet is "not priced" there and is not written; the next daily job prices it. To take a price change at once,
  delete its `PRICE#` items, as for AWS (in the API at once only in a fresh execution environment: a warm one keeps what it
  read for an hour; the savings job keeps a service's index for its life, a run of its own).
- **The SKU rules:** a SKU counts in each of its regions, at its single tier's price (a SKU with several tiers counts as none),
  memory per GiB (a price per GB-hour is multiplied by 1.073741824); two SKUs of one key at different prices make it `null`,
  never a guess. Compute Engine: the core and memory SKUs of the machine family, on demand or Spot, predefined or custom
  (`e2`, `n1`, `n2`, `n2d`, `n4`, `n4a`, `n4d`, `t2d`, `c2`, `c2d`, `c3`, `c3d`, `c4`, `c4a`, `c4d`, `h3`, `m1`, `m2`, `m3`, `z3`;
  custom for `e2`, `n1`, `n2`, `n2d`, `n4`, `n4a` and `n4d`), and the whole-VM hour of `f1-micro` and `g1-small`. A VM's hour is
  `count × (vCPUs × core + memory × RAM)`; the shared cores bill a fraction of a vCPU (`e2-micro` 0.25, `e2-small` 0.5,
  `e2-medium` 1). Another family, the GPU series among them, is not priced.
- **Spot:** a Spot or preemptible VM is priced at Spot prices and never discounted.
- **Suspended VMs:** a suspended VM still pays for its memory (Google's "VM state: suspended RAM" SKU): the saving is the running
  price less `memory × that price`, never below 0. A region without that SKU takes the highest suspended memory price the
  Catalog lists (16 of 48 regions on 2026-11-10): the smallest saving.
- **Windows:** the item's `os` is `Linux` or `Windows`, as AWS's items spell it (another spelling is dropped); Windows is priced as Linux; the license is not counted (the smallest saving).
- **Cloud SQL:** MySQL and PostgreSQL, zonal or regional (`ha`), by the instance's region. Enterprise `db-custom-N-M` tiers:
  `N × vCPU + M/1024 × RAM`; Enterprise Plus `db-perf-optimized-N-K` tiers: `K` vCPUs and 8 GB each (Google's Enterprise Plus
  N tiers); `db-f1-micro` and `db-g1-small`: the instance's hour. SQL Server, another tier or edition, or a tier without its
  size is not priced (SQL Server's license is unpriced on AWS too). A Cloud SQL size out of bounds is dropped alone, the
  instance kept.
- **Discounts:** the Savings card's `compute` percentage applies to Compute Engine and `databases` to Cloud SQL: enter Google's
  committed use and sustained use discounts there, as average rates (never off Spot). Google's list prices carry neither.
- **Energy:** Cloud Carbon Footprint's Google Cloud figures, a separate table from AWS's: watts a vCPU at 0% and 100% by machine
  family (`n2`, `c2`, `g2` 0.69 and 3.75; `t2d`, `c2d` 0.46 and 1.83; `c3`, `h3` 1.04 and 4.06; `c4`, `n4`, `a3` 0.81 and
  4.38; `m3` 0.77 and 3.65; any other family, Arm and Cloud SQL, CCF's medians 0.68 and 4.11) at 50% use, 0.392 W a GB of
  memory and a PUE of 1.1; a Cloud SQL instance with `ha` twice, one without `vcpus` or `memoryGb` has no estimate. The grid
  factor is that of the item's own region (a VM's zone's: a global load balancer's backends may run elsewhere than the router),
  from Google's published grid factors as CCF lists them; another Google Cloud region takes CCF's average, 0.3101.

## Idle window advisor

- **What it does:** a workload's Idle window card replays its last 14 days of requests (CloudWatch `RequestCount` per
  minute, kept 15 days) against idle windows of 5, 10, 15, 20, 30, 45, 60, 90 and 120 minutes and its own, with the
  router's rules (a nap at a check once the window has passed since the last request and since the wake; a request
  while asleep, a wake of the median measured duration). Each window: savings a month (the asleep time priced as the
  savings above: what its latest nap stopped, the baseline, Spot prices and discounts), wakes and visitors' wait a day.
  Recommended: the shortest window that already avoids 90% of the wakes the 120-minute window avoids.
- **Every request counts:** the application and waker target groups' requests are added up, as activity and as wakes;
  the waker's filters (scanners, no-wake rules, IP lists) are not known per minute, so the card compares the replay of
  the current window with the wakes the history recorded and says when it counts clearly more.
- **How it reads:** `GET /api/workloads/{router}/{id}/idle-window` (viewers too) invokes the discovery function's step
  `requests` under `DmtDiscoveryRole` (the load balancer and the waker target group from the rules, then
  `GetMetricData`): nothing more to apply in the member accounts. The answer is kept a day as `T#default` /
  `IDLE#<account>#<region>#<workloadId>` (TTL), or until the workload's idle window changes. A discovery run may take
  the function's reserved executions: the card then says to try again.
- **Requests per hour:** the answer's `hours` (`{ from, counts }`: the replayed minutes added up per UTC hour from
  `from`) draw the workload page's Requests card, GitHub style: a row per day and a column per hour in the viewer's time
  zone, 7 or 14 days, greener with more requests. It is the same read, so it costs no other call; an answer kept from an
  earlier manager has no `hours` until the next one.
- **Changing the window:** the workload module's `idle_minutes`, or offboarding and onboarding again; not from the
  manager yet.
- **A standalone workload** has no requests: its Activity card reads `GET /api/workloads/{router}/{id}/activity` (viewers
  too), which invokes the discovery function's step `activity` under `DmtDiscoveryRole` with the router's queries for its
  backends and resolved signals (`GetMetricData`, 5-minute points, the 7 days to 10 minutes ago). It answers each signal's
  values (`signals[]`: `signal`, `below`, `applies`, `reason`, `from`, `values`), its hours asleep (`asleep`) and the advice
  replayed on them against windows from 5 minutes to 24 hours (hours asleep and stops a day; recommended: the knee from 5
  minutes to 2 hours, since each longer window only avoids the stops of nights and weekends). A point is activity when a
  signal that applies is at or over its threshold, or has no point while the workload was not asleep; after a nap, the
  replay starts it again when its history next shows activity (by a schedule or a person). Kept a day as `T#default` /
  `ACTIVITY#<account>#<region>#<workloadId>`, or until its settings change. A read that fails is a 502
  `metrics_unreadable` (never an idle week); with no signal that applies, nothing is read and `advice` is null. An HTTP
  workload's is a 404.
- **On Google Cloud:** the same card and heatmap read Cloud Monitoring's load balancer request counts per minute (the discovery
  account reads every page, 14 days at most), filtered to the workload's own URL map and its application and waker backend
  services added up: the waker's service is shared, so the URL map keeps another workload's requests out. Monitoring samples
  them, so the answer carries `estimated: true` and the card and heatmap say "Google's request counts are estimates"; the
  advice's `wakerTargetGroup` then means that the waker's requests are counted. The rest is as above.
