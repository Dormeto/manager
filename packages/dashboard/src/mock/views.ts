// The manager API's answers, computed from the demo model at each request (npm run dev:mock).
import type { Candidate } from '@dormeto/discovery/types';
import { summaryOf } from '@dormeto/fleet/description';
import { addEnergy, savedEnergy } from '@dormeto/fleet/energy';
import type { AccessReport } from '../access';
import type {
  AlertsInfo, Backend, Costs, Counts, Discounts, Exclusion, FleetStates, IdleWindowAdvice, IpListsInfo, Operation, Problem, RouterDetails, RouterInfo,
  SavingsSummary, StoppedItem, WorkloadHistory, WorkloadStatus, WorkloadSummary,
} from '../types';
import { ROUTER_RULES } from './fixtures';
import { ACCOUNTS, ORG } from './org';
import { historyView, replayWindows, timeIn } from './history';
import {
  activeExclusions, ecsCluster, hasHibernation, hibernationOf, lastRequest, managerReadAt, operationStatus, pausesOf, routerIn, type Demo, type DemoOperation, type DemoRouter, type DemoWorkload,
} from './state';
import { DAY, HOUR, MINUTE, SECOND, day, hash, hex, iso, lastCheck, round } from './util';

const CHECK_SCHEDULE = 'cron(0/5 * * * ? *)';
const ALWAYS = { kind: 'always' } as const;

// --- Routers -----------------------------------------------------------------------------------------------------------

export function healthOf(d: Demo, r: DemoRouter): { status: 'ok' | 'warning' | 'error'; problems: (Problem & { code: string })[] } {
  const problems: (Problem & { code: string })[] = [];
  const { limit, needed } = r.concurrency;
  if (needed > 0.8 * limit) {
    problems.push({
      level: 'warning', code: 'concurrency',
      text: `Lambda concurrency limit of the account in this region is ${limit}: the router can need up to ${needed} at once (its waker's 24-hour peak, plus its queued naps and wakes, drift repairs and the check), more than 80% of it; requests beyond the limit get errors: request a higher quota`,
    });
  }
  const failed = d.workloads.filter((w) => w.router === r.name && w.state === 'FAILED').length;
  if (failed) problems.push({ level: 'warning', code: 'failed-workloads', text: `${failed} failed workload${failed === 1 ? '' : 's'}` });
  return { status: problems.length ? 'warning' : 'ok', problems };
}

const own = (d: Demo, r: DemoRouter) => d.workloads.filter((w) => w.router === r.name);
function byState(list: DemoWorkload[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const w of list) out[w.state] = (out[w.state] ?? 0) + 1;
  return out;
}
const pausedCount = (r: DemoRouter, list: DemoWorkload[]) => (r.pauses.length ? list.length : list.filter((w) => w.pauses.length).length);
const lastActivity = (list: DemoWorkload[]) => {
  const at = list.map((w) => w.updatedAt ?? 0).filter(Boolean);
  return at.length ? iso(Math.max(...at)) : null;
};

export function routerRow(d: Demo, r: DemoRouter, now: number): RouterInfo {
  const list = own(d, r);
  const running = d.operations.find((op) => ['install-router', 'upgrade-router', 'uninstall-router'].includes(op.type) && op.target.account === r.account
    && op.target.region === r.region && operationStatus(op, now) === 'running');
  const health = healthOf(d, r);
  return {
    name: r.name, region: r.region, account: r.account, source: r.source, ...(r.clusters.length ? { clusters: r.clusters } : {}),
    version: r.version, build: r.build, workloads: list.length, checkSchedule: CHECK_SCHEDULE, lastScheduledCheckAt: iso(lastCheck(now)),
    health: { status: health.status, problems: health.problems }, pauses: r.pauses, workloadStates: byState(list), paused: pausedCount(r, list),
    lastActivityAt: lastActivity(list), reporting: true, ...(r.description ? { summary: summaryOf(r.description.text) } : {}), checkedAt: iso(lastCheck(now) + 4 * SECOND),
    ...(running ? { operation: { id: running.id, type: running.type as 'install-router' | 'upgrade-router' | 'uninstall-router' } } : {}),
  };
}

// When each list was last downloaded: its refresh period, a few minutes past.
const fetchedAt = (refreshHours: number, now: number) => iso(Math.floor((now - 12 * MINUTE) / (refreshHours * HOUR)) * refreshHours * HOUR + 12 * MINUTE);

export function routerDetails(d: Demo, r: DemoRouter, now: number): RouterDetails {
  const list = own(d, r);
  const health = healthOf(d, r);
  const source = r.source;
  return {
    name: r.name, region: r.region, account: r.account, ...(r.clusters.length ? { clusters: r.clusters } : {}),
    router: { name: r.name, version: r.version, build: r.build },
    configuration: {
      checkSchedule: { value: CHECK_SCHEDULE, source },
      ipLists: { value: r.ownLists.map(({ entries: _e, ...l }) => l), source },
      ...(r.readsManager ? { ipListsCatalog: { value: { url: ORG.catalogUrl, lists: ORG.ipLists.map(({ name, action, refreshHours }) => ({ name, action, refreshHours })) }, source } } : {}),
      noWakeRules: { value: ROUTER_RULES, source },
      metrics: { value: r.metrics, source },
    },
    pauses: r.pauses,
    description: r.description,
    ...(hasHibernation(r) ? {
      settings: { hibernate: r.hibernate, by: r.hibernateBy, at: r.hibernateAt === null ? null : iso(r.hibernateAt) },
      managerSettings: r.readsManager
        ? { url: ORG.catalogUrl.replace(/[^/]*$/, 'settings.json'), hibernate: d.hibernation.hibernate, readAt: iso(managerReadAt(now)), error: null }
        : { url: null, hibernate: null, readAt: null, error: null },
    } : {}),
    workloads: { total: list.length, byState: byState(list), paused: pausedCount(r, list), lastActivityAt: lastActivity(list) },
    health: {
      status: health.status, problems: health.problems, checkSchedule: CHECK_SCHEDULE, lastScheduledCheckAt: iso(lastCheck(now)),
      lambda: { controller: { errors: 0, throttles: 0 }, waker: { errors: 0, throttles: 0, peakConcurrency: r.peak } },
      queues: { check: 0, controller: 0 },
      ipLists: [
        ...r.ownLists.map((l) => ({ name: l.name, entries: l.entries, fetchedAt: fetchedAt(l.refreshHours, now), source: 'terraform' as const })),
        ...(r.readsManager ? ORG.ipLists : []).map((l) => ({ name: l.name, entries: l.entries, fetchedAt: fetchedAt(l.refreshHours, now), source: 'manager' as const })),
      ],
      concurrency: r.concurrency,
    },
  };
}

// The alerts' e-mail subscribers: the administrator and the first operator, shown masked as SNS does.
const ALERTED = [...new Set([ORG.me, ORG.actors[0]])];
const masked = (email: string) => `${email.slice(0, 2)}***${email.slice(email.indexOf('@'))}`;

export function alerts(d: Demo): AlertsInfo {
  const since = iso(d.t0 - 3 * DAY - 4 * HOUR);
  return {
    alarms: d.routers.flatMap((r) => healthOf(d, r).problems.filter((p) => p.code === 'concurrency').map((p) => ({
      id: `router#${r.account}#${r.region}`, kind: 'router' as const, name: r.name, account: r.account, region: r.region, level: 'warning' as const, since,
      problems: [{ ...p, since, hint: `Request a higher quota of Lambda concurrent executions in ${r.region} (Service Quotas): the router can need up to ${r.concurrency.worstCase} if every workload not awake woke at once.` }],
    }))),
    notifications: {
      topicArn: `arn:aws:sns:${ORG.scenario.regions[0]}:${ACCOUNTS[0]!.id}:dmt-demo-manager-alerts`, confirmed: ALERTED.length, pending: 1,
      endpoints: [
        ...ALERTED.map((email) => ({ protocol: 'email', endpoint: masked(email), pending: false })),
        { protocol: 'email', endpoint: masked(`platform@${ORG.scenario.domain}`), pending: true },
      ],
    },
  };
}

export function ipLists(now: number): IpListsInfo {
  return {
    catalog: ORG.catalogUrl,
    lists: ORG.ipLists.map((l) => {
      const at = fetchedAt(l.refreshHours, now);
      return { name: l.name, url: l.url, action: l.action, refreshHours: l.refreshHours, version: at.replace(/[-:]/g, '').slice(0, 13), entries: l.entries, dropped: 0, fetchedAt: at, lastAttemptAt: iso(Math.floor((now - 12 * MINUTE) / HOUR) * HOUR + 12 * MINUTE) };
    }),
  };
}

// --- Workloads ---------------------------------------------------------------------------------------------------------

const discountsOf = (d: Demo): Discounts | null => (d.savings.compute || d.savings.databases ? { compute: d.savings.compute, databases: d.savings.databases } : null);
const discounted = (item: StoppedItem, hourly: number, discounts: Discounts | null) =>
  (discounts ? hourly * (1 - (item.kind === 'rds' || item.kind === 'aurora-serverless' ? discounts.databases : discounts.compute) / 100) : hourly);

// Its savings over the last 30 days: what its naps saved, its share of time asleep, what its last nap stopped.
export function costsOf(d: Demo, w: DemoWorkload, now: number): Costs {
  const view = historyView(w.entries, now - 30 * DAY, now);
  const known = view.phases.filter((p) => p.state !== 'UNKNOWN').reduce((n, p) => n + Date.parse(p.to) - Date.parse(p.from), 0);
  const asleep = timeIn(view, 'ASLEEP') / HOUR;
  const discounts = discountsOf(d);
  const items = w.itemsKnown ? w.items.map(({ item, hourly }) => ({ item, hourly: round(discounted(item, hourly, discounts), 4) })) : [];
  const hourly = items.reduce((n, i) => n + i.hourly, 0);
  const napAt = [...view.phases].reverse().find((p) => p.state === 'ASLEEP')?.from ?? null;
  return {
    baseline: ALWAYS, from: iso(now - 30 * DAY), to: iso(now), napAt: items.length ? napAt : null, savedShare: known ? asleep / (known / HOUR) : null, items,
    saved: { usd: round(asleep * hourly), hours: round(asleep, 1), unpricedHours: items.length ? 0 : round(asleep, 1) }, ...(discounts ? { discounts } : {}),
  };
}

const states7d = (w: DemoWorkload, now: number) => ({ from: iso(now - 7 * DAY), to: iso(now), totals: historyView(w.entries, now - 7 * DAY, now).totals });
// The energy its naps did not use, as the API estimates it with its costs (its own energy.ts): its last nap's items over its
// hours asleep, in its region.
const energyOf = (w: DemoWorkload, c: Costs) => savedEnergy(c.items.map((i) => i.item), c.saved.hours, w.region);

// Requests while not awake (the router's daily counters): scanners ignored, requests deferred, wakes by trigger.
const IGNORED = ['scanner path', 'bot user agent', 'list ipsum', 'HEAD', 'rule health-checks', 'list tor-exits'];
function countsOf(w: DemoWorkload, from: number, to: number): Counts {
  const counts: Counts = { ignored: {}, deferred: {}, wakes: {} };
  const add = (into: Record<string, number>, key: string, n = 1) => { into[key] = (into[key] ?? 0) + n; };
  for (const b of w.bursts) {
    if (!b.noise || b.start < from || b.start >= to) continue;
    const h = hash(`${w.name}:${b.start}`);
    if (h % 7 === 0) add(counts.deferred, 'list cloud-scanners', b.requests);
    else if (w.wakeMode === 'browser' && h % 3 === 0) add(counts.deferred, 'browser mode', b.requests);
    else add(counts.ignored, IGNORED[h % IGNORED.length]!, b.requests);
  }
  for (const e of w.entries) {
    const at = Date.parse(e.at);
    if (e.to !== 'WAKING' || at < from || at >= to) continue;
    add(counts.wakes, !e.cause || e.cause === 'pending-wake' ? 'normal' : e.cause);
  }
  return counts;
}
const sum = (r: Record<string, number>) => Object.values(r).reduce((n, v) => n + v, 0);

function kinds(w: DemoWorkload): string[] {
  const all = w.backends.map((b) => (b.kind === 'rds' ? 'rds-instance' : b.kind));
  return [...new Set([...all.filter((k) => k !== 'rds-instance'), ...all.filter((k) => k === 'rds-instance')])];
}

export function workloadRow(d: Demo, w: DemoWorkload, now: number, { idle = false, states = false } = {}): WorkloadSummary & { region: string; targetGroupArn: string } {
  const total = countsOf(w, now - 7 * DAY, now);
  const costs = states ? costsOf(d, w, now) : null;
  return {
    router: w.router, workloadId: w.workloadId, account: w.account, region: w.region, name: w.name, tags: { ...w.tags }, can: { wake: true, nap: true }, ...(w.schedule ? { scheduled: true } : {}), ...(w.state === 'ASLEEP' && hibernationOf(d, w, now)?.instances?.some((i) => i.hibernated) ? { hibernated: true as const } : {}), state: w.state, url: `https://${w.hosts[0]}/`, wakeMode: w.wakeMode, ...(w.description ? { summary: summaryOf(w.description.text) } : {}),
    wakeCount: w.wakeCount, awakeSince: w.awakeSince === null ? null : iso(w.awakeSince), wakeStartedAt: w.wakeStartedAt === null ? null : iso(w.wakeStartedAt),
    failedAt: w.failedAt === null ? null : iso(w.failedAt), failure: w.failure, consecutiveFailures: w.consecutiveFailures,
    nextAttemptAt: w.nextAttemptAt === null ? null : iso(w.nextAttemptAt), fallbacks: [], updatedAt: w.updatedAt === null ? null : iso(w.updatedAt),
    pendingWake: w.pendingWake, backends: kinds(w), pauses: pausesOf(d, w), settings: w.settings, targetGroupArn: w.targetGroupArn,
    stats7d: { ignored: sum(total.ignored), deferred: sum(total.deferred), wakes: sum(total.wakes) },
    ...(idle && w.idleHours7d !== null ? { idleHours7d: w.idleHours7d, requests7d: w.requests7d } : {}),
    ...(costs ? { states7d: states7d(w, now), costs, energy: energyOf(w, costs) } : {}),
  };
}

const backendStatus = (state: string) => (state === 'AWAKE' ? 'running' : state === 'ASLEEP' || state === 'FAILED' ? 'stopped' : 'transitioning');
const targetState = (state: string) => (state === 'AWAKE' ? 'healthy' : state === 'WAKING' ? 'initial' : state === 'NAPPING' ? 'draining' : 'unused');
const ip = (w: DemoWorkload, i: number) => {
  const h = hex(`ip:${w.name}:${i}`, 6);
  return `10.${parseInt(h.slice(0, 2), 16) % 32}.${parseInt(h.slice(2, 4), 16)}.${(parseInt(h.slice(4, 6), 16) % 250) + 4}`;
};
const WARM_POOL = 'add a warm pool in Stopped state with reuse on scale-in: a nap keeps the instances stopped in the pool and a wake restarts them instead of '
  + 'launching new ones (the application must start at boot: user data runs at the first boot only)';

function backendsOf(w: DemoWorkload): { backends: Backend[]; targets: { id: string; state: string }[]; recommendations: { backend: string; message: string }[] } {
  const status = backendStatus(w.state);
  const running = w.state === 'AWAKE' || w.state === 'WAKING' || w.state === 'NAPPING';
  const backends: Backend[] = [];
  const targets: { id: string; state: string }[] = [];
  const recommendations: { backend: string; message: string }[] = [];
  for (const b of w.backends) {
    if (b.kind === 'instance') {
      backends.push({ kind: 'instance', id: w.instanceId, status });
      targets.push({ id: w.instanceId, state: targetState(w.state) });
    } else if (b.kind === 'asg') {
      const id = `${w.name}-asg`;
      const up = w.state === 'AWAKE' || w.state === 'NAPPING';
      backends.push({ kind: 'asg', id, status, min: up ? b.count : 0, desired: up || w.state === 'WAKING' ? b.count : 0, max: b.count, warmPool: b.warmPool ? { state: 'Stopped', size: b.count, reuseOnScaleIn: true } : null });
      if (running) for (let i = 0; i < b.count; i += 1) targets.push({ id: `i-0${hex(`asg:${w.name}:${i}`, 16)}`, state: targetState(w.state) });
      if (!b.warmPool) recommendations.push({ backend: id, message: WARM_POOL });
    } else if (b.kind === 'ecs') {
      backends.push({ kind: 'ecs', id: `arn:aws:ecs:${w.region}:${w.account}:service/${ecsCluster(w.account, w.region)}/${w.name}`, status });
      if (running) for (let i = 0; i < b.count; i += 1) targets.push({ id: ip(w, i), state: targetState(w.state) });
    } else if (b.kind === 'k8s') {
      backends.push({ kind: 'k8s', id: `${b.cluster}/${b.namespace}/Deployment/${b.owner}`, status, cluster: b.cluster, replicas: b.count, keda: false, switch: 'ingress' });
      if (running) for (let i = 0; i < b.count; i += 1) targets.push({ id: ip(w, i), state: targetState(w.state) });
    } else {
      backends.push({ kind: 'rds-instance', id: b.id, status, companion: true });
    }
  }
  return { backends, targets, recommendations };
}

export function workloadStatus(d: Demo, w: DemoWorkload, now: number): WorkloadStatus {
  const router = d.routers.find((r) => r.name === w.router)!;
  const row = workloadRow(d, w, now, { idle: true, states: true });
  const { backends, targets, recommendations } = backendsOf(w);
  const pauses = pausesOf(d, w);
  const lastRequestAt = lastRequest(w, now);
  const eligibleAt = lastRequestAt === null ? null : lastRequestAt + w.settings.idleMinutes * MINUTE;
  const route = w.state === 'AWAKE' ? 'app' : 'waker';
  const today = Math.floor(now / DAY) * DAY;
  return {
    workloadId: w.workloadId, name: w.name, description: w.description, tags: { ...w.tags }, can: { wake: true, nap: true }, ...(hibernationOf(d, w, now) ? { hibernation: hibernationOf(d, w, now)! } : {}), ...(row.hibernated ? { hibernated: true as const } : {}), url: row.url, router: { version: router.version, build: router.build }, state: w.state, updatedAt: row.updatedAt,
    awakeSince: row.awakeSince, wakeStartedAt: row.wakeStartedAt, failedAt: row.failedAt, failure: w.failure, consecutiveFailures: w.consecutiveFailures,
    nextAttemptAt: row.nextAttemptAt ?? null, fallbacks: [], wakeCount: w.wakeCount, holders: w.state === 'WAKING' ? 1 : 0, pendingWake: w.pendingWake, pauses,
    targetGroupArn: w.targetGroupArn, source: w.source, account: w.account, region: w.region, states7d: row.states7d, costs: row.costs, energy: row.energy,
    ...(w.idleHours7d !== null ? { idleHours7d: w.idleHours7d, requests7d: w.requests7d } : {}), drift: w.drift,
    lastRequestAt: lastRequestAt === null ? null : iso(lastRequestAt),
    nap: w.state === 'AWAKE' && !pauses.length && eligibleAt !== null
      ? { eligibleAt: iso(eligibleAt), latestAt: iso(eligibleAt + 5 * MINUTE), inSeconds: Math.max(0, Math.round((eligibleAt - now) / SECOND)) } : null,
    route, rules: w.ruleArns.map((arn, i) => ({ arn, priority: String(w.priority + i), conditions: `host ${w.hosts[i] ?? w.hosts[0]}`, route })), issues: [],
    backends, ignoredTargets: [], recommendations, targets, settings: w.settings,
    stats: { days: 7, since: day(today - 6 * DAY), today: countsOf(w, today, now), total: countsOf(w, now - 7 * DAY, now) },
    ipLists: [
      ...router.ownLists.map((l) => ({ name: l.name, action: l.action, url: l.url, entries: l.entries, fetchedAt: fetchedAt(l.refreshHours, now) })),
      ...ORG.ipLists.map((l) => ({ name: l.name, action: l.action, url: l.url, entries: l.entries, fetchedAt: fetchedAt(l.refreshHours, now) })),
    ],
    wakeMode: w.wakeMode, wakeRules: w.wakeRules, noWakeRules: [...ROUTER_RULES, ...w.noWakeRules],
  };
}

export function workloadHistory(d: Demo, w: DemoWorkload, days: number, now: number): WorkloadHistory {
  const view = historyView(w.entries, now - days * DAY, now);
  const asleep = timeIn(view, 'ASLEEP') / HOUR;
  const discounts = discountsOf(d);
  const items = w.itemsKnown ? w.items.map(({ item, hourly }) => {
    const price = round(discounted(item, hourly, discounts), 4);
    return { item, hourly: price, hours: round(asleep, 1), usd: round(asleep * price) };
  }) : [];
  return {
    ...view, truncated: false,
    savings: {
      usd: round(items.reduce((n, i) => n + i.usd, 0)), hours: round(asleep, 1), items,
      unpriced: items.length || !asleep ? [] : [{ reason: 'no nap described yet (router 0.27.0)', hours: round(asleep, 1) }], baseline: ALWAYS, ...(discounts ? { discounts } : {}),
    },
  };
}

// The idle window advice (R10), computed once a day: its last 14 days of requests replayed.
export function idleAdvice(d: Demo, w: DemoWorkload, now: number): IdleWindowAdvice {
  const computedAt = Math.floor(now / DAY) * DAY + 2 * HOUR + 17 * MINUTE > now ? Math.floor(now / DAY) * DAY - DAY + 2 * HOUR + 17 * MINUTE : Math.floor(now / DAY) * DAY + 2 * HOUR + 17 * MINUTE;
  const to = Math.floor(computedAt / HOUR) * HOUR;
  const from = to - 14 * DAY;
  const list = w.bursts.filter((b) => b.start >= from && b.end <= to);
  const costs = costsOf(d, w, now);
  const hourly = costs.items.length ? costs.items.reduce((n, i) => n + (i.hourly ?? 0), 0) : null;
  const median = historyView(w.entries, now - 30 * DAY, now).wakes.medianMs;
  const wakeMs = median ?? w.wakeMs;
  const { rows, recommended, replayedWakes } = replayWindows(list, w.settings.idleMinutes, from, to, wakeMs, w.napMs, hourly);
  const actual = historyView(w.entries, from, to).wakes.count;
  return {
    computedAt: iso(computedAt), from: iso(from), to: iso(to), current: w.settings.idleMinutes, recommended, checkMinutes: 5,
    wakeSeconds: median === null ? null : Math.round(median / SECOND), priced: hourly !== null, windows: rows,
    actual: { wakes: actual, replayedWakes, noisy: replayedWakes > actual * 1.2 + 2 }, wakerTargetGroup: true,
  };
}

// All the workloads' bar (GET /workloads/states), from each one's figures.
export function fleetStates(d: Demo, now: number): FleetStates {
  const totals: Record<string, number> = {};
  const saved = { usd: 0, hours: 0, unpricedHours: 0 };
  let hourly = 0;
  let monthly = 0;
  let priced = 0;
  let energy = { kwh: 0, co2Kg: 0, estimated: 0 };
  let estimated = 0;
  for (const w of d.workloads) {
    for (const [state, seconds] of Object.entries(states7d(w, now).totals)) totals[state] = (totals[state] ?? 0) + seconds;
    const c = costsOf(d, w, now);
    const e = energyOf(w, c);
    if (e.estimated) { energy = addEnergy(energy, e); estimated += 1; }
    saved.usd += c.saved.usd;
    saved.hours += c.saved.hours;
    saved.unpricedHours += c.saved.unpricedHours;
    if (!c.items.length) continue;
    const h = c.items.reduce((n, i) => n + (i.hourly ?? 0), 0);
    hourly += h;
    monthly += h * 730 * (c.savedShare ?? 0);
    priced += 1;
  }
  const discounts = discountsOf(d);
  return {
    workloads: d.workloads.length, computedAt: iso(now - 7 * MINUTE), cacheMinutes: 60, states7d: { from: iso(now - 7 * DAY), to: iso(now), totals },
    costs: { baseline: ALWAYS, saved: { usd: round(saved.usd), hours: round(saved.hours, 1), unpricedHours: round(saved.unpricedHours, 1) }, hourly: priced ? round(hourly, 4) : null, monthly: priced ? round(monthly) : null, priced, ...(discounts ? { discounts } : {}) },
    energy: { ...energy, workloads: estimated },
  };
}

// The daily job's summary (R9), computed once from the histories: the 30 days to yesterday, priced without discount.
const summaries = new WeakMap<Demo, SavingsSummary>();
export function savingsSummary(d: Demo): SavingsSummary {
  const kept = summaries.get(d);
  if (kept) return kept;
  const today = Math.floor(d.t0 / DAY) * DAY;
  const from = today - 30 * DAY;
  const daily = new Array<number>(30).fill(0);
  let asleepHours = 0;
  const perWorkload = d.workloads.map((w) => {
    const hourly = w.items.reduce((n, i) => n + i.hourly, 0);
    let usd = 0;
    for (const p of historyView(w.entries, from, today).phases) {
      if (p.state !== 'ASLEEP') continue;
      for (let t = Date.parse(p.from); t < Date.parse(p.to);) {
        const i = Math.floor((t - from) / DAY);
        const end = Math.min(Date.parse(p.to), from + (i + 1) * DAY);
        const hours = (end - t) / HOUR;
        daily[i] = (daily[i] ?? 0) + hours * hourly;
        usd += hours * hourly;
        asleepHours += hours;
        t = end;
      }
    }
    return { w, usd };
  });
  const days = daily.map((usd, i) => ({ date: day(from + i * DAY), usd: round(usd) }));
  const total = days.reduce((n, x) => n + x.usd, 0);
  const month = day(today - DAY).slice(0, 7);
  const summary: SavingsSummary = {
    computedAt: iso(today + 31 * MINUTE > d.t0 ? today - DAY + 31 * MINUTE : today + 31 * MINUTE), day: day(today - DAY), baseline: ALWAYS,
    last30: { usd: round(total), asleepHours: round(asleepHours, 1), days },
    month: { month, usd: round(days.filter((x) => x.date.startsWith(month)).reduce((n, x) => n + x.usd, 0)) },
    cumulative: { usd: round(total + (total / 30) * 66 * 0.84), since: day(today - 96 * DAY), lastDay: day(today - DAY) },
    top: perWorkload.sort((a, b) => b.usd - a.usd).slice(0, 5).map(({ w, usd }) => ({ account: w.account, region: w.region, router: w.router, workloadId: w.workloadId, name: w.name, usd: round(usd) })),
    unpriced: { workloads: 0, hours: 0 }, workloads: d.workloads.length, dormeto: { usdMonth: 5.87 },
  };
  summaries.set(d, summary);
  return summary;
}

// --- Discovery and operations --------------------------------------------------------------------------------------------

export function accessReport(d: Demo, limit: number): AccessReport {
  const missing = ACCOUNTS.filter((a) => !a.command);
  const run = d.runs.at(-1)!.record;
  return {
    counts: { ready: ACCOUNTS.length - missing.length, discoveryMissing: 0, commandMissing: missing.length, unchecked: 0 },
    accounts: missing.slice(0, limit).map((a) => ({
      account: a.id, name: a.name, discovery: { ok: true }, command: { ok: false, reason: 'AccessDenied: the role DmtCommandRole does not exist or does not trust the manager' }, forwarder: 'impossible',
    })),
    cursor: null, delegation: 'ok', checkedAt: run.status === 'running' ? d.runs.at(-2)?.record.finishedAt ?? run.startedAt : run.finishedAt,
    ...(d.config.config.eventRefresh?.enabled ? {
      forwarders: { connected: 4, connecting: 0, impossible: missing.map((a) => ({ account: a.id, name: a.name, reason: 'no command role: the forwarder is installed through it' })) },
    } : {}),
  };
}

export function candidateView(d: Demo, c: Candidate, now: number) {
  const w = c.workloadId ? d.workloads.find((x) => x.workloadId === c.workloadId && x.account === c.account && x.region === c.region) : undefined;
  const router = routerIn(d, c.account, c.region);
  const op = d.operations.find((o) => operationStatus(o, now) === 'running' && o.target.account === c.account && o.target.region === c.region
    && (o.type === 'onboard' ? o.target.targetGroupArn === c.targetGroupArn : o.type === 'offboard' && Boolean(c.workloadId) && o.target.workloadId === c.workloadId));
  return {
    ...c, ...(c.workloadId && (w || router) ? { workload: { router: router?.name ?? w!.router, workloadId: c.workloadId, name: w?.name ?? c.workloadId } } : {}),
    ...(op ? { operation: { id: op.id, type: op.type as 'onboard' | 'offboard' } } : {}),
  };
}

export function exclusionView(d: Demo, e: Demo['exclusions'][number], now: number): Exclusion {
  const active = activeExclusions(d, now).some((x) => x.id === e.id);
  return {
    ...e, ...(e.paused ? { paused: e.paused.map((p) => ({ ...p, name: d.workloads.find((w) => w.workloadId === p.workloadId)?.name ?? p.workloadId })) } : {}),
    expired: !e.liftedAt && !active, lifting: Boolean(e.liftedAt),
  };
}

export function operationView(op: DemoOperation, now: number): Operation {
  const status = operationStatus(op, now);
  const steps = op.steps.map((s) => {
    const attempts = s.every ? 1 + Math.floor((Math.min(now, s.end) - s.start) / s.every) : 0;
    const extra = { ...(s.detail ? { detail: s.detail } : {}), ...(attempts > 1 ? { attempts } : {}) };
    if (s.end <= now) return { name: s.name, status: s.outcome, ...(s.outcome === 'skipped' ? {} : { startedAt: iso(s.start), finishedAt: iso(s.end) }), ...extra };
    if (s.start <= now) return { name: s.name, status: 'running' as const, startedAt: iso(s.start), ...extra };
    return { name: s.name, status: 'pending' as const };
  });
  const times = op.steps.flatMap((s) => [s.start, s.end]).filter((t) => Number.isFinite(t) && t <= now);
  const last = times.length ? Math.max(...times) : op.createdAt;
  const cursor = status === 'succeeded' ? steps.length : Math.max(0, steps.findIndex((s) => s.status !== 'done' && s.status !== 'skipped'));
  return {
    id: op.id, type: op.type, target: op.target, input: op.input, ...(op.context ? { context: op.context } : {}), status, steps, cursor, by: op.by,
    createdAt: iso(op.createdAt), updatedAt: iso(last), ...(status !== 'running' ? { finishedAt: iso(last) } : {}), ...(status === 'failed' && op.error ? { error: op.error } : {}),
  };
}
