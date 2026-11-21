// Exclusions applied and lifted by the workflow (scale design §6): the API answers at once, the operation pauses or
// resumes the matched workloads in their routers, in batches, each pause recorded with the exclusion. On Google Cloud
// (Google Cloud manager design §8), through the routers of the exclusion's project, every region's.
import { describe, expect, it } from 'vitest';
import type { Candidate, Exclusion } from '@dormeto/discovery';
import { createEngine, type RouterRef } from '../src/engine.js';
import { createRecords } from '../src/records.js';
import { Conflict } from '../src/engine.js';
import { fakeDynamo } from './dynamo-fake.js';

const ACCOUNT = '121014831971';
const LB = `arn:aws:elasticloadbalancing:eu-west-1:${ACCOUNT}:loadbalancer/app/dmt-dev/50dc6c495c0c9188`;
const tg = (n: number) => `arn:aws:elasticloadbalancing:eu-west-1:${ACCOUNT}:targetgroup/app-${n}/${String(n).padStart(16, '0')}`;
const ROUTERS: RouterRef[] = [
  { name: 'dmt-dev', account: ACCOUNT, region: 'eu-west-1', controller: 'arn:dmt-dev-controller', source: 'terraform' },
  { name: 'dmt-dev2', account: ACCOUNT, region: 'eu-west-1', controller: 'arn:dmt-dev2-controller', source: 'terraform' },
];
const managed = (n: number, workloadId: string, over: Partial<Candidate> = {}): Candidate => ({
  id: tg(n), account: ACCOUNT, region: 'eu-west-1', loadBalancer: 'dmt-dev', loadBalancerArn: LB, listener: 'HTTPS:443', priority: String(n), conditions: 'host x',
  hosts: [], targetGroup: `app-${n}`, targetGroupArn: tg(n), backend: null, tags: {}, rules: [], eligibility: 'managed', workloadId, idleHours7d: null, requests7d: null,
  accountName: 'dormeto', ouPath: [], scope: 'in', scopeReason: 'in', status: 'managed', statusReason: 'managed', firstSeenAt: 'x', lastSeenAt: 'x', history: [], ...over,
});
const exclusion = (over: Partial<Exclusion> = {}): Exclusion => ({
  id: 'x1', target: { kind: 'load-balancer', arn: LB, account: ACCOUNT, region: 'eu-west-1', name: 'dmt-dev' }, reason: 'migration', by: 'ops@example.com', at: '2026-10-05T12:00:00.000Z', ...over,
});

// Workloads each router knows; a pause or resume elsewhere answers "workload not configured", as a refusal with its code on
// a Google Cloud router (googleInvoker), which answers an exclusion's resume of a workload it no longer has with
// `{resumed: false}` (router gcp/src/actions.mjs's resume).
// down: a Google Cloud router's error for any call, thrown as googleInvoker throws it (a refusal's code, or none).
function setup({ candidates, known, fail = new Set<string>(), routers = ROUTERS, failWrite, down = {} }: {
  candidates: Candidate[]; known: Record<string, string[]>; fail?: Set<string>; routers?: RouterRef[]; failWrite?: (n: number) => boolean; down?: Record<string, () => Error>;
}) {
  const dynamo = fakeDynamo();
  const records = createRecords({ dynamo, table: 't', now: () => Date.parse('2026-10-05T12:00:00.000Z') });
  const exclusions = new Map<string, Exclusion>();
  const calls: [string, Record<string, unknown>][] = [];
  // A Google Cloud router's calls: its name, the payload and the time given.
  const googleCalls: [string, Record<string, unknown>, number][] = [];
  // What the exclusion recorded when each router call was made.
  const recordedAtCall: string[][] = [];
  let writes = 0;
  const discovery = {
    getCandidate: async (id: string) => candidates.find((c) => c.id === id) ?? null,
    putCandidates: async () => {},
    accountCandidates: async (account: string) => candidates.filter((c) => c.account === account),
    getInventory: async () => ({ accounts: [{ id: ACCOUNT, name: 'dormeto', ouPath: [], tags: {} }], ous: {} }),
    getExclusion: async (id: string) => structuredClone(exclusions.get(id) ?? null),
    putExclusion: async (e: Exclusion) => { exclusions.set(e.id, structuredClone(e)); },
    updateExclusion: async (id: string, change: (e: Exclusion) => Exclusion | Promise<Exclusion>) => {
      const e = exclusions.get(id);
      if (!e) return null;
      const next = await change(structuredClone(e));
      writes += 1;
      if (failWrite?.(writes)) throw Object.assign(new Error('Throttling'), { name: 'ThrottlingException' });
      exclusions.set(id, structuredClone(next));
      return next;
    },
    deleteExclusion: async (id: string) => { exclusions.delete(id); },
  };
  let ids = 0;
  const answer = (router: string, payload: Record<string, unknown>, google = false) => {
    calls.push([router, payload]);
    recordedAtCall.push((exclusions.get('x1')?.paused ?? []).map((p) => `${p.router}/${p.workloadId}`));
    const id = String(payload.workloadId);
    if (fail.has(`${router}/${id}`)) throw new Error('Throttling');
    if (!known[router]?.includes(id)) {
      if (google && payload.action === 'resume' && payload.exclusionId) return { resumed: false };
      throw Object.assign(new Error(`workload not configured: ${id}`), google ? { code: 'not_found' } : { name: 'RouterError' });
    }
    return payload.action === 'pause' ? { pause: {}, woken: [] } : { resumed: true };
  };
  const engine = createEngine({
    records, discovery: discovery as never, routers: async () => routers,
    target: async () => ({
      installer: () => { throw new Error('no installer'); },
      invoke: async (arn: string, payload: Record<string, unknown>) => answer(routers.find((r) => r.controller === arn)!.name, payload),
    }) as never,
    google: {
      invoke: async (router, payload, { timeoutMs }) => {
        googleCalls.push([router.name, payload, timeoutMs]);
        if (down[router.name]) throw down[router.name]!();
        return answer(router.name, payload, true);
      },
      tags: {} as never,
    },
    bundle: async () => { throw new Error('no bundle'); },
    settings: { env: 'dev', principals: [], routerSettings: { ipListsCatalog: 's3://dmt-dev-manager-ip-lists-121014831971/catalog.json', ipListsBucket: 'dmt-dev-manager-ip-lists-121014831971', checkSchedule: '', ipLists: '', noWakeRules: '', metrics: '', commandRole: 'DmtCommandRole', managerBus: '' } },
    start: async () => 'arn:execution', now: () => Date.parse('2026-10-05T12:00:00.000Z'), newId: () => `op${++ids}`, log: { info() {}, warn() {}, error() {} },
  });
  async function drive(id: string) {
    for (let i = 0; i < 100; i += 1) {
      const r = await engine.next(id);
      if (r.done) return r;
    }
    throw new Error('never finished');
  }
  return { engine, records, exclusions, calls, googleCalls, recordedAtCall, drive };
}

describe('exclusions through the workflow', () => {
  it('pauses each managed workload the exclusion matches in the router that knows it, records each pause, reports the others', async () => {
    const s = setup({ candidates: [managed(1, 'shop'), managed(2, 'blog'), managed(3, 'orphan')], known: { 'dmt-dev': ['shop'], 'dmt-dev2': ['blog'] } });
    s.exclusions.set('x1', exclusion());
    const op = await s.engine.create('exclude', { exclusionId: 'x1' }, 'ops@example.com');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    expect(s.exclusions.get('x1')!.paused).toEqual([
      { router: 'dmt-dev', account: ACCOUNT, region: 'eu-west-1', workloadId: 'shop' }, { router: 'dmt-dev2', account: ACCOUNT, region: 'eu-west-1', workloadId: 'blog' },
    ]);
    const pause = s.calls.find(([, p]) => p.action === 'pause' && p.workloadId === 'shop')![1];
    expect(pause).toEqual({ action: 'pause', workloadId: 'shop', targetGroupArn: tg(1), by: 'ops@example.com', reason: 'excluded: migration', exclusionId: 'x1' });
    expect((await s.records.getOperation(op.id))!.steps[0]!.detail).toMatch(/paused 2; not paused orphan: no registered router manages it/);
  });

  it('pauses the workload it was created from, even without a candidate', async () => {
    const s = setup({ candidates: [], known: { 'dmt-dev': ['shop'] } });
    s.exclusions.set('x1', exclusion({ target: { kind: 'target-group', arn: tg(1), account: ACCOUNT, region: 'eu-west-1', name: 'app-1' } }));
    const op = await s.engine.create('exclude', { exclusionId: 'x1', hint: { workloadId: 'shop' } }, 'ops');
    await s.drive(op.id);
    expect(s.exclusions.get('x1')!.paused!.map((p) => p.workloadId)).toEqual(['shop']);
  });

  it('pauses the workload it was created from in the routers of its target group\'s account and region, an installed one included', async () => {
    // The workflow knows an installed router by its AWS name; the API by another (dmtr-dev-eu-west-1): the hint names none.
    const installed: RouterRef = { name: 'dmtr-dev', account: ACCOUNT, region: 'eu-west-1', controller: 'arn:dmtr-dev-controller', source: 'manager' };
    const s = setup({ candidates: [managed(1, 'shop')], known: { 'dmtr-dev': ['shop'] }, routers: [installed] });
    s.exclusions.set('x1', exclusion({ target: { kind: 'target-group', arn: tg(1), account: ACCOUNT, region: 'eu-west-1', name: 'app-1' } }));
    const op = await s.engine.create('exclude', { exclusionId: 'x1', hint: { workloadId: 'shop' } }, 'ops');
    await s.drive(op.id);
    expect(s.exclusions.get('x1')!.paused).toEqual([{ router: 'dmtr-dev', account: ACCOUNT, region: 'eu-west-1', workloadId: 'shop' }]);
  });

  it('records each pause before its router is called; a batch run again after a failed write records it once', async () => {
    // The write after the first batch's router calls fails once: the step runs that batch again.
    const s = setup({ candidates: [managed(1, 'shop'), managed(2, 'blog')], known: { 'dmt-dev': ['shop', 'blog'] }, failWrite: (n) => n === 2 });
    s.exclusions.set('x1', exclusion());
    const op = await s.engine.create('exclude', { exclusionId: 'x1' }, 'ops');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    const pauses = s.calls.map(([router, p], i) => [`${router}/${p.workloadId}`, s.recordedAtCall[i]!.includes(`${router}/${p.workloadId}`)]);
    expect(pauses.every(([, recorded]) => recorded)).toBe(true);
    expect(s.exclusions.get('x1')!.paused!.map((p) => `${p.router}/${p.workloadId}`)).toEqual(['dmt-dev/shop', 'dmt-dev/blog']);
  });

  it('pauses a large exclusion in several steps, each workload once', async () => {
    const candidates = Array.from({ length: 60 }, (_, i) => managed(i + 1, `w${i + 1}`));
    const s = setup({ candidates, known: { 'dmt-dev': candidates.map((c) => c.workloadId!) } });
    s.exclusions.set('x1', exclusion());
    const op = await s.engine.create('exclude', { exclusionId: 'x1' }, 'ops');
    await s.drive(op.id);
    expect(s.exclusions.get('x1')!.paused).toHaveLength(60);
    expect(s.calls.filter(([router, p]) => router === 'dmt-dev' && p.action === 'pause')).toHaveLength(60);
    expect((await s.records.getOperation(op.id))!.steps[0]!.attempts).toBeGreaterThan(1);
  });

  it('a failing pause is reported; the pauses that succeeded stay with the exclusion', async () => {
    const s = setup({ candidates: [managed(1, 'shop'), managed(2, 'blog')], known: { 'dmt-dev': ['shop', 'blog'] }, fail: new Set(['dmt-dev/blog']) });
    s.exclusions.set('x1', exclusion());
    const op = await s.engine.create('exclude', { exclusionId: 'x1' }, 'ops');
    await s.drive(op.id);
    expect(s.exclusions.get('x1')!.paused!.map((p) => p.workloadId)).toEqual(['shop']);
    expect((await s.records.getOperation(op.id))!.steps[0]!.detail).toMatch(/not paused blog \(dmt-dev\): Throttling/);
  });

  it('a lift resumes the workloads paused for it; one it cannot resume keeps the exclusion, lifted, until a later lift', async () => {
    const paused = [{ router: 'dmt-dev', account: ACCOUNT, region: 'eu-west-1', workloadId: 'shop' }, { router: 'dmt-dev2', account: ACCOUNT, region: 'eu-west-1', workloadId: 'blog' }];
    const fail = new Set(['dmt-dev2/blog']);
    const s = setup({ candidates: [], known: { 'dmt-dev': ['shop'], 'dmt-dev2': ['blog'] }, fail });
    s.exclusions.set('x1', exclusion({ paused, liftedAt: '2026-10-05T12:00:00.000Z' }));
    const first = await s.engine.create('lift-exclusion', { exclusionId: 'x1' }, 'ops');
    await s.drive(first.id);
    expect(s.exclusions.get('x1')!.paused!.map((p) => p.workloadId)).toEqual(['blog']);
    fail.clear();
    const second = await s.engine.create('lift-exclusion', { exclusionId: 'x1' }, 'ops');
    await s.drive(second.id);
    expect(s.exclusions.has('x1')).toBe(false);
    expect(s.calls.filter(([, p]) => p.action === 'resume').map(([router, p]) => `${router}/${p.workloadId}/${p.exclusionId}`)).toEqual(['dmt-dev/shop/x1', 'dmt-dev2/blog/x1', 'dmt-dev2/blog/x1']);
  });

  it('a lift of several batches resumes each pause once; only the one it could not resume stays, and the exclusion is marked lifted', async () => {
    const paused = Array.from({ length: 30 }, (_, i) => ({ router: 'dmt-dev', account: ACCOUNT, region: 'eu-west-1', workloadId: `w${i + 1}` }));
    const fail = new Set(['dmt-dev/w1']);
    const s = setup({ candidates: [], known: { 'dmt-dev': paused.map((p) => p.workloadId) }, fail });
    s.exclusions.set('x1', exclusion({ paused }));
    const first = await s.engine.create('lift-exclusion', { exclusionId: 'x1' }, 'ops');
    await s.drive(first.id);
    expect(s.exclusions.get('x1')!.paused!.map((p) => p.workloadId)).toEqual(['w1']);
    expect(s.exclusions.get('x1')!.liftedAt).toBe('2026-10-05T12:00:00.000Z');
    expect(s.calls.filter(([, p]) => p.action === 'resume' && p.workloadId === 'w1')).toHaveLength(1);
    expect((await s.records.getOperation(first.id))!.steps[0]!.detail).toBe('not resumed: dmt-dev/w1: Throttling (lift again to retry)');
    fail.clear();
    const second = await s.engine.create('lift-exclusion', { exclusionId: 'x1' }, 'ops');
    await s.drive(second.id);
    expect(s.exclusions.has('x1')).toBe(false);
  });

  it('a lift counts a workload its router no longer knows (offboarded since) as resumed', async () => {
    const s = setup({ candidates: [], known: { 'dmt-dev': [] } });
    s.exclusions.set('x1', exclusion({ paused: [{ router: 'dmt-dev', account: ACCOUNT, region: 'eu-west-1', workloadId: 'gone' }], liftedAt: 'x' }));
    const op = await s.engine.create('lift-exclusion', { exclusionId: 'x1' }, 'ops');
    await s.drive(op.id);
    expect(s.exclusions.has('x1')).toBe(false);
  });

  it('runs one operation per exclusion at a time', async () => {
    const s = setup({ candidates: [], known: {} });
    s.exclusions.set('x1', exclusion());
    const op = await s.engine.create('exclude', { exclusionId: 'x1' }, 'ops');
    await expect(s.engine.create('lift-exclusion', { exclusionId: 'x1' }, 'ops')).rejects.toThrow(new Conflict(op.id));
  });
});

describe('exclusions on Google Cloud', () => {
  const PROJECT = 'dormeto-dev';
  const service = (name: string, region = 'global') => `projects/${PROJECT}/${region === 'global' ? 'global' : `regions/${region}`}/backendServices/${name}`;
  const GOOGLE: RouterRef[] = [
    { name: 'dmtr-europe-west2', account: PROJECT, region: 'europe-west2', controller: 'https://dmtr-europe-west2-controller-abc123-nw.a.run.app', source: 'manager', version: '0.40.0', cloud: 'gcp' },
    { name: 'dmtr-us-central1', account: PROJECT, region: 'us-central1', controller: 'https://dmtr-us-central1-controller-abc123-uc.a.run.app', source: 'manager', version: '0.40.0', cloud: 'gcp' },
  ];
  // A managed Google Cloud candidate (the one model): its id the backend service's path, no target group ARN.
  const urlMap = (name: string, region = 'global') => `projects/${PROJECT}/${region === 'global' ? 'global' : `regions/${region}`}/urlMaps/${name}`;
  const managedOnGoogle = (name: string, workloadId: string, region = 'global', map = 'dmt-dev'): Candidate => ({
    ...managed(1, workloadId), id: service(name, region), account: PROJECT, region, loadBalancer: map, loadBalancerArn: '', listener: '', priority: '', conditions: 'hosts x',
    targetGroup: name, targetGroupArn: null, backendService: service(name, region), urlMap: urlMap(map, region),
    lb: { kind: region === 'global' ? 'global' : 'regional' }, accountName: PROJECT,
  });

  it('a target-group exclusion of a Google Cloud candidate pauses its workload through the routers of its project, with its backend service\'s path and no target group', async () => {
    // Its global load balancer is onboarded on the second router: the first answers that it has no such workload.
    const s = setup({ candidates: [managedOnGoogle('shop-app', 'shop')], known: { 'dmtr-us-central1': ['shop'] }, routers: [...ROUTERS, ...GOOGLE] });
    s.exclusions.set('x1', exclusion({
      target: { kind: 'target-group', path: service('shop-app'), account: PROJECT, region: 'global', name: 'shop-app' }, expiresAt: '2026-10-06T12:00:00.000Z',
    }));
    const op = await s.engine.create('exclude', { exclusionId: 'x1' }, 'ops@example.com');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    const pause = { action: 'pause', workloadId: 'shop', backendService: service('shop-app'), by: 'ops@example.com', reason: 'excluded: migration', until: '2026-10-06T12:00:00.000Z', exclusionId: 'x1' };
    expect(s.googleCalls).toEqual([['dmtr-europe-west2', pause, 10_000], ['dmtr-us-central1', pause, 10_000]]);
    expect(s.calls.map(([router]) => router)).toEqual(['dmtr-europe-west2', 'dmtr-us-central1']);
    expect(s.exclusions.get('x1')!.paused).toEqual([{ router: 'dmtr-us-central1', account: PROJECT, region: 'us-central1', workloadId: 'shop' }]);
    expect((await s.records.getOperation(op.id))!.steps[0]!.detail).toBe('paused 1');
  });

  it('a managed Google Cloud candidate without AWS\'s four fields pauses as one that has them stored empty', async () => {
    const fresh = managedOnGoogle('shop-app', 'shop');
    for (const key of ['targetGroupArn', 'loadBalancerArn', 'listener', 'priority'] as const) delete (fresh as Partial<Candidate>)[key];
    const s = setup({ candidates: [{ ...fresh, cloud: 'gcp' }], known: { 'dmtr-us-central1': ['shop'] }, routers: [...ROUTERS, ...GOOGLE] });
    s.exclusions.set('x1', exclusion({ target: { kind: 'target-group', path: service('shop-app'), account: PROJECT, region: 'global', name: 'shop-app' } }));
    const op = await s.engine.create('exclude', { exclusionId: 'x1' }, 'ops@example.com');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    expect(s.googleCalls.map(([router, call]) => [router, (call as { backendService?: string }).backendService])).toEqual([['dmtr-europe-west2', service('shop-app')], ['dmtr-us-central1', service('shop-app')]]);
    expect(s.exclusions.get('x1')!.paused).toEqual([{ router: 'dmtr-us-central1', account: PROJECT, region: 'us-central1', workloadId: 'shop' }]);
  });

  it('pauses the workload a Google Cloud exclusion was created from, without a candidate, with the exclusion\'s path', async () => {
    const s = setup({ candidates: [], known: { 'dmtr-europe-west2': ['shop'] }, routers: GOOGLE });
    s.exclusions.set('x1', exclusion({ target: { kind: 'target-group', path: service('shop-app', 'europe-west2'), account: PROJECT, region: 'europe-west2', name: 'shop-app' } }));
    const op = await s.engine.create('exclude', { exclusionId: 'x1', hint: { workloadId: 'shop' } }, 'ops');
    await s.drive(op.id);
    expect(s.googleCalls.map(([router, p]) => [router, p.backendService])).toEqual([['dmtr-europe-west2', service('shop-app', 'europe-west2')]]);
    expect(s.exclusions.get('x1')!.paused).toEqual([{ router: 'dmtr-europe-west2', account: PROJECT, region: 'europe-west2', workloadId: 'shop' }]);
  });

  it('a project exclusion pauses the managed workloads of both its routers, each on the router that has it, and no AWS one', async () => {
    const s = setup({
      candidates: [managedOnGoogle('shop-app', 'shop'), managedOnGoogle('blog-app', 'blog', 'us-central1'), managedOnGoogle('new-app', 'new'), managed(1, 'aws-shop')],
      known: { 'dmtr-europe-west2': ['shop'], 'dmtr-us-central1': ['blog'], 'dmt-dev': ['aws-shop'] }, routers: [...ROUTERS, ...GOOGLE],
    });
    s.exclusions.set('x1', exclusion({ target: { kind: 'account', account: PROJECT, name: PROJECT } }));
    const op = await s.engine.create('exclude', { exclusionId: 'x1' }, 'ops@example.com');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    expect(s.exclusions.get('x1')!.paused).toEqual([
      { router: 'dmtr-europe-west2', account: PROJECT, region: 'europe-west2', workloadId: 'shop' }, { router: 'dmtr-us-central1', account: PROJECT, region: 'us-central1', workloadId: 'blog' },
    ]);
    expect(s.googleCalls.map(([router, p]) => `${router}/${p.workloadId} ${p.backendService}`)).toEqual([
      `dmtr-europe-west2/shop ${service('shop-app')}`,
      `dmtr-europe-west2/blog ${service('blog-app', 'us-central1')}`, `dmtr-us-central1/blog ${service('blog-app', 'us-central1')}`,
      `dmtr-europe-west2/new ${service('new-app')}`, `dmtr-us-central1/new ${service('new-app')}`,
    ]);
    expect(s.googleCalls.every(([, p]) => !('targetGroupArn' in p))).toBe(true);
    expect(s.calls.some(([router]) => router === 'dmt-dev')).toBe(false);
    expect((await s.records.getOperation(op.id))!.steps[0]!.detail).toBe('paused 2; not paused new: no registered router manages it');
  });

  it('a lift resumes them by its exclusionId on their routers; a workload offboarded since (resumed false) has nothing left, and the exclusion goes', async () => {
    const paused = [
      { router: 'dmtr-europe-west2', account: PROJECT, region: 'europe-west2', workloadId: 'shop' }, { router: 'dmtr-us-central1', account: PROJECT, region: 'us-central1', workloadId: 'blog' },
    ];
    const s = setup({ candidates: [], known: { 'dmtr-europe-west2': ['shop'] }, routers: [...ROUTERS, ...GOOGLE] });
    s.exclusions.set('x1', exclusion({ target: { kind: 'account', account: PROJECT, name: PROJECT }, paused, liftedAt: '2026-10-05T12:00:00.000Z' }));
    const op = await s.engine.create('lift-exclusion', { exclusionId: 'x1' }, 'ops@example.com');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    expect(s.googleCalls).toEqual([
      ['dmtr-europe-west2', { action: 'resume', workloadId: 'shop', by: 'ops@example.com', exclusionId: 'x1' }, 10_000],
      ['dmtr-us-central1', { action: 'resume', workloadId: 'blog', by: 'ops@example.com', exclusionId: 'x1' }, 10_000],
    ]);
    expect(s.exclusions.has('x1')).toBe(false);
    expect((await s.records.getOperation(op.id))!.steps[0]!.detail).toBe('every workload resumed');
  });

  it('a load-balancer exclusion (a URL map) pauses the managed workloads behind that URL map, not those of another map of the project', async () => {
    const s = setup({
      candidates: [managedOnGoogle('shop-app', 'shop'), managedOnGoogle('cart-app', 'cart'), managedOnGoogle('blog-app', 'blog', 'global', 'dmt-blog')],
      known: { 'dmtr-europe-west2': ['shop', 'cart', 'blog'] }, routers: GOOGLE,
    });
    s.exclusions.set('x1', exclusion({ target: { kind: 'load-balancer', path: urlMap('dmt-dev'), account: PROJECT, region: 'global', name: 'dmt-dev' } }));
    const op = await s.engine.create('exclude', { exclusionId: 'x1' }, 'ops@example.com');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    expect(s.googleCalls.map(([router, p]) => [router, p.workloadId, p.backendService])).toEqual([
      ['dmtr-europe-west2', 'shop', service('shop-app')], ['dmtr-europe-west2', 'cart', service('cart-app')],
    ]);
    expect(s.exclusions.get('x1')!.paused!.map((p) => p.workloadId)).toEqual(['shop', 'cart']);
  });

  describe('a Google Cloud router that can\'t be called', () => {
    // dmtr-old is below 0.40.0, dmtr-cut's controller refuses the manager's accounts, dmtr-slow never answers.
    const OLD: RouterRef = { ...GOOGLE[0]!, name: 'dmtr-old', region: 'asia-east1', controller: 'https://dmtr-asia-east1-controller-abc123-de.a.run.app', version: '0.39.2' };
    const CUT: RouterRef = { ...GOOGLE[0]!, name: 'dmtr-cut', region: 'europe-west1', controller: 'https://dmtr-europe-west1-controller-abc123-ew.a.run.app' };
    const SLOW: RouterRef = { ...GOOGLE[0]!, name: 'dmtr-slow', region: 'europe-west3', controller: 'https://dmtr-europe-west3-controller-abc123-ey.a.run.app' };
    const HOLDER = GOOGLE[1]!;
    const ACCESS = 'the manager\'s accounts can\'t reach the router: dormeto gcp connect --project dormeto-host --profile <profile> --env dev';
    const TOO_OLD = `router 0.39.2 can't report to the manager: dormeto gcp routers install --project ${PROJECT} --region asia-east1`;
    const down = {
      'dmtr-cut': () => Object.assign(new Error(ACCESS), { code: 'no_access' }),
      'dmtr-slow': () => new Error('no answer within 10000 ms'),
    };

    it('is passed over: one too old is never called, one that fails is called once in the run, and the router that has each workload pauses it', async () => {
      const s = setup({ candidates: [managedOnGoogle('shop-app', 'shop'), managedOnGoogle('blog-app', 'blog')], known: { 'dmtr-us-central1': ['shop', 'blog'] }, routers: [OLD, CUT, SLOW, HOLDER], down });
      s.exclusions.set('x1', exclusion({ target: { kind: 'account', account: PROJECT, name: PROJECT } }));
      const op = await s.engine.create('exclude', { exclusionId: 'x1' }, 'ops@example.com');
      expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
      expect(s.googleCalls.map(([router, p]) => `${router}/${p.workloadId}`)).toEqual(['dmtr-cut/shop', 'dmtr-slow/shop', 'dmtr-us-central1/shop', 'dmtr-us-central1/blog']);
      expect(s.exclusions.get('x1')!.paused).toEqual([
        { router: 'dmtr-us-central1', account: PROJECT, region: 'us-central1', workloadId: 'shop' }, { router: 'dmtr-us-central1', account: PROJECT, region: 'us-central1', workloadId: 'blog' },
      ]);
      expect((await s.records.getOperation(op.id))!.steps[0]!.detail).toBe('paused 2');
    });

    it('a workload no router paused names the errors of the routers that could not be asked', async () => {
      const s = setup({ candidates: [managedOnGoogle('shop-app', 'shop')], known: { 'dmtr-us-central1': [] }, routers: [OLD, CUT, SLOW, HOLDER], down });
      s.exclusions.set('x1', exclusion({ target: { kind: 'account', account: PROJECT, name: PROJECT } }));
      const op = await s.engine.create('exclude', { exclusionId: 'x1' }, 'ops@example.com');
      expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
      expect((await s.records.getOperation(op.id))!.steps[0]!.detail).toBe(
        `paused 0; not paused shop (dmtr-old): ${TOO_OLD}; not paused shop (dmtr-cut): ${ACCESS}; not paused shop (dmtr-slow): no answer within 10000 ms`,
      );
      expect(s.exclusions.get('x1')!.paused).toEqual([]);
    });

    it('a lift calls a router that failed once in the run: the pauses on it stay with the exclusion, the others are resumed', async () => {
      const paused = [
        { router: 'dmtr-slow', account: PROJECT, region: 'europe-west3', workloadId: 'shop' }, { router: 'dmtr-slow', account: PROJECT, region: 'europe-west3', workloadId: 'blog' },
        { router: 'dmtr-us-central1', account: PROJECT, region: 'us-central1', workloadId: 'news' },
      ];
      const s = setup({ candidates: [], known: { 'dmtr-us-central1': ['news'] }, routers: [OLD, CUT, SLOW, HOLDER], down });
      s.exclusions.set('x1', exclusion({ target: { kind: 'account', account: PROJECT, name: PROJECT }, paused, liftedAt: '2026-10-05T12:00:00.000Z' }));
      const op = await s.engine.create('lift-exclusion', { exclusionId: 'x1' }, 'ops@example.com');
      expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
      expect(s.googleCalls.map(([router, p]) => `${router}/${p.workloadId}`)).toEqual(['dmtr-slow/shop', 'dmtr-us-central1/news']);
      expect(s.exclusions.get('x1')!.paused!.map((p) => `${p.router}/${p.workloadId}`)).toEqual(['dmtr-slow/shop', 'dmtr-slow/blog']);
      expect((await s.records.getOperation(op.id))!.steps[0]!.detail).toBe(
        'not resumed: dmtr-slow/shop: no answer within 10000 ms; dmtr-slow/blog: no answer within 10000 ms (lift again to retry)',
      );
    });
  });
});

// A standalone workload (vision standalone workloads design §6): an exclusion of its resource, or of its account, pauses
// the whole workload, with no target group.
describe('exclusions of a standalone workload', () => {
  it('pause the workload of the excluded resource without a target group', async () => {
    const DB = `arn:aws:rds:eu-west-1:${ACCOUNT}:db:shop-db`;
    const db = {
      kind: 'standalone', id: DB, account: ACCOUNT, region: 'eu-west-1', resourceArn: DB, name: 'shop-db', backend: { kind: 'rds-instance', id: 'shop-db', arn: DB },
      tags: {}, eligibility: 'managed', workloadId: 'db', idleHours7d: null, accountName: 'dormeto', ouPath: [], scope: 'in', scopeReason: 'in', status: 'managed',
      statusReason: 'managed', firstSeenAt: 'x', lastSeenAt: 'x', history: [],
    } as unknown as Candidate;
    const s = setup({ candidates: [db, managed(1, 'shop')], known: { 'dmt-dev': ['db', 'shop'] } });
    s.exclusions.set('x1', exclusion({ target: { kind: 'resource', arn: DB, account: ACCOUNT, region: 'eu-west-1', name: 'shop-db' } }));
    const op = await s.engine.create('exclude', { exclusionId: 'x1' }, 'ops@example.com');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    expect(s.calls.filter(([, p]) => p.action === 'pause').map(([, p]) => p)).toEqual([{ action: 'pause', workloadId: 'db', by: 'ops@example.com', reason: 'excluded: migration', exclusionId: 'x1' }]);
    expect(s.exclusions.get('x1')!.paused).toEqual([{ router: 'dmt-dev', account: ACCOUNT, region: 'eu-west-1', workloadId: 'db' }]);
  });
});
