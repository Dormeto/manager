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
- **Daily job:** `dmt-<env>-manager-savings` (00:30 UTC; run it by hand with `{"day": "YYYY-MM-DD"}`) puts each
  workload's day as `SAV#<date>` / `<account>#<region>#<workloadId>` (kept `history_days`) and the summary
  (`T#default` / `SAVINGS`): the last 30 days, this month, the cumulative total (each day added once), the top workloads,
  the workloads not priced, Dormeto's estimated cost. `GET /api/savings` answers it; a workload's history adds its
  period's `savings`.

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
- **Changing the window:** the workload module's `idle_minutes`, or offboarding and onboarding again; not from the
  manager yet.
