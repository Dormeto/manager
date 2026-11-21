// A Google Cloud project's standalone candidates (vision standalone workloads design §6; plan 5, M50): the VMs, the managed
// instance groups and the Cloud SQL instances of the project, each by its path, eligible, ineligible in the router's words
// (router gcp/src/onboarding.mjs, cloudsql.mjs), managed by a router's row, or left out as an HTTP candidate's backend; what backs
// any backend service never eligible (the safety net); their idle share from Cloud Monitoring; Cloud SQL's list refused said and
// its stored candidates kept; `standalone: off` not one call more.
import { describe, expect, it } from 'vitest';
import { GoogleError } from '@dormeto/google';
import type { WorkloadSummary } from '@dormeto/fleet';
import type { InstalledRouter } from '@dormeto/fleet/registry';
import { scanProject } from '../src/gcp-scan.js';
import type { GooglePort } from '../src/google.js';
import { planRun, scanAccount } from '../src/run.js';
import type { DiscoveredRule, StandaloneRule } from '../src/types.js';
import { config, filter } from './fixtures.js';
import { devProject, PROJECT, workloadRow, type ComputeWorld } from './gcp-fakes.js';
import { NOW, standaloneProject } from './gcp-standalone-world.js';
import { HOUR, setup } from './run-fakes.js';

const ZONE = 'europe-west1-b';
const ONBOARDED = [workloadRow('dmt-demo-app')];
const path = (rest: string) => `projects/${PROJECT}/${rest}`;
const standaloneOf = (rules: DiscoveredRule[]) => rules.filter((r): r is StandaloneRule => r.kind === 'standalone');
const byId = (rules: DiscoveredRule[]) => Object.fromEntries(standaloneOf(rules).map((r) => [r.id, r]));
// The managed row of a standalone workload, as M51's fleet keeps it (its kind and resource).
const standaloneRow = (workloadId: string, resource: string) => ({ ...workloadRow(workloadId), kind: 'standalone', resource, backendService: undefined, wakerBackendService: undefined, urlMap: undefined }) as unknown as WorkloadSummary;

const ROWS = [...ONBOARDED, standaloneRow('batch', path(`zones/${ZONE}/instances/batch`))];
const scan = (w: ComputeWorld, standalone = true, rows = ROWS) => scanProject(w, { project: w.project, managed: rows, now: NOW, standalone });

// Each listed resource: its eligibility and reason (none when eligible or managed).
const EXPECTED: Record<string, [string, string?]> = {
  [path(`zones/${ZONE}/instances/batch`)]: ['managed'],
  [path(`zones/${ZONE}/instances/build-agent`)]: ['eligible'],
  [path(`zones/${ZONE}/instances/gpu-box`)]: ['ineligible', 'VM gpu-box has a GPU: GPU VMs are not supported'],
  [path(`zones/${ZONE}/instances/keep-1`)]: ['ineligible', 'VM keep-1 is a member of managed group keep: onboard the group (it would repair a stopped VM)'],
  [path(`zones/${ZONE}/instances/lone-node`)]: ['ineligible', 'VM lone-node is a GKE node: onboard the Kubernetes workloads that run on it'],
  [path(`zones/${ZONE}/instances/nodes-1`)]: ['ineligible', 'VM nodes-1 is a member of managed group nodes: onboard the group (it would repair a stopped VM); VM nodes-1 is a GKE node: onboard the Kubernetes workloads that run on it'],
  [path(`zones/${ZONE}/instances/orphan`)]: ['ineligible', 'VM orphan backs backend service orphan-svc: it belongs to an HTTP workload'],
  [path(`zones/${ZONE}/instances/served-1`)]: ['ineligible', 'VM served-1 backs backend service served-svc: it belongs to an HTTP workload; VM served-1 is a member of managed group served: onboard the group (it would repair a stopped VM)'],
  [path(`zones/${ZONE}/instances/ssd-box`)]: ['ineligible', 'VM ssd-box has a local SSD: a stop would lose its data'],
  [path(`zones/${ZONE}/instances/workers-a1`)]: ['ineligible', 'VM workers-a1 is a member of managed group workers: onboard the group (it would repair a stopped VM)'],
  [path(`zones/${ZONE}/instances/workers-b2`)]: ['ineligible', 'VM workers-b2 is a member of managed group workers: onboard the group (it would repair a stopped VM)'],
  [path('zones/europe-west1-c/instances/spread-1')]: ['ineligible', 'VM spread-1 is a member of managed group spread: onboard the group (it would repair a stopped VM)'],
  [path('regions/europe-west1/instanceGroupManagers/spread')]: ['ineligible', 'regional managed group spread has the target shape EVEN with instance redistribution on: Google cannot stop or suspend its VMs one by one, set its instance redistribution type to NONE or change its target shape, then onboard again'],
  // Sized 0: eligible (router 5be13fa onboards it awake).
  [path(`zones/${ZONE}/instanceGroupManagers/empty`)]: ['eligible'],
  [path(`zones/${ZONE}/instanceGroupManagers/keep`)]: ['ineligible', 'managed group keep has a stateful configuration: a nap might not keep it'],
  [path(`zones/${ZONE}/instanceGroupManagers/nodes`)]: ['ineligible', 'managed group nodes holds GKE nodes: onboard the Kubernetes workloads that run on them'],
  [path(`zones/${ZONE}/instanceGroupManagers/served`)]: ['ineligible', 'managed group served backs backend service served-svc: it belongs to an HTTP workload'],
  [path(`zones/${ZONE}/instanceGroupManagers/workers`)]: ['eligible'],
  [path('instances/orders')]: ['eligible'],
  [path('instances/orders-replica')]: ['ineligible', 'Cloud SQL instance orders-replica is a read replica: Google cannot stop one'],
  [path('instances/reports')]: ['eligible'],
};

describe('a Google Cloud project\'s standalone candidates', () => {
  it('lists each VM, group and Cloud SQL instance no HTTP candidate holds, with the router\'s reasons, in kind order', async () => {
    const { rules, regions, standalone } = await scan(standaloneProject());
    expect(Object.fromEntries(standaloneOf(rules).map((r) => [r.id, r.reason ? [r.eligibility, r.reason] : [r.eligibility]]))).toEqual(EXPECTED);
    expect(standaloneOf(rules).map((r) => r.backend.kind)).toEqual([...Array(12).fill('instance'), ...Array(6).fill('asg'), ...Array(3).fill('cloudsql-instance')]);
    expect(standalone).toEqual({ problems: [], unread: [] });
    expect(regions.map((r) => r.region)).toEqual(['europe-west1', 'europe-west2', 'global']);
  });

  it('gives each its path as id and resource, its backend as the router\'s preview names it, its labels, and no load balancer field', async () => {
    const found = byId((await scan(standaloneProject())).rules);
    expect(found[path(`zones/${ZONE}/instances/build-agent`)]).toEqual({
      kind: 'standalone', id: path(`zones/${ZONE}/instances/build-agent`), account: PROJECT, region: 'europe-west1', resource: path(`zones/${ZONE}/instances/build-agent`), cloud: 'gcp',
      name: 'build-agent', backend: { kind: 'instance', id: 'build-agent', location: ZONE, resourceId: found[path(`zones/${ZONE}/instances/build-agent`)]!.backend.resourceId }, tags: { team: ['ci'] }, eligibility: 'eligible', idleHours7d: null,
    });
    expect(found[path(`zones/${ZONE}/instanceGroupManagers/workers`)]).toMatchObject({ region: 'europe-west1', name: 'workers', backend: { kind: 'asg', id: 'workers', location: ZONE }, tags: { team: ['batch'] } });
    // A VM's and a group's numeric id (the aggregated list's), which the onboarding's tag binding names.
    expect([found[path(`zones/${ZONE}/instances/build-agent`)]!.backend.resourceId, found[path(`zones/${ZONE}/instanceGroupManagers/workers`)]!.backend.resourceId].every((id) => /^\d+$/.test(id ?? ''))).toBe(true);
    expect(found[path('regions/europe-west1/instanceGroupManagers/spread')]).toMatchObject({ region: 'europe-west1', backend: { kind: 'asg', id: 'spread', location: 'europe-west1' } });
    expect(found[path('instances/orders')]).toMatchObject({ region: 'europe-west1', name: 'orders', backend: { kind: 'cloudsql-instance', id: 'orders' }, tags: { team: ['shop'] } });
    expect(found[path(`zones/${ZONE}/instances/batch`)]).toMatchObject({ eligibility: 'managed', workloadId: 'batch' });
    for (const c of Object.values(found)) {
      for (const key of ['resourceArn', 'loadBalancer', 'targetGroup', 'backendService', 'urlMap', 'hosts', 'rules', 'requests7d']) expect(key in c, `${c.id} ${key}`).toBe(false);
    }
  });

  it('leaves out what backs an HTTP candidate (a backend service a URL map names): its VMs, its managed group and the group\'s VMs', async () => {
    const found = byId((await scan(standaloneProject())).rules);
    for (const left of [`zones/${ZONE}/instances/dmt-demo`, `zones/${ZONE}/instanceGroupManagers/dmt-demo-mig`, `zones/${ZONE}/instances/dmt-demo-mig-0k3d`, `zones/${ZONE}/instances/dmt-demo-mig-7vqx`]) {
      expect(found[path(left)], left).toBeUndefined();
    }
  });

  it('with the standalone scan off: the same HTTP candidates, not one call more', async () => {
    const off = standaloneProject();
    const http = devProject();
    const offScan = await scan(off, false);
    const plain = await scanProject(http, { project: http.project, managed: ONBOARDED, now: NOW });
    expect(standaloneOf(offScan.rules)).toEqual([]);
    expect(offScan.standalone).toBeUndefined();
    expect(offScan.rules).toEqual(plain.rules);
    expect(off.calls.filter((c) => /sqladmin|alignmentPeriod=300s|orphan|served/.test(c))).toEqual([]);
    expect(off.calls.length).toBe(http.calls.length);
  });

  it('with the standalone scan on: the HTTP candidates byte-equal to the scan off', async () => {
    const on = await scan(standaloneProject());
    const off = await scan(standaloneProject(), false);
    expect(JSON.stringify(on.rules.filter((r) => r.kind !== 'standalone'))).toBe(JSON.stringify(off.rules));
  });

  it('reads Cloud SQL in pages', async () => {
    const w = standaloneProject();
    w.sqlPage = 1;
    const { rules } = await scan(w);
    expect(standaloneOf(rules).filter((r) => r.backend.kind === 'cloudsql-instance').map((r) => r.name)).toEqual(['orders', 'orders-replica', 'reports']);
    expect(w.calls.filter((c) => c.includes('sqladmin'))).toHaveLength(3);
  });
});

describe('Cloud SQL\'s list refused', () => {
  const refused = (reason: string, message = 'denied') => new GoogleError({ status: 403, reason, message, host: 'sqladmin.googleapis.com', ...(reason === 'PERMISSION_DENIED' ? { code: 'PERMISSION_DENIED' } : {}) });
  it.each([
    ['IAM_PERMISSION_DENIED', 'Cloud SQL instances not listed: the discovery account may not call cloudsql.instances.list (run dormeto gcp connect again: it gives the discovery account the permissions of this release)'],
    ['PERMISSION_DENIED', 'Cloud SQL instances not listed: the discovery account may not call cloudsql.instances.list (run dormeto gcp connect again: it gives the discovery account the permissions of this release)'],
    ['SERVICE_DISABLED', `Cloud SQL instances not listed: the Cloud SQL Admin API (sqladmin.googleapis.com) is not enabled in project ${PROJECT}`],
    ['', `Cloud SQL instances not listed: the discovery account may not call cloudsql.instances.list, or the Cloud SQL Admin API (sqladmin.googleapis.com) is not enabled in project ${PROJECT} (run dormeto gcp connect again: it gives the discovery account the permissions of this release, or enable the API): denied`],
  ])('%s: the VMs and groups listed, the run says why, Cloud SQL\'s kind unread', async (reason, problem) => {
    const w = standaloneProject();
    w.sqlError = refused(reason);
    const { rules, standalone } = await scan(w);
    expect(standaloneOf(rules).some((r) => r.backend.kind === 'cloudsql-instance')).toBe(false);
    expect(standaloneOf(rules).filter((r) => r.eligibility === 'eligible').map((r) => r.name)).toEqual(['build-agent', 'empty', 'workers']);
    expect(standalone).toEqual({ problems: [problem], unread: ['cloudsql-instance'] });
  });
});

describe('a Google Cloud project\'s standalone step', () => {
  const connection = { project: 'dormeto-host', projectNumber: '1', pool: 'p', provider: 'aws-121014831971', scopes: [`projects/${PROJECT}`], serviceAccounts: { discovery: 'd@x', command: 'c@x' }, routers: [], googleAdded: [], connectedAt: '2026-11-09T10:00:00.000Z', connectedBy: 'ops', cli: '0.14.0' };
  const router: InstalledRouter = { name: 'dmtr-europe-west2', account: PROJECT, region: 'europe-west2', controller: 'https://dmtr-europe-west2-controller-abc-nw.a.run.app', onboarder: '', version: '0.42.0', build: '', installedBy: 'cli', cloud: 'gcp', installedAt: '2026-11-09T10:00:00.000Z' };
  function port(w: ComputeWorld, rows: WorkloadSummary[]): GooglePort {
    return {
      connection: async () => connection,
      call: (async (method: string, url: string, body?: unknown) => (url.includes('projects:search') ? { projects: [{ projectId: PROJECT }] } : url.includes(':getAncestry') ? { ancestor: [] } : w.call(method, url, body))) as GooglePort['call'],
      registry: { list: async () => [router], put: async () => {}, delete: async () => {} },
      routerWorkloads: async (account, region) => rows.filter((r) => r.account === account && r.region === region),
    };
  }

  it('keeps the stored Cloud SQL candidates when their list is refused at the next run, never gone, and says it once in the run', async () => {
    const s = setup({ cfg: config({ regions: ['*'], standalone: 'on', filters: [filter('dev', [{ accountIds: [PROJECT] }])] }) });
    await s.ready;
    const w = standaloneProject();
    s.deps.google = port(w, ROWS);
    const first = await planRun(s.deps, { source: 'manual' });
    await scanAccount(s.deps, { runId: first.runId, account: PROJECT });
    const statusOf = async () => Object.fromEntries((await s.store.accountCandidates(PROJECT)).filter((c) => c.kind === 'standalone').map((c) => [c.id, c.status]));
    const before = await statusOf();
    expect(before[path('instances/orders')]).toBe('pending-onboarding');
    expect(before[path(`zones/${ZONE}/instances/batch`)]).toBe('managed');
    w.sqlError = new GoogleError({ status: 403, reason: 'IAM_PERMISSION_DENIED', message: 'denied', host: 'sqladmin.googleapis.com' });
    s.advance(HOUR);
    const second = await planRun(s.deps, { source: 'manual' });
    await scanAccount(s.deps, { runId: second.runId, account: PROJECT });
    expect(await statusOf()).toEqual(before);
    const pairs = (await s.store.getAccountScan(PROJECT))!.result!.pairs;
    expect(pairs.flatMap((p) => p.problems ?? [])).toEqual(['Cloud SQL instances not listed: the discovery account may not call cloudsql.instances.list (run dormeto gcp connect again: it gives the discovery account the permissions of this release)']);
  });

  it('turned off, the standalone candidates go out of scope, never gone', async () => {
    const s = setup({ cfg: config({ regions: ['*'], standalone: 'on', filters: [filter('dev', [{ accountIds: [PROJECT] }])] }) });
    await s.ready;
    const w = standaloneProject();
    s.deps.google = port(w, ROWS);
    await scanAccount(s.deps, { runId: (await planRun(s.deps, { source: 'manual' })).runId, account: PROJECT });
    await s.store.putConfig(config({ regions: ['*'], filters: [filter('dev', [{ accountIds: [PROJECT] }])] }), 'admin@example.com');
    s.advance(HOUR);
    await scanAccount(s.deps, { runId: (await planRun(s.deps, { source: 'manual' })).runId, account: PROJECT });
    const standalone = (await s.store.accountCandidates(PROJECT)).filter((c) => c.kind === 'standalone');
    expect(standalone.length).toBe(Object.keys(EXPECTED).length);
    expect(new Set(standalone.map((c) => c.status))).toEqual(new Set(['out-of-scope', 'pending-offboarding']));
  });
});

describe('a Google Cloud standalone candidate\'s idle share', () => {
  const END = Date.UTC(2026, 10, 9, 11); // the last hour 10 minutes behind NOW
  const START = END - 168 * HOUR;
  const world = () => {
    const w = standaloneProject();
    // build-agent: busy at 09:00 UTC each day, and missing a point on day 2: 160 idle hours. Its CPU is a ratio (× 100).
    w.points[`vm:${ZONE}/build-agent`] = (t) => (t === START + 24 * HOUR + 30 * 60_000 ? undefined : new Date(t).getUTCHours() === 9 ? 0.5 : 0.02);
    // workers: each VM must be under; one over at a point of its fourth hour: 167.
    w.points[`vm:${ZONE}/workers-a1`] = () => 0.01;
    w.points[`vm:${ZONE}/workers-b2`] = (t) => (t === START + 3 * HOUR + 15 * 60_000 ? 0.0501 : 0.0499);
    // orders: connections in its first hour only: 167. reports: no point (stopped all week): no share.
    w.points[`db:${PROJECT}:orders`] = (t) => (t < START + HOUR ? 2 : 0);
    return w;
  };

  it('counts the hours whose every series has its 12 points under the default threshold: CPU as a percentage, a group\'s every VM, a database\'s connections', async () => {
    const w = world();
    const found = byId((await scan(w)).rules);
    expect(found[path(`zones/${ZONE}/instances/build-agent`)]!.idleHours7d).toBe(160);
    expect(found[path(`zones/${ZONE}/instanceGroupManagers/workers`)]!.idleHours7d).toBe(167);
    expect(found[path('instances/orders')]!.idleHours7d).toBe(167);
    expect(found[path('instances/reports')]!.idleHours7d).toBeNull();
    expect(found[path(`zones/${ZONE}/instances/gpu-box`)]!.idleHours7d).toBeNull();
    // Two reads: the VMs' CPU (every VM of the eligible and managed candidates by name), the databases' connections.
    const reads = w.queries.filter((q) => q.searchParams.get('aggregation.alignmentPeriod') === '300s');
    expect(reads.map((q) => [q.searchParams.get('filter'), q.searchParams.get('aggregation.perSeriesAligner'), q.searchParams.get('interval.startTime'), q.searchParams.get('interval.endTime')])).toEqual([
      ['metric.type = "compute.googleapis.com/instance/cpu/utilization" AND resource.type = "gce_instance" AND metric.labels.instance_name = one_of("batch", "build-agent", "workers-a1", "workers-b2")', 'ALIGN_MAX', new Date(START).toISOString(), new Date(END).toISOString()],
      [`metric.type = "cloudsql.googleapis.com/database/network/connections" AND resource.type = "cloudsql_database" AND resource.labels.database_id = one_of("${PROJECT}:orders", "${PROJECT}:reports")`, 'ALIGN_MAX', new Date(START).toISOString(), new Date(END).toISOString()],
    ]);
  });

  it('a read that fails gives no share and says so, never an idle week', async () => {
    const w = world();
    w.pointsError = new GoogleError({ status: 403, reason: 'IAM_PERMISSION_DENIED', message: 'Permission monitoring.timeSeries.list denied', host: 'monitoring.googleapis.com' });
    const { rules, standalone } = await scan(w);
    expect(standaloneOf(rules).every((r) => r.idleHours7d === null)).toBe(true);
    expect(standalone!.problems).toEqual([
      'the idle share of 3 standalone candidates could not be read: GoogleError: Permission monitoring.timeSeries.list denied',
      'the idle share of 2 standalone candidates could not be read: GoogleError: Permission monitoring.timeSeries.list denied',
    ]);
  });

  it('keeps the stored share when the read fails at the next run', async () => {
    const w = world();
    const first = byId((await scan(w)).rules);
    w.pointsError = new GoogleError({ status: 503, reason: 'UNAVAILABLE', message: 'try later', host: 'monitoring.googleapis.com' });
    const stored = Object.values(first).map((c) => ({ id: c.id, region: c.region, idleHours7d: c.idleHours7d, kind: 'standalone' }));
    const again = byId((await scanProject(w, { project: w.project, managed: ROWS, now: NOW, standalone: true, stored })).rules);
    expect(again[path(`zones/${ZONE}/instances/build-agent`)]!.idleHours7d).toBe(160);
    expect(again[path('instances/orders')]!.idleHours7d).toBe(167);
  });
});

describe('criteria and exclusions on a Google Cloud standalone candidate', () => {
  it('match its labels, its region, its kind and its path', async () => {
    const { matches } = await import('../src/filters.js');
    const { exclusionCriterion } = await import('../src/exclusions.js');
    const c = byId((await scan(standaloneProject())).rules)[path('instances/orders')]!;
    const account = { id: PROJECT, name: PROJECT, ouPath: [], tags: {} };
    const inventory = { accounts: [account], ous: {} };
    expect(matches({ resourceTags: { team: ['shop'] } }, account, c, inventory)).toBe(true);
    expect(matches({ resourceTags: { team: ['web'] } }, account, c, inventory)).toBe(false);
    expect(matches({ regions: ['europe-west1'], backendKinds: ['cloudsql-instance'] }, account, c, inventory)).toBe(true);
    expect(matches({ loadBalancers: ['*'] }, account, c, inventory)).toBe(false);
    const criterion = exclusionCriterion({ id: 'x', target: { kind: 'resource', path: c.id, account: PROJECT, name: 'orders' }, reason: 'r', by: 'ops', at: '2026-11-09T10:00:00.000Z' } as never);
    expect(matches(criterion, account, c, inventory)).toBe(true);
  });
});

// The final review's safety-net holes (final-manager-findings.md C1, I1, I2; decisions findings-final-manager-1.md): where the
// manager cannot tell whether a VM or a group serves a load balancer, it is not eligible.
describe('the safety net, where the scan cannot see a load balancer\'s backends', () => {
  const reasonOf = (rules: DiscoveredRule[], rest: string) => {
    const r = byId(rules)[path(rest)]!;
    return r.reason ? [r.eligibility, r.reason] : [r.eligibility];
  };

  it('C1: a VM behind a GCE_VM_IP network endpoint group (an internal passthrough load balancer) backs it', async () => {
    const w = standaloneProject();
    const vm = w.vm('nlb-vm', ZONE);
    w.backendService('nlb-svc', [w.neg('nlb-neg', ZONE, { type: 'GCE_VM_IP', vms: [vm] })], { region: 'europe-west1', scheme: 'INTERNAL' });
    const { rules } = await scan(w);
    expect(reasonOf(rules, `zones/${ZONE}/instances/nlb-vm`)).toEqual(['ineligible', 'VM nlb-vm backs backend service nlb-svc: it belongs to an HTTP workload']);
  });

  it('I1: a regional backend-service list Google could not reach makes no VM or group of that region eligible, and the run says it', async () => {
    const w = standaloneProject();
    w.vm('ilb-vm', 'us-central1-a');
    w.backendService('ilb-svc', [w.group('ilb-ig', 'us-central1-a', ['ilb-vm'])], { region: 'us-central1', scheme: 'INTERNAL_MANAGED' });
    w.unreachable = ['regions/us-central1'];
    const { rules, standalone } = await scan(w);
    expect(reasonOf(rules, 'zones/us-central1-a/instances/ilb-vm')).toEqual(['ineligible', 'VM ilb-vm: its load balancers could not be read: regions/us-central1']);
    expect(reasonOf(rules, `zones/${ZONE}/instances/build-agent`)).toEqual(['eligible']);
    expect(standalone!.problems).toContain('load balancers not read in regions/us-central1: its VMs and managed instance groups are not eligible');
  });

  it('I1: a global miss covers every VM and group of the project; Cloud SQL stays as it is', async () => {
    const w = standaloneProject();
    w.unreachable = ['global'];
    const { rules, standalone } = await scan(w);
    expect(reasonOf(rules, `zones/${ZONE}/instances/build-agent`)).toEqual(['ineligible', 'VM build-agent: its load balancers could not be read: global']);
    expect(reasonOf(rules, `zones/${ZONE}/instances/orphan`)).toEqual(['ineligible', 'VM orphan: its load balancers could not be read: global']);
    expect(reasonOf(rules, `zones/${ZONE}/instanceGroupManagers/workers`)).toEqual(['ineligible', 'managed group workers: its load balancers could not be read: global']);
    expect(reasonOf(rules, 'instances/orders')).toEqual(['eligible']);
    expect(standalone!.problems).toContain('load balancers not read in global: its VMs and managed instance groups are not eligible');
  });

  it('I2: a managed group in a target pool belongs to a load balancer', async () => {
    const w = standaloneProject();
    w.vm('pool-1', ZONE);
    w.mig('pooled', ZONE, ['pool-1'], { extra: { targetPools: [w.link('regions/europe-west1/targetPools/web-pool')] } });
    const { rules } = await scan(w);
    expect(reasonOf(rules, `zones/${ZONE}/instanceGroupManagers/pooled`)).toEqual(['ineligible', 'managed group pooled is in target pool web-pool: it belongs to a load balancer']);
  });

  it('I2: a VM a target pool lists or a target instance points at serves it, the others stay eligible', async () => {
    const w = standaloneProject();
    w.vm('pool-vm', ZONE);
    w.vm('fwd-vm', ZONE);
    w.forwardingRule('web-fr', 'europe-west1', w.targetPool('web-pool', 'europe-west1', [w.link(`zones/${ZONE}/instances/pool-vm`)]));
    w.forwardingRule('fwd-fr', 'europe-west1', w.targetInstance('fwd-ti', ZONE, w.link(`zones/${ZONE}/instances/fwd-vm`)));
    const { rules, standalone } = await scan(w);
    expect(reasonOf(rules, `zones/${ZONE}/instances/pool-vm`)).toEqual(['ineligible', 'VM pool-vm serves target pool web-pool: it belongs to a load balancer']);
    expect(reasonOf(rules, `zones/${ZONE}/instances/fwd-vm`)).toEqual(['ineligible', 'VM fwd-vm serves target instance fwd-ti: it belongs to a load balancer']);
    expect(reasonOf(rules, `zones/${ZONE}/instances/build-agent`)).toEqual(['eligible']);
    expect(standalone!.problems).toEqual([]);
  });

  it('I2: target pools or target instances not listed (a connection made before the reads) fall back: no VM of a region with a forwarding rule to one is eligible', async () => {
    const w = standaloneProject();
    w.vm('far-vm', 'us-central1-a');
    w.forwardingRule('web-fr', 'europe-west1', w.targetPool('web-pool', 'europe-west1', []));
    w.forwardingRule('fwd-fr', 'europe-west1', w.link(`zones/${ZONE}/targetInstances/fwd-ti`));
    w.refused = ['targetPools'];
    const { rules, standalone } = await scan(w);
    expect(reasonOf(rules, `zones/${ZONE}/instances/build-agent`)).toEqual(['ineligible', 'VM build-agent: its region has a load balancer the manager cannot read (a target pool or a target instance): forwarding rule fwd-fr']);
    expect(reasonOf(rules, 'zones/us-central1-a/instances/far-vm')).toEqual(['eligible']);
    expect(reasonOf(rules, `zones/${ZONE}/instanceGroupManagers/workers`)).toEqual(['eligible']);
    expect(standalone!.problems).toEqual([
      'target pools not listed: the discovery account may not call compute.targetPools.list (run dormeto gcp connect again: it gives the discovery account the permissions of this release)',
      'forwarding rules fwd-fr, web-fr of europe-west1 send to a target pool or a target instance the manager could not read: the VMs of europe-west1 are not eligible',
    ]);
  });

  it('I2: a listing refused with no forwarding rule to a target pool or a target instance only says it', async () => {
    const w = standaloneProject();
    w.refused = ['targetInstances'];
    const { rules, standalone } = await scan(w);
    expect(reasonOf(rules, `zones/${ZONE}/instances/build-agent`)).toEqual(['eligible']);
    expect(standalone!.problems).toEqual(['target instances not listed: the discovery account may not call compute.targetInstances.list (run dormeto gcp connect again: it gives the discovery account the permissions of this release)']);
  });

});
