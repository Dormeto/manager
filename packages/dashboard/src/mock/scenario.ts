// A demo organization generated from a scenario (npm run dev:mock): a seed and a few sizes. The same scenario gives the
// same organization on every load; another seed, other people, accounts, routers, workloads and candidates. Written as
// text: "acme,workloads=60,routers=5,regions=eu-west-1+us-east-1" (the seed first, then any of the sizes).
import {
  ACCOUNT_EXCLUSION_REASONS, ACCOUNT_NAMES, API_CLIENTS, APPS, AVAILABLE, DISMISS_NOTES, EXCLUSION_REASONS, FIRST_NAMES, LAST_NAMES, PAUSE_REASONS, PREVIOUS,
  REGIONS, STAGES, STATIC, type AccountSpec, type BackendSpec, type CandidateSpec, type IpList, type KubernetesCandidate, type Person, type Profile, type RouterSpec,
  type State, type WorkloadSpec,
} from './fixtures';
import { hash, random, type Random } from './util';

export interface Scenario {
  seed: string;
  domain: string; // of the people's e-mails and the workloads' hosts
  people: number;
  accounts: number;
  regions: string[];
  routers: number;
  workloads: number;
  candidates: number; // discovery candidates that are not workloads
}

export const DEFAULT_SCENARIO: Scenario = {
  seed: 'dormeto', domain: 'example.com', people: 5, accounts: 6, regions: ['eu-west-1', 'eu-west-3', 'us-east-1'], routers: 3, workloads: 18, candidates: 13,
};
const LIMITS = { people: [1, 40], accounts: [1, 40], routers: [1, 60], workloads: [0, 400], candidates: [0, 300] } as const;

// A scenario from its text; what is missing or wrong keeps the default's.
export function parseScenario(text: string | null | undefined, base: Scenario = DEFAULT_SCENARIO): Scenario {
  const out: Scenario = { ...base, regions: [...base.regions] };
  for (const raw of (text ?? '').split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const at = part.indexOf('=');
    if (at < 0) {
      out.seed = part.slice(0, 60);
      continue;
    }
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key === 'seed' && value) out.seed = value.slice(0, 60);
    else if (key === 'domain' && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(value)) out.domain = value.toLowerCase();
    else if (key === 'regions') {
      const regions = [...new Set(value.split(/[+ ]/).filter((r) => REGIONS.includes(r)))];
      if (regions.length) out.regions = regions;
    } else if (key in LIMITS) {
      const n = Number(value);
      const [min, max] = LIMITS[key as keyof typeof LIMITS];
      if (Number.isFinite(n)) out[key as keyof typeof LIMITS] = Math.min(max, Math.max(min, Math.round(n)));
    }
  }
  return out;
}

export interface Organization {
  scenario: Scenario;
  me: string;
  people: Person[];
  actors: [string, string]; // the two operators who act in the story (the signed-in admin when there are none)
  invited: string | null;
  disabled: string | null;
  root: string;
  ous: { nonprod: string; sandbox: string };
  accounts: AccountSpec[];
  loadBalancers: Record<string, { name: string; cluster: string }>;
  routers: RouterSpec[];
  cluster: string | null; // the EKS cluster of the first router
  workloads: WorkloadSpec[];
  candidates: CandidateSpec[];
  accountExclusion: { account: string; reason: string; by: string; daysAgo: number; expiresInDays: number } | null;
  catalogUrl: string;
  ipLists: IpList[];
}

function shuffled<T>(r: Random, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(r.next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// A 12-digit account id, never starting with 0.
const accountId = (seed: string, i: number): string =>
  `${(hash(`account:${seed}:${i}`) % 900_000) + 100_000}${String(hash(`account+:${seed}:${i}`) % 1_000_000).padStart(6, '0')}`;

export function organization(scenario: Scenario): Organization {
  const s = scenario;
  const r = random(`scenario:${s.seed}`);
  const tag = (hash(s.seed) % 0xffff).toString(16).padStart(4, '0');

  // People: the signed-in administrator, two operators, then viewers (one invited, one disabled).
  const firsts = shuffled(r, FIRST_NAMES);
  const lasts = shuffled(r, LAST_NAMES);
  const people: Person[] = Array.from({ length: s.people }, (_, i) => {
    const first = `${firsts[i % firsts.length]}${i >= firsts.length ? Math.floor(i / firsts.length) + 1 : ''}`;
    const email = `${first}.${lasts[i % lasts.length]}@${s.domain}`;
    if (i === 0) return { email, role: 'admin', status: 'CONFIRMED', enabled: true, createdDays: r.int(110, 160), mfa: true };
    if (i <= 2) return { email, role: 'operator', status: 'CONFIRMED', enabled: true, createdDays: r.int(50, 105), mfa: true };
    if (i === 3) return { email, role: 'viewer', status: 'FORCE_CHANGE_PASSWORD', enabled: true, createdDays: r.int(1, 4), mfa: false };
    if (i === 4) return { email, role: 'viewer', status: 'CONFIRMED', enabled: false, createdDays: r.int(60, 100), mfa: null };
    return { email, role: r.chance(0.2) ? 'operator' : 'viewer', status: 'CONFIRMED', enabled: true, createdDays: r.int(5, 100), mfa: r.chance(0.7) };
  });
  const me = people[0]!.email;
  const actors: [string, string] = [people[1]?.email ?? me, people[2]?.email ?? people[1]?.email ?? me];

  // Accounts: dev and staging first, the others drawn; past the names, team-N. Those with "sandbox" in their name go in
  // the sandbox OU; with four accounts or more, the last one lacks the command role.
  const ous = { nonprod: `ou-${tag}-nonprod1`, sandbox: `ou-${tag}-sandbox1` };
  const names = [...ACCOUNT_NAMES.slice(0, 2), ...shuffled(r, ACCOUNT_NAMES.slice(2))];
  const accounts: AccountSpec[] = Array.from({ length: s.accounts }, (_, i) => {
    const name = names[i] ?? `team-${i + 1}`;
    return { id: accountId(s.seed, i), name, ou: name.includes('sandbox') ? ous.sandbox : ous.nonprod, command: !(s.accounts >= 4 && i === s.accounts - 1) };
  });
  // With three accounts or more, the last two have no router: one is excluded for a while, the other only has candidates.
  const routerAccounts = accounts.slice(0, s.accounts >= 3 ? s.accounts - 2 : 1);
  const excluded = s.accounts >= 3 ? accounts[s.accounts - 2]! : null;

  const loadBalancers: Organization['loadBalancers'] = {};
  for (const a of accounts) {
    s.regions.forEach((region, i) => {
      const kind = ['shared', 'public', 'internal', 'web', 'apps'][hash(`lb:${s.seed}:${a.id}:${region}`) % 5];
      loadBalancers[`${a.id}/${region}`] = { name: `${a.name}-${kind}${i ? `-${region.split('-')[1]}` : ''}`.slice(0, 32), cluster: `${a.name}-apps` };
    });
  }

  // Routers: one an account and region, the router accounts in turn.
  const pairs: { account: AccountSpec; region: string }[] = [];
  for (let k = 0; k < s.regions.length; k += 1) {
    routerAccounts.forEach((account, i) => pairs.push({ account, region: s.regions[(i + k) % s.regions.length]! }));
  }
  const routerCount = Math.min(s.routers, pairs.length);
  const named = new Set<string>();
  const routers: RouterSpec[] = pairs.slice(0, routerCount).map(({ account, region }, i) => {
    const name = named.has(account.id) ? `dmtr-${account.name}-${region}` : `dmtr-${account.name}`;
    named.add(account.id);
    const base = { name, account: account.id, region, concurrency: { limit: 1000, needed: 0, worstCase: 0 }, peak: 1 };
    if (i === 0) {
      return {
        ...base, source: 'terraform' as const, ...AVAILABLE, installedDays: r.int(80, 120), metrics: true, clusters: [`${account.name}-eks`, `${account.name}-eks-private`],
        ownLists: [{ name: 'office-egress', url: `s3://dmt-demo-config-${account.id}/lists/office-egress.txt`, action: 'ignore', refreshHours: 24, entries: r.int(6, 20) }],
      };
    }
    // The last one runs the version before (an upgrade is offered); the second one has little Lambda concurrency left.
    if (i === routerCount - 1) return { ...base, source: 'manager' as const, ...PREVIOUS, installedDays: r.int(15, 28), metrics: false };
    return { ...base, source: r.chance(0.25) ? 'terraform' as const : 'manager' as const, ...AVAILABLE, installedDays: r.int(25, 90), metrics: r.chance(0.5) };
  });
  const cluster = routers[0]?.clusters?.[0] ?? null;

  // Workloads: names drawn from the applications and stages, their routers (the first one carries a bit more), backends,
  // habits and idle windows.
  const taken = new Set<string>();
  const unique = (make: () => string): string => {
    for (let i = 0; i < 30; i += 1) {
      const name = make();
      if (!taken.has(name)) {
        taken.add(name);
        return name;
      }
    }
    let n = 2;
    const base = make();
    while (taken.has(`${base}-${n}`)) n += 1;
    taken.add(`${base}-${n}`);
    return `${base}-${n}`;
  };
  const appName = () => (r.chance(0.07) ? `preview-${r.int(1000, 1999)}` : r.chance(0.4) ? r.pick(APPS) : `${r.pick(APPS)}-${r.pick(STAGES)}`);
  const weights = routers.map((_, i) => (i === 0 ? 1.5 : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const routerPick = () => {
    let x = r.next() * total;
    for (let i = 0; i < routers.length; i += 1) {
      x -= weights[i]!;
      if (x < 0) return routers[i]!;
    }
    return routers.at(-1)!;
  };
  const backendsOf = (name: string, router: RouterSpec): BackendSpec[] => {
    const roll = r.next();
    if (router.clusters?.length && roll < 0.12) {
      return [{ kind: 'k8s', cluster: router.clusters[0]!, namespace: name, owner: name.split('-')[0]!, count: r.int(1, 3), vcpu: r.pick([0.5, 1]), memoryGb: r.pick([1, 2, 4]), nodeType: 'm6i.xlarge' }];
    }
    if (roll < 0.4) {
      const [vcpu, memoryGb] = r.pick([[0.5, 1], [1, 2], [2, 4]] as const);
      return [{ kind: 'ecs', vcpu, memoryGb, count: r.int(1, 2), ...(r.chance(0.25) ? { arm: true } : {}) }];
    }
    if (roll < 0.62) return [{ kind: 'instance', type: r.pick(['t3.small', 't3.medium', 't4g.large', 'm6i.large']) }];
    if (roll < 0.75) return [{ kind: 'instance', type: r.pick(['t3.medium', 't4g.large']) }, { kind: 'rds', id: `${name}-db`, class: r.pick(['db.t4g.medium', 'db.r6g.large']) }];
    return [{ kind: 'asg', type: r.pick(['t3.small', 't3.medium', 'm6i.large']), count: r.int(1, 3), ...(r.chance(0.3) ? { warmPool: true } : {}) }];
  };
  const workloads: WorkloadSpec[] = routers.length ? Array.from({ length: s.workloads }, () => {
    const router = routerPick();
    const name = unique(appName);
    const roll = r.next();
    const profile: Profile = roll < 0.45 ? 'office' : roll < 0.65 ? 'busy' : 'sporadic';
    const noise = r.chance(0.55) ? r.int(1, 9) : 0;
    return {
      name, router: router.name, state: 'ASLEEP' as State, profile, backends: backendsOf(name, router), idleMinutes: r.pick([10, 15, 15, 20, 30, 30, 45, 60]),
      wakeMode: r.chance(0.4) ? 'browser' as const : 'any' as const, source: r.chance(0.25) ? 'terraform' as const : 'manager' as const,
      hosts: [`${name}.${s.domain}`], ...(noise ? { noise } : {}),
    };
  }) : [];

  // Their states: a few failed, napping and waking ones, about a quarter awake (the busy ones first), the others asleep.
  const W = workloads.length;
  const free = shuffled(r, workloads);
  const assign = (count: number, state: State, prefer: (w: WorkloadSpec) => boolean) => {
    const chosen = [...free.filter(prefer), ...free.filter((w) => !prefer(w))].slice(0, count);
    for (const w of chosen) {
      w.state = state;
      free.splice(free.indexOf(w), 1);
    }
    return chosen;
  };
  const only = (kind: BackendSpec['kind']) => (w: WorkloadSpec) => w.backends.length === 1 && w.backends[0]!.kind === kind;
  assign(W >= 8 ? 1 + Math.floor(W / 60) : 0, 'FAILED', only('instance'));
  assign(W >= 4 ? 1 + Math.floor(W / 50) : 0, 'WAKING', (w) => w.backends.some((b) => b.kind === 'rds'));
  assign(W >= 5 ? 1 + Math.floor(W / 40) : 0, 'NAPPING', (w) => w.profile === 'office');
  for (const w of assign(Math.max(W >= 2 ? 1 : 0, Math.round(W * 0.28)), 'AWAKE', (w) => w.profile === 'busy')) w.awakeFor = r.int(60, 400);

  // A few of them tell more: one onboarded days ago, one changed by hand in the console (its hosts and a no-wake rule),
  // one woken by its API clients, one paused for a while.
  const asleep = workloads.filter((w) => w.state === 'ASLEEP');
  const recent = W >= 6 ? asleep.find((w) => w.source === 'manager') : undefined;
  if (recent) recent.days = 6;
  const drifted = asleep.find((w) => w !== recent && w.profile === 'office');
  if (drifted) Object.assign(drifted, { hosts: [`${drifted.name}.${s.domain}`, `www.${drifted.name}.${s.domain}`], noWakeRules: [STATIC], drift: true });
  const awake = workloads.filter((w) => w.state === 'AWAKE');
  const api = awake.find((w) => w.profile === 'busy' && w.backends[0]!.kind === 'ecs') ?? awake.find((w) => w.profile === 'busy');
  if (api) api.wakeRules = [API_CLIENTS];
  const paused = W >= 3 ? awake.find((w) => w !== api) : undefined;
  if (paused) paused.paused = { by: actors[0], hoursAgo: 26, reason: r.pick(PAUSE_REASONS), untilHours: 46 };

  // What the routers handle: their Lambda concurrency and peak of simultaneous wakes.
  routers.forEach((router, i) => {
    const n = workloads.filter((w) => w.router === router.name).length;
    const needed = Math.max(3, Math.round(n * 1.6) + r.int(0, 4));
    router.concurrency = i === 1 && routerCount >= 3 ? { limit: 10, needed: 9, worstCase: 15 } : { limit: 1000, needed, worstCase: needed * 3 };
    router.peak = Math.max(1, Math.ceil(n * 0.6));
  });

  // Discovery's candidates that are not workloads: one on Kubernetes, the cluster's nodes, a dismissed one, a gone one,
  // one whose target group is excluded, then some ineligible and the others to onboard.
  const candidates: CandidateSpec[] = [];
  const home = routers[0];
  const anywhere = () => {
    const account = r.pick(accounts);
    const own = routers.filter((x) => x.account === account.id);
    return { account: account.id, region: own.length && r.chance(0.7) ? r.pick(own).region : r.pick(s.regions) };
  };
  const nameOf = (account: string) => accounts.find((a) => a.id === account)!.name;
  const hostOf = (name: string, account: string) => `${name}.${nameOf(account)}.${s.domain}`;
  const add = (c: Omit<CandidateSpec, 'host' | 'firstSeenDays'> & { host?: string; firstSeenDays?: number }) =>
    candidates.push({ host: hostOf(c.name, c.account), firstSeenDays: r.int(2, 58), ...c });
  const pending = () => ({ idleHours7d: r.int(70, 160), requests7d: r.chance(0.1) ? r.int(100_000, 600_000) : r.int(300, 20_000) });
  let left = s.candidates;
  if (home && cluster && left >= 1) {
    const name = unique(() => r.pick(APPS));
    const kubernetes: KubernetesCandidate = {
      cluster, namespace: name, owner: { kind: 'Deployment', name }, switch: 'ingress',
      ingress: { name, ruleIndex: 0, groupOrder: 10, service: { name, port: { number: 80 } } }, gitops: 'argocd', hpa: true, keda: false, capacity: 'nodes', autoscaler: 'karpenter',
    };
    add({ name, account: home.account, region: home.region, backend: { kind: 'k8s', kubernetes }, status: 'pending-onboarding', ...pending() });
    left -= 1;
  }
  if (home && cluster && left >= 6) {
    const name = `${cluster}-nodes`;
    taken.add(name);
    add({
      name, account: home.account, region: home.region, host: `*.apps.${nameOf(home.account)}.${s.domain}`, backend: null, status: 'ineligible', idleHours7d: 12, requests7d: r.int(50_000, 150_000),
      reason: `the Auto Scaling group ${name} holds nodes of EKS cluster ${cluster}: never napped (its pods are Kubernetes workloads)`, firstSeenDays: 58,
    });
    left -= 1;
  }
  if (left >= 4) {
    add({
      name: unique(appName), ...anywhere(), backend: { kind: 'ecs' }, status: 'dismissed', idleHours7d: r.int(40, 90), requests7d: r.int(10_000, 50_000),
      dismissed: { by: actors[1], daysAgo: r.int(5, 20), note: r.pick(DISMISS_NOTES) },
    });
    left -= 1;
  }
  const last = routers.at(-1);
  if (last && left >= 5) {
    add({ name: unique(appName), account: last.account, region: last.region, backend: { kind: 'ecs' }, status: 'gone', idleHours7d: 168, requests7d: 0, firstSeenDays: 47, goneDays: 3 });
    left -= 1;
  }
  if (left >= 3) {
    add({
      name: unique(appName), ...anywhere(), backend: { kind: 'instance' }, status: 'pending-onboarding', ...pending(),
      excluded: { by: actors[1], daysAgo: 18, reason: r.pick(EXCLUSION_REASONS) },
    });
    left -= 1;
  }
  const ineligible = [
    { reason: 'authentication only', ruleOnly: true, idleHours7d: null, requests7d: null },
    { reason: 'redirect action', ruleOnly: true, idleHours7d: null, requests7d: null },
    { reason: 'IP targets without an ECS service', ruleOnly: false, idleHours7d: 0, requests7d: 1_204_388 },
  ];
  for (let i = 0; i < left; i += 1) {
    const where = anywhere();
    if (i % 4 === 3) {
      const why = ineligible[(i >> 2) % ineligible.length]!;
      add({ name: unique(appName), ...where, backend: null, status: 'ineligible', ...why, ...(why.ruleOnly ? {} : { requests7d: r.int(500_000, 1_500_000) }) });
    } else {
      add({ name: unique(appName), ...where, backend: { kind: r.pick(['ecs', 'ecs', 'instance', 'asg'] as const) }, status: 'pending-onboarding', ...pending() });
    }
  }

  return {
    scenario: s, me, people, actors, invited: people[3]?.email ?? null, disabled: people[4]?.email ?? null, root: `r-${tag}`, ous, accounts, loadBalancers, routers, cluster,
    workloads, candidates,
    accountExclusion: excluded ? { account: excluded.id, reason: r.pick(ACCOUNT_EXCLUSION_REASONS), by: actors[0], daysAgo: 6, expiresInDays: 8 } : null,
    catalogUrl: `s3://dmt-demo-manager-${accounts[0]!.id}/ip-lists/catalog.json`,
    ipLists: [
      { name: 'ipsum', url: 'https://raw.githubusercontent.com/stamparm/ipsum/master/levels/3.txt', action: 'ignore', refreshHours: 24, entries: r.int(18_000, 24_000) },
      { name: 'cloud-scanners', url: `s3://dmt-demo-manager-${accounts[0]!.id}/ip-lists/cloud-scanners.txt`, action: 'defer', refreshHours: 24, entries: r.int(3_000, 5_000) },
      { name: 'tor-exits', url: 'https://check.torproject.org/torbulkexitlist', action: 'ignore', refreshHours: 6, entries: r.int(1_000, 1_500) },
    ],
  };
}
