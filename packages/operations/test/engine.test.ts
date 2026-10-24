import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Candidate, DiscoveryStore } from '@dormeto/discovery';
import published from './fixtures/blueprint.json' with { type: 'json' };
import type { Blueprint } from '../src/blueprint.js';
import { Conflict, createEngine, type RouterRef } from '../src/engine.js';
import { createInstaller } from '../src/installer.js';
import { createRecords } from '../src/records.js';
import { fakeDynamo } from './dynamo-fake.js';
import { fakeInstallAccount } from './install-fake.js';
import { cluster as eksCluster, fakeEks } from './eks-fake.js';
import { fakeKubeAccount } from './kube-proxy-fake.js';
// @ts-expect-error the router's module has no type declarations
import { PLACEHOLDERS, blueprint as routerBlueprint } from '../../../../router/install/blueprint.mjs';

const T0 = Date.UTC(2026, 9, 5, 12, 0);
const ACCOUNT = '121014831971';
const TG = `arn:aws:elasticloadbalancing:eu-west-3:${ACCOUNT}:targetgroup/paris-app/73e2d6bc24d8a067`;
const LB = `arn:aws:elasticloadbalancing:eu-west-3:${ACCOUNT}:loadbalancer/app/paris/50dc6c495c0c9188`;
const RULE = `arn:aws:elasticloadbalancing:eu-west-3:${ACCOUNT}:listener-rule/app/paris/50dc6c495c0c9188/f2f7dc8efc522ab2/0000000000000001`;
const ZIP = new Uint8Array([1, 2, 3]);

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  id: TG, account: ACCOUNT, region: 'eu-west-3', loadBalancer: 'paris', loadBalancerArn: LB, listener: 'HTTPS:443', priority: '10', conditions: 'host paris.example.com',
  hosts: ['paris.example.com'], targetGroup: 'paris-app', targetGroupArn: TG, backend: { kind: 'instance', id: 'i-1' }, tags: {}, rules: [],
  eligibility: 'eligible', idleHours7d: 150, requests7d: 3, accountName: 'dormeto', ouPath: [], scope: 'in', scopeReason: 'in scope: filter "a", include 1',
  status: 'pending-onboarding', statusReason: 'eligible: instance i-1', firstSeenAt: '2026-10-05T10:00:00.000Z', lastSeenAt: '2026-10-05T10:00:00.000Z', history: [], ...over,
});

// clusters: those of the Kubernetes proxies' EC2 and Lambda (their cluster security groups), the same as eks's.
// version: the manager's own (VERSION), named in what to apply.
function setup({ routers = [] as RouterRef[], candidates = [candidate()], eks = fakeEks([]), clusters = [] as ReturnType<typeof eksCluster>[], version = undefined as string | undefined } = {}) {
  let now = T0;
  let ids = 0;
  const dynamo = fakeDynamo();
  const records = createRecords({ dynamo, table: 't', now: () => now });
  const account = fakeInstallAccount();
  const kube = fakeKubeAccount(clusters, { now: () => now });
  const items = new Map(candidates.map((c) => [c.id, c]));
  // Status changes of the candidates, as the discovery counts move with them.
  const moves: [string, string][] = [];
  const discovery = {
    getCandidate: async (id: string) => items.get(id) ?? null,
    replaceCandidates: async (after: Candidate[], before: Candidate[]) => {
      for (const c of after) {
        moves.push([before.find((b) => b.id === c.id)?.status ?? '', c.status]);
        items.set(c.id, c);
      }
    },
  } as unknown as DiscoveryStore;
  // The router functions of the target account: onboarder and controller actions.
  const invocations: [string, Record<string, unknown>][] = [];
  const router = { state: 'AWAKE', previewOk: true, echoesTags: true, workloads: 0, source: 'manager', controllerGone: false, wakeTimeout: 600, clusterChecks: {} as Record<string, unknown> };
  const invocationsPaused: Record<string, unknown>[] = [];
  const answers: Record<string, (p: Record<string, unknown>) => unknown> = {
    // Routers 0.20.0 and later derive the workload id from the target group (vision onboarding design, section 7).
    preview: (p) => (router.previewOk ? { ok: true, problems: [], workloadId: WORKLOAD_ID, name: p.name ?? 'paris-app', ...(router.echoesTags && p.tags ? { tags: p.tags } : {}) } : { ok: false, workloadId: WORKLOAD_ID, name: 'paris-app', problems: ['no backend: no instance, Auto Scaling group or ECS service feeds the target group'] }),
    onboard: (p) => ({ steps: [{ name: 'tag backends', status: 'done' }], workload: { workloadId: p.workloadId, wakerTargetGroupArn: 'arn:waker' } }),
    offboard: () => ({ steps: [{ name: 'restore rules', status: 'done' }] }),
    status: () => ({ state: router.state, name: 'Paris', source: router.source, route: 'app', issues: [], targetGroupArn: TG, rules: [{ arn: RULE }], settings: { wakeTimeoutSeconds: router.wakeTimeout } }),
    'force-wake': () => { router.state = 'WAKING'; return { state: 'WAKING' }; },
    pause: (p) => { invocationsPaused.push(p); if (router.state === 'ASLEEP') router.state = 'WAKING'; return { pause: {}, woken: [] }; },
    list: () => ({ workloads: Array.from({ length: router.workloads }, (_, i) => ({ workloadId: `w${i}` })) }),
    router: () => ({ router: { name: 'dmt-dev', version: '0.17.0', build: '1d50494cac65' } }),
    // Routers 0.29.0 and later: whether they reach a cluster and have the published ClusterRole's rights.
    clusterCheck: (p) => {
      const answer = router.clusterChecks[p.cluster as string];
      return (typeof answer === 'function' ? answer() : answer) ?? { cluster: p.cluster, reachable: true, allowed: true, missing: [] };
    },
  };
  const started: string[] = [];
  const engine = createEngine({
    records, discovery,
    routers: async () => [...routers, ...(await records.listRouters()).map((r) => ({ ...r, source: 'manager' as const }))],
    target: async () => ({
      eks,
      installer: (options) => createInstaller(account.ports, options),
      kubeProxies: { ...kube.ports, eks },
      invoke: async (functionArn, payload) => {
        invocations.push([functionArn, payload]);
        if (router.controllerGone && functionArn.endsWith('-controller')) throw Object.assign(new Error(`Function not found: ${functionArn}`), { name: 'ResourceNotFoundException' });
        return answers[payload.action as string]!(payload);
      },
    }),
    bundle: async () => ({ blueprint: BUNDLE, zip: ZIP, codeSha256: createHash('sha256').update(ZIP).digest('base64') }),
    settings: { env: 'dev', ...(version ? { version } : {}), principals: [`arn:aws:iam::${ACCOUNT}:role/dmt-dev-manager-api`], routerSettings: { ipListsCatalog: 's3://dmt-dev-manager-ip-lists-121014831971/catalog.json', ipListsBucket: 'dmt-dev-manager-ip-lists-121014831971', checkSchedule: 'rate(5 minutes)', ipLists: '[]', noWakeRules: '[]', metrics: 'false', managerBus: BUS, commandRole: 'DmtCommandRole' } },
    start: async (op) => { started.push(op.id); return `arn:execution:${op.id}`; },
    now: () => now, newId: () => `op${++ids}`, log: { info() {}, warn() {}, error() {} },
  });
  // Runs the workflow loop: next until done, waiting as asked.
  async function drive(id: string, { maxIterations = 200, between = () => {} }: { maxIterations?: number; between?: () => void } = {}) {
    for (let i = 0; i < maxIterations; i += 1) {
      const r = await engine.next(id);
      if (r.done) return r;
      now += (r.waitSeconds ?? 0) * 1000;
      between();
    }
    throw new Error('the operation never finished');
  }
  return { engine, records, account, kube, invocations, invocationsPaused, router, answers, items, moves, started, drive, eks, advance: (ms: number) => { now += ms; }, now: () => now };
}

// The published blueprint with the Kubernetes proxy's definition of routers 0.33.0 (router install/blueprint.mjs), as
// `npm run package` publishes it.
const BUNDLE = { ...published, kubeProxy: routerBlueprint({ version: published.router.version, p: { ...PLACEHOLDERS, build: published.router.build } }).kubeProxy } as unknown as Blueprint;

const DEV_ROUTER: RouterRef = {
  name: 'dmt-dev', account: ACCOUNT, region: 'eu-west-3', controller: `arn:aws:lambda:eu-west-3:${ACCOUNT}:function:dmt-dev-controller`,
  onboarder: `arn:aws:lambda:eu-west-3:${ACCOUNT}:function:dmt-dev-onboarder`, source: 'terraform',
};

const WORKLOAD_ID = '7010ea54b5c02245';
const BUS = 'arn:aws:events:eu-west-1:121014831971:event-bus/dmt-dev-manager';

describe('operations engine', () => {
  it('onboards a candidate with an existing router: slot, lock, preview, onboard, verify, candidate managed, everything released', async () => {
    const s = setup({ routers: [DEV_ROUTER] });
    const op = await s.engine.create('onboard', { candidateId: TG, name: 'Paris', settings: { idleMinutes: 30 } }, 'ops@example.com');
    expect(s.started).toEqual([op.id]);
    const result = await s.drive(op.id);
    expect(result).toEqual({ done: true, status: 'succeeded' });
    const stored = (await s.records.getOperation(op.id))!;
    expect(stored.steps.map((x) => [x.name, x.status])).toEqual([
      ['find router', 'done'], ['lock router', 'skipped'], ...['roles', 'table', 'queues', 'log groups', 'functions', 'async invoke', 'event source mappings', 'permissions', 'event rule', 'schedule'].map((n) => [`install ${n}`, 'skipped']),
      ['register router', 'skipped'], ['access entries', 'skipped'], ['kubernetes proxies', 'skipped'], ['check clusters', 'skipped'],
      ['slot', 'done'], ['lock load balancer', 'done'], ['preview', 'done'], ['onboard', 'done'], ['verify', 'done'], ['candidate', 'done'],
    ]);
    expect(s.invocations.map(([fn, p]) => [fn.split(':').at(-1), p.action])).toEqual([['dmt-dev-onboarder', 'preview'], ['dmt-dev-onboarder', 'onboard'], ['dmt-dev-controller', 'status']]);
    // The onboarder derives the id at the preview; the onboard step passes it back with the name.
    expect(s.invocations[0]![1]).toEqual({ action: 'preview', targetGroupArn: TG, name: 'Paris', settings: { idleMinutes: 30 }, databases: [] });
    expect(s.invocations[1]![1]).toEqual({ action: 'onboard', workloadId: WORKLOAD_ID, targetGroupArn: TG, name: 'Paris', settings: { idleMinutes: 30 }, databases: [], by: 'ops@example.com' });
    expect(stored.steps.find((x) => x.name === 'preview')!.detail).toBe(`Paris (${WORKLOAD_ID})`);
    expect(s.account.state.roles.size, 'a Terraform router is never touched').toBe(0);
    expect(s.items.get(TG)).toMatchObject({ eligibility: 'managed', workloadId: WORKLOAD_ID, status: 'managed' });
    expect(s.moves).toEqual([['pending-onboarding', 'managed']]);
    expect(await s.records.acquireLock(`LB#${LB}`, 'other', 60_000)).toBe(true);
    expect(await s.records.claimActive(`TG#${TG}`, 'other', 60_000)).toEqual({ ok: true });
  });

  it('passes the tags of its input to the preview and the onboarding', async () => {
    const s = setup({ routers: [DEV_ROUTER] });
    const op = await s.engine.create('onboard', { candidateId: TG, name: 'Paris', settings: {}, tags: { team: 'payments' } }, 'ops@example.com');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    expect(s.invocations[0]![1]).toMatchObject({ action: 'preview', tags: { team: 'payments' } });
    expect(s.invocations[1]![1]).toMatchObject({ action: 'onboard', tags: { team: 'payments' } });
  });

  it('fails an onboarding with tags when the router\'s preview does not echo them (a router before 0.30.0)', async () => {
    const s = setup({ routers: [DEV_ROUTER] });
    s.router.echoesTags = false;
    const op = await s.engine.create('onboard', { candidateId: TG, name: 'Paris', settings: {}, tags: { team: 'payments' } }, 'ops@example.com');
    await s.drive(op.id);
    const stored = (await s.records.getOperation(op.id))!;
    expect(stored.status).toBe('failed');
    expect(JSON.stringify(stored.steps)).toContain('router dmt-dev is older than 0.30.0: upgrade it to onboard with tags');
    expect(s.invocations.map(([, p]) => p.action)).toEqual(['preview']);
  });

  it('installs the router of a new account and region first, waiting for the table and the IAM propagation, and registers it', async () => {
    const s = setup();
    const op = await s.engine.create('onboard', { candidateId: TG, workloadId: 'paris' }, 'ops@example.com');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    const stored = (await s.records.getOperation(op.id))!;
    expect(stored.steps.filter((x) => x.name.startsWith('install ')).map((x) => x.status)).toEqual(['done', 'done', 'done', 'done', 'done', 'done', 'done', 'done', 'done', 'done']);
    expect(stored.steps.find((x) => x.name === 'install functions')!.attempts).toBeGreaterThan(1);
    expect(await s.records.getRouter(ACCOUNT, 'eu-west-3')).toMatchObject({
      name: 'dmtr-dev', controller: `arn:aws:lambda:eu-west-3:${ACCOUNT}:function:dmtr-dev-controller`, onboarder: `arn:aws:lambda:eu-west-3:${ACCOUNT}:function:dmtr-dev-onboarder`,
      version: published.router.version, build: published.router.build, installedBy: 'ops@example.com',
    });
    expect([...s.account.state.functions.keys()]).toEqual(['dmtr-dev-controller', 'dmtr-dev-waker', 'dmtr-dev-onboarder']);
    // The router sends its state to the manager's event bus (scale design §3).
    expect((s.account.state.functions.get('dmtr-dev-controller')!.config.Environment as { Variables: Record<string, string> }).Variables.DMT_MANAGER_BUS).toBe(BUS);
    // The manager's IP lists (R6b): the waker and the controller read its catalog.
    for (const fn of ['dmtr-dev-controller', 'dmtr-dev-waker']) {
      expect((s.account.state.functions.get(fn)!.config.Environment as { Variables: Record<string, string> }).Variables.DMT_IP_LISTS_CATALOG).toBe('s3://dmt-dev-manager-ip-lists-121014831971/catalog.json');
    }
  });

  it('a second request for the same target is a conflict naming the running operation', async () => {
    const s = setup({ routers: [DEV_ROUTER] });
    const op = await s.engine.create('onboard', { candidateId: TG, workloadId: 'paris' }, 'ops');
    await expect(s.engine.create('onboard', { candidateId: TG, workloadId: 'paris2' }, 'ops')).rejects.toThrow(new Conflict(op.id));
    expect(s.started).toEqual([op.id]);
  });

  it('a refused preview fails the operation with its problems and releases everything', async () => {
    const s = setup({ routers: [DEV_ROUTER] });
    s.router.previewOk = false;
    const op = await s.engine.create('onboard', { candidateId: TG, workloadId: 'paris' }, 'ops');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'failed' });
    const stored = (await s.records.getOperation(op.id))!;
    expect(stored.error).toBe('preview: no backend: no instance, Auto Scaling group or ECS service feeds the target group');
    expect(stored.steps.find((x) => x.name === 'preview')!.status).toBe('failed');
    expect(s.invocations.some(([, p]) => p.action === 'onboard')).toBe(false);
    expect(await s.records.acquireLock(`LB#${LB}`, 'other', 60_000)).toBe(true);
    expect(await s.records.claimActive(`TG#${TG}`, 'other', 60_000)).toEqual({ ok: true });
  });

  it('waits while another operation holds the load balancer, and gives up after 30 minutes', async () => {
    const s = setup({ routers: [DEV_ROUTER] });
    await s.records.acquireLock(`LB#${LB}`, 'someone', 60 * 60_000);
    const op = await s.engine.create('onboard', { candidateId: TG, workloadId: 'paris' }, 'ops');
    let waits = 0;
    for (;;) {
      const r = await s.engine.next(op.id);
      if (r.done) break;
      if ((await s.records.getOperation(op.id))!.steps[(await s.records.getOperation(op.id))!.cursor]!.name === 'lock load balancer') waits += 1;
      s.advance((r.waitSeconds ?? 0) * 1000);
    }
    const stored = (await s.records.getOperation(op.id))!;
    expect(waits).toBeGreaterThan(10);
    expect([stored.status, stored.error]).toEqual(['failed', 'lock load balancer: another operation holds the load balancer since more than 30 minutes']);
  });

  it('an operation waiting for a slot of its account and region keeps waiting past 30 minutes, at growing intervals', async () => {
    const s = setup({ routers: [DEV_ROUTER] });
    for (const holder of ['a', 'b', 'c']) await s.records.acquireSlot(`${ACCOUNT}#eu-west-3`, holder, 3, 24 * 60 * 60_000);
    const op = await s.engine.create('onboard', { candidateId: TG, workloadId: 'paris' }, 'ops');
    const waits: number[] = [];
    while (s.now() - Date.parse(op.createdAt) < 2 * 60 * 60_000) {
      const r = await s.engine.next(op.id);
      expect(r.done).toBe(false);
      if ((await s.records.getOperation(op.id))!.steps.find((x) => x.name === 'slot')!.status === 'running') waits.push(r.waitSeconds!);
      s.advance((r.waitSeconds ?? 0) * 1000);
    }
    // A burst of onboardings waits its turn: intervals grow to a minute, never a failure.
    expect(waits.slice(0, 4)).toEqual([10, 20, 40, 60]);
    expect(Math.max(...waits)).toBe(60);
    await s.records.releaseSlot(`${ACCOUNT}#eu-west-3`, 'a');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
  });

  it('at most 50 operations run at once across the organization: the 51st waits until one ends', async () => {
    const s = setup({ routers: [DEV_ROUTER] });
    for (let i = 0; i < 50; i += 1) await s.records.acquireSlot('ORG', `op-${i}`, 50, 24 * 60 * 60_000);
    const op = await s.engine.create('onboard', { candidateId: TG, workloadId: 'paris' }, 'ops');
    const r = await s.engine.next(op.id);
    expect(r.done).toBe(false);
    expect((await s.records.getOperation(op.id))!.steps[0]!.detail).toBe('50 operations already run across the organization: waiting for one to end');
    await s.records.releaseSlot('ORG', 'op-7');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    // Its place is given back when it ends.
    expect(await s.records.slotHolders('ORG')).toHaveLength(49);
  });

  it('an operation still waiting for a slot 24 hours after it started fails, releasing what it holds, before the workflow times out', async () => {
    const DAY = 24 * 60 * 60_000;
    const s = setup({ routers: [DEV_ROUTER] });
    for (const holder of ['a', 'b', 'c']) await s.records.acquireSlot(`${ACCOUNT}#eu-west-3`, holder, 3, 3 * DAY);
    const op = await s.engine.create('onboard', { candidateId: TG, workloadId: 'paris' }, 'ops');
    expect(await s.drive(op.id, { maxIterations: 3000 })).toEqual({ done: true, status: 'failed' });
    const stored = (await s.records.getOperation(op.id))!;
    expect(stored.error).toBe(`slot: waited more than 24 hours for a slot: 3 operations already run in ${ACCOUNT}/eu-west-3`);
    expect(s.now() - T0).toBeGreaterThan(DAY);
    expect(s.now() - T0).toBeLessThan(DAY + 2 * 60_000);
    expect(stored.holds).toEqual({ locks: [], slots: [] });
    expect(await s.records.acquireLock(`LB#${LB}`, 'other', 60_000)).toBe(true);
    // The same for a wait for the organization's places.
    const org = setup({ routers: [DEV_ROUTER] });
    for (let i = 0; i < 50; i += 1) await org.records.acquireSlot('ORG', `op-${i}`, 50, 3 * DAY);
    const queued = await org.engine.create('onboard', { candidateId: TG, workloadId: 'paris' }, 'ops');
    expect(await org.drive(queued.id, { maxIterations: 3000 })).toEqual({ done: true, status: 'failed' });
    expect((await org.records.getOperation(queued.id))!.error).toBe('find router: waited more than 24 hours for a slot: 50 operations already run across the organization: waiting for one to end');
  });

  it('two onboardings on one load balancer waiting for a slot hold no lock meanwhile: both run once slots free, past 30 minutes', async () => {
    const TG2 = TG.replace('paris-app/73e2d6bc24d8a067', 'paris-api/83e2d6bc24d8a068');
    const s = setup({ routers: [DEV_ROUTER], candidates: [candidate(), candidate({ id: TG2, targetGroup: 'paris-api', targetGroupArn: TG2 })] });
    for (const holder of ['a', 'b', 'c']) await s.records.acquireSlot(`${ACCOUNT}#eu-west-3`, holder, 3, 24 * 60 * 60_000);
    const ops = [await s.engine.create('onboard', { candidateId: TG }, 'ops'), await s.engine.create('onboard', { candidateId: TG2 }, 'ops')];
    // Both workflows run side by side: the earliest due runs next.
    const due = new Map(ops.map((op) => [op.id, s.now()]));
    const results: Record<string, unknown> = {};
    while (due.size) {
      const [id, at] = [...due].sort((x, y) => x[1] - y[1])[0]!;
      s.advance(Math.max(0, at - s.now()));
      // The slots free after 45 minutes.
      if (s.now() - T0 > 45 * 60_000) for (const holder of ['a', 'b']) await s.records.releaseSlot(`${ACCOUNT}#eu-west-3`, holder);
      const r = await s.engine.next(id);
      if (r.done) {
        results[id] = r;
        due.delete(id);
      } else due.set(id, s.now() + (r.waitSeconds ?? 0) * 1000);
    }
    expect(results).toEqual({ [ops[0]!.id]: { done: true, status: 'succeeded' }, [ops[1]!.id]: { done: true, status: 'succeeded' } });
  });

  it('offboards: wakes the workload, waits until awake, offboards, and the candidate is onboardable again', async () => {
    const s = setup({ routers: [DEV_ROUTER], candidates: [candidate({ eligibility: 'managed', workloadId: 'paris', status: 'managed', statusReason: 'managed' })] });
    s.router.state = 'ASLEEP';
    const op = await s.engine.create('offboard', { router: 'dmt-dev', account: ACCOUNT, region: 'eu-west-3', workloadId: 'paris' }, 'ops');
    let polls = 0;
    const result = await s.drive(op.id, { between: () => { if (s.router.state === 'WAKING' && (polls += 1) > 3) s.router.state = 'AWAKE'; } });
    expect(result).toEqual({ done: true, status: 'succeeded' });
    expect((await s.records.getOperation(op.id))!.steps.map((x) => [x.name, x.status])).toEqual([
      ['locate', 'done'], ['slot', 'done'], ['lock load balancer', 'done'], ['pause', 'done'], ['wait awake', 'done'], ['offboard', 'done'], ['candidate', 'done'],
    ]);
    // Paused (it wakes an asleep workload): no nap can start while the instrumentation goes.
    expect(s.invocationsPaused).toEqual([{ action: 'pause', workloadId: 'paris', by: 'ops', reason: 'offboarding', keepAsleep: false }]);
    const actions = s.invocations.map(([, p]) => p.action);
    expect(actions.slice(0, 2)).toEqual(['status', 'pause']);
    expect(actions.at(-1)).toBe('offboard');
    expect(new Set(actions.slice(2, -1))).toEqual(new Set(['status']));
    expect(actions.length).toBeGreaterThan(4);
    expect(s.items.get(TG)).toMatchObject({ eligibility: 'eligible', status: 'pending-onboarding' });
    expect(s.items.get(TG)!.workloadId).toBeUndefined();
    expect(s.moves).toEqual([['managed', 'pending-onboarding']]);
    // The name comes from the router (the operation's title), never from the request.
    expect((await s.records.getOperation(op.id))!.context.name).toBe('Paris');
  });

  it('an onboarding started before the manager learnt ids from the preview finds its id again at the onboard step', async () => {
    const s = setup({ routers: [DEV_ROUTER] });
    const op = await s.engine.create('onboard', { candidateId: TG }, 'ops');
    // Run up to the onboard step, then forget what the preview learnt (an operation of the previous version).
    for (let i = 0; i < 50; i += 1) {
      const current = (await s.records.getOperation(op.id))!;
      if (current.steps[current.cursor]!.name === 'onboard') {
        const { workloadId: _w, name: _n, ...rest } = current.context;
        await s.records.putOperation({ ...current, context: rest });
        break;
      }
      await s.engine.next(op.id);
    }
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    const onboard = s.invocations.find(([, p]) => p.action === 'onboard')![1];
    expect([onboard.workloadId, onboard.name]).toEqual([WORKLOAD_ID, 'paris-app']);
    expect(s.invocations.find(([, p]) => p.action === 'status')![1].workloadId).toBe(WORKLOAD_ID);
  });

  it('uninstalling a router with workloads is refused; without, every resource is deleted and the router unregistered', async () => {
    const s = setup();
    const install = await s.engine.create('install-router', { account: ACCOUNT, region: 'eu-west-3' }, 'admin');
    expect(await s.drive(install.id)).toEqual({ done: true, status: 'succeeded' });
    s.router.workloads = 1;
    const refused = await s.engine.create('uninstall-router', { account: ACCOUNT, region: 'eu-west-3' }, 'admin');
    expect(await s.drive(refused.id)).toEqual({ done: true, status: 'failed' });
    expect((await s.records.getOperation(refused.id))!.error).toBe('check empty: router dmtr-dev still has 1 workload: offboard it first');
    s.router.workloads = 0;
    const uninstall = await s.engine.create('uninstall-router', { account: ACCOUNT, region: 'eu-west-3' }, 'admin');
    expect(await s.drive(uninstall.id)).toEqual({ done: true, status: 'succeeded' });
    expect([s.account.state.roles.size, s.account.state.functions.size, s.account.state.tables.size]).toEqual([0, 0, 0]);
    expect(await s.records.getRouter(ACCOUNT, 'eu-west-3')).toBeNull();
  });

  it('refuses to install a router where one exists, and to uninstall a router written by Terraform', async () => {
    const s = setup({ routers: [DEV_ROUTER] });
    const install = await s.engine.create('install-router', { account: ACCOUNT, region: 'eu-west-3' }, 'admin');
    expect(await s.drive(install.id)).toEqual({ done: true, status: 'failed' });
    expect((await s.records.getOperation(install.id))!.error).toBe('find router: router dmt-dev is already in 121014831971/eu-west-3');
    const uninstall = await s.engine.create('uninstall-router', { account: ACCOUNT, region: 'eu-west-3' }, 'admin');
    expect(await s.drive(uninstall.id)).toEqual({ done: true, status: 'failed' });
    expect((await s.records.getOperation(uninstall.id))!.error).toBe('find router: router dmt-dev was installed by Terraform: remove it with Terraform');
  });

  it('a started workflow whose record cannot take its execution afterwards still answers the operation, which runs', async () => {
    const s = setup({ routers: [DEV_ROUTER] });
    const put = s.records.putOperation.bind(s.records);
    let puts = 0;
    s.records.putOperation = async (op) => {
      puts += 1;
      if (puts === 2) throw Object.assign(new Error('Throughput exceeded'), { name: 'ProvisionedThroughputExceededException' });
      return put(op);
    };
    const op = await s.engine.create('onboard', { candidateId: TG, workloadId: 'paris' }, 'ops');
    expect(s.started).toEqual([op.id]);
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
  });

  it('a workflow failure releases what the operation holds and records the error', async () => {
    const s = setup({ routers: [DEV_ROUTER] });
    const op = await s.engine.create('onboard', { candidateId: TG, workloadId: 'paris' }, 'ops');
    for (let i = 0; i < 18; i += 1) await s.engine.next(op.id); // up to the load balancer's lock (after the cluster steps)
    expect((await s.records.getOperation(op.id))!.holds.locks).toEqual([`LB#${LB}`]);
    await s.engine.fail(op.id, 'States.Timeout: the task timed out');
    const stored = (await s.records.getOperation(op.id))!;
    expect([stored.status, stored.error, stored.holds]).toEqual(['failed', 'States.Timeout: the task timed out', { locks: [], slots: [] }]);
    expect(await s.records.acquireLock(`LB#${LB}`, 'other', 60_000)).toBe(true);
  });
});

describe('pending steps', () => {
  it('a step that stays pending fails after 30 minutes instead of looping until the workflow timeout', async () => {
    const s = setup();
    const op = await s.engine.create('install-router', { account: ACCOUNT, region: 'eu-west-3' }, 'admin');
    s.account.ports.dynamodb.describeTable = async () => ({ Table: { TableStatus: 'CREATING' } });
    s.account.ports.dynamodb.createTable = async () => ({});
    expect(await s.drive(op.id, { maxIterations: 1000 })).toEqual({ done: true, status: 'failed' });
    expect((await s.records.getOperation(op.id))!.error).toBe('install table: still pending after 30 minutes (table dmtr-dev-router CREATING)');
  });
});

describe('review fixes', () => {
  it('refuses to offboard a workload written in Terraform before waking it', async () => {
    const s = setup({ routers: [DEV_ROUTER] });
    s.router.source = 'terraform';
    s.router.state = 'ASLEEP';
    const op = await s.engine.create('offboard', { router: 'dmt-dev', account: ACCOUNT, region: 'eu-west-3', workloadId: 'demo' }, 'ops');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'failed' });
    expect((await s.records.getOperation(op.id))!.error).toBe('locate: workload demo was written in Terraform: remove its workload module instead');
    expect(s.invocations.map(([, p]) => p.action)).toEqual(['status']);
  });

  it('an uninstall that failed after deleting the controller can run again to the end', async () => {
    const s = setup();
    await s.drive((await s.engine.create('install-router', { account: ACCOUNT, region: 'eu-west-3' }, 'admin')).id);
    await s.account.ports.lambda.deleteFunction({ FunctionName: 'dmtr-dev-controller' });
    s.router.controllerGone = true;
    const op = await s.engine.create('uninstall-router', { account: ACCOUNT, region: 'eu-west-3' }, 'admin');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    expect(await s.records.getRouter(ACCOUNT, 'eu-west-3')).toBeNull();
  });

  it('an uninstall waits for the operations running on the router, and onboarding refuses a router being uninstalled', async () => {
    const s = setup();
    await s.drive((await s.engine.create('install-router', { account: ACCOUNT, region: 'eu-west-3' }, 'admin')).id);
    await s.records.acquireSlot(`${ACCOUNT}#eu-west-3`, 'running-onboarding', 3, 60 * 60_000);
    const uninstall = await s.engine.create('uninstall-router', { account: ACCOUNT, region: 'eu-west-3' }, 'admin');
    for (let i = 0; i < 6; i += 1) {
      const r = await s.engine.next(uninstall.id);
      s.advance((r.waitSeconds ?? 0) * 1000);
    }
    const waiting = (await s.records.getOperation(uninstall.id))!;
    expect(waiting.steps[waiting.cursor]!.name).toBe('check empty');
    expect((await s.records.getRouter(ACCOUNT, 'eu-west-3'))!.uninstalling).toBe(true);
    const onboard = await s.engine.create('onboard', { candidateId: TG, workloadId: 'paris' }, 'ops');
    expect(await s.drive(onboard.id)).toEqual({ done: true, status: 'failed' });
    expect((await s.records.getOperation(onboard.id))!.error).toBe('find router: router dmtr-dev is being uninstalled');
    await s.records.releaseSlot(`${ACCOUNT}#eu-west-3`, 'running-onboarding');
    expect(await s.drive(uninstall.id)).toEqual({ done: true, status: 'succeeded' });
  });

  it('renews the locks it holds while it runs, so that a long wait never lets another operation in', async () => {
    const s = setup({ routers: [DEV_ROUTER], candidates: [candidate({ eligibility: 'managed', workloadId: 'paris', status: 'managed' })] });
    s.router.state = 'ASLEEP';
    s.router.wakeTimeout = 3600;
    const op = await s.engine.create('offboard', { router: 'dmt-dev', account: ACCOUNT, region: 'eu-west-3', workloadId: 'paris' }, 'ops');
    for (let i = 0; i < 4; i += 1) await s.engine.next(op.id);
    // Waking for 61 minutes, longer than the 60-minute lease: the lock is renewed at each step.
    for (let i = 0; i < 244; i += 1) {
      s.advance(15_000);
      await s.engine.next(op.id);
    }
    expect((await s.records.getOperation(op.id))!.status).toBe('running');
    expect(await s.records.acquireLock(`LB#${LB}`, 'intruder', 60_000)).toBe(false);
  });
});

describe('transient errors', () => {
  it('a step whose AWS error stays transient fails after 30 retries', async () => {
    const s = setup();
    s.account.ports.dynamodb.updateContinuousBackups = async () => { throw Object.assign(new Error('Backups are being enabled for the table: dmtr-dev-router. Please retry later'), { name: 'ContinuousBackupsUnavailableException' }); };
    const op = await s.engine.create('install-router', { account: ACCOUNT, region: 'eu-west-3' }, 'admin');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'failed' });
    const step = (await s.records.getOperation(op.id))!.steps.find((x) => x.name === 'install table')!;
    expect([step.status, step.detail]).toEqual(['failed', 'Backups are being enabled for the table: dmtr-dev-router. Please retry later']);
    expect(step.retries).toBe(30);
  });

  it('waits and retries a step on a transient AWS error instead of failing the operation', async () => {
    const s = setup();
    const update = s.account.ports.dynamodb.updateContinuousBackups;
    let refused = 2;
    s.account.ports.dynamodb.updateContinuousBackups = async (input) => {
      if (refused-- > 0) throw Object.assign(new Error('Backups are being enabled for the table: dmtr-dev-router. Please retry later'), { name: 'ContinuousBackupsUnavailableException' });
      return update(input);
    };
    const op = await s.engine.create('install-router', { account: ACCOUNT, region: 'eu-west-3' }, 'admin');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    expect((await s.records.getOperation(op.id))!.steps.find((x) => x.name === 'install table')!.attempts).toBeGreaterThan(3);
  });
});

describe('onboarding on a router older than 0.20.0', () => {
  it('fails at the preview, asking for an upgrade (the router cannot derive the workload id)', async () => {
    const s = setup({ routers: [DEV_ROUTER] });
    s.answers.preview = () => ({ ok: false, problems: ['workload id: lowercase letters, digits and hyphens, not starting or ending with a hyphen'] });
    const op = await s.engine.create('onboard', { candidateId: TG }, 'ops');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'failed' });
    expect((await s.records.getOperation(op.id))!.error).toMatch(/router dmt-dev is older than 0.20.0: upgrade it to onboard/);
  });
});

// Kubernetes workloads (vision docs/specs/2026-10-11-kubernetes-design.md, section 4): the router's access entries in the
// clusters of its account and region, and its check of each.
describe('cluster access', () => {
  const ROLE = (r: string) => `arn:aws:iam::${ACCOUNT}:role/dormeto/router/dmtr-dev-eu-west-3-${r}`;
  const k8sCandidate = () => candidate({
    backend: { kind: 'k8s', id: 'eks-demo/demo/Deployment/web', kubernetes: { cluster: 'eks-demo', namespace: 'demo', owner: { kind: 'Deployment', name: 'web' }, switch: 'ingress', ingress: { name: 'web', ruleIndex: 0, groupOrder: -1, service: { name: 'web', port: { number: 80 } } }, hpa: false, keda: false, capacity: 'nodes', autoscaler: 'karpenter' } } as Candidate['backend'],
  });

  it('keeps how each cluster was reached: directly, through its proxy with its version or without, and nothing for a router that does not say', async () => {
    const s = setup({ eks: fakeEks([eksCluster('eks-demo')]) });
    s.router.clusterChecks['eks-demo'] = { cluster: 'eks-demo', reachable: true, allowed: true, missing: [], via: 'proxy', proxy: { name: 'dmt-dev-kube-eks-demo', version: null } };
    const op = await s.engine.create('install-router', { account: ACCOUNT, region: 'eu-west-3' }, 'admin@example.com');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    const at = new Date(s.now()).toISOString();
    expect((await s.records.getRouter(ACCOUNT, 'eu-west-3'))!.clusters).toEqual([{ name: 'eks-demo', reachable: true, allowed: true, missing: [], via: 'proxy', proxy: { name: 'dmt-dev-kube-eks-demo', version: null }, checkedAt: at }]);
  });

  it('keeps nothing about the way for a router that does not say, and "direct" when it does', async () => {
    for (const [answer, expected] of [[{}, {}], [{ via: 'direct' }, { via: 'direct' }]] as const) {
      const s = setup({ eks: fakeEks([eksCluster('eks-demo')]) });
      s.router.clusterChecks['eks-demo'] = { cluster: 'eks-demo', reachable: true, allowed: true, missing: [], ...answer };
      const op = await s.engine.create('install-router', { account: ACCOUNT, region: 'eu-west-3' }, 'admin@example.com');
      await s.drive(op.id);
      expect((await s.records.getRouter(ACCOUNT, 'eu-west-3'))!.clusters).toEqual([{ name: 'eks-demo', reachable: true, allowed: true, missing: [], ...expected, checkedAt: new Date(s.now()).toISOString() }]);
    }
  });

  it('a router installed where a cluster runs gets its access entries, and each cluster\'s check is kept on the router', async () => {
    const s = setup({ eks: fakeEks([eksCluster('eks-demo')]) });
    const op = await s.engine.create('install-router', { account: ACCOUNT, region: 'eu-west-3' }, 'admin@example.com');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    const stored = (await s.records.getOperation(op.id))!;
    expect(stored.steps.map((x) => x.name).slice(-5)).toEqual(['register router', 'access entries', 'kubernetes proxies', 'check clusters', 'verify router']);
    expect(stored.steps.find((x) => x.name === 'access entries')).toMatchObject({ status: 'done', detail: 'cluster eks-demo: access entries created for 3 router roles (group dormeto:router) and DmtDiscoveryRole (AmazonEKSViewPolicy)' });
    expect(s.eks.writes.filter(([w]) => w === 'createAccessEntry').map(([, i]) => i.principalArn)).toEqual([ROLE('controller'), ROLE('waker'), ROLE('onboarder'), `arn:aws:iam::${ACCOUNT}:role/DmtDiscoveryRole`]);
    expect(stored.steps.find((x) => x.name === 'check clusters')).toMatchObject({ status: 'done', detail: 'cluster eks-demo: reachable, every right' });
    expect((await s.records.getRouter(ACCOUNT, 'eu-west-3'))!.clusters).toEqual([{ name: 'eks-demo', reachable: true, allowed: true, missing: [], checkedAt: new Date(s.now()).toISOString() }]);
  });

  it('onboarding a Kubernetes candidate makes the access entries first and gives the onboarder its kubernetes', async () => {
    const s = setup({ candidates: [k8sCandidate()], eks: fakeEks([eksCluster('eks-demo')]) });
    const op = await s.engine.create('onboard', { candidateId: TG }, 'ops@example.com');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    const stored = (await s.records.getOperation(op.id))!;
    expect(stored.steps.find((x) => x.name === 'access entries')!.status).toBe('done');
    const preview = s.invocations.find(([, p]) => p.action === 'preview')![1];
    const onboard = s.invocations.find(([, p]) => p.action === 'onboard')![1];
    expect(preview.kubernetes).toEqual((k8sCandidate().backend as { kubernetes: unknown }).kubernetes);
    expect(onboard.kubernetes).toEqual(preview.kubernetes);
  });

  // EKS takes some seconds to honour a new access entry: until then the cluster does not know the router's role.
  const unknownRole = { cluster: 'eks-demo', reachable: true, allowed: false, missing: [], reason: 'the cluster does not know the router\'s role (no access entry, or not mapped in aws-auth): Unauthorized' };
  it('the cluster is checked again while it does not know the access entries just made, up to 2 minutes', async () => {
    const s = setup({ candidates: [k8sCandidate()], eks: fakeEks([eksCluster('eks-demo')]) });
    let checks = 0;
    s.router.clusterChecks['eks-demo'] = () => (++checks < 4 ? unknownRole : undefined);
    const op = await s.engine.create('onboard', { candidateId: TG }, 'ops@example.com');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    expect(checks).toBe(4);
    expect((await s.records.getRouter(ACCOUNT, 'eu-west-3'))!.clusters![0]).toMatchObject({ name: 'eks-demo', allowed: true });

    // Still unknown after 2 minutes: the onboarding stops with the cluster's answer.
    const late = setup({ candidates: [k8sCandidate()], eks: fakeEks([eksCluster('eks-demo')]) });
    late.router.clusterChecks['eks-demo'] = unknownRole;
    const failed = await late.engine.create('onboard', { candidateId: TG }, 'ops@example.com');
    expect(await late.drive(failed.id)).toEqual({ done: true, status: 'failed' });
    expect((await late.records.getOperation(failed.id))!.error).toMatch(/^check clusters: cluster eks-demo: the cluster does not know the router's role/);
  });

  it('entries already in place are not waited for: an unknown role fails the onboarding at once', async () => {
    const s = setup({ candidates: [k8sCandidate()], eks: fakeEks([eksCluster('eks-demo')]) });
    let checks = 0;
    s.router.clusterChecks['eks-demo'] = () => (++checks, unknownRole);
    await s.drive((await s.engine.create('install-router', { account: ACCOUNT, region: 'eu-west-3' }, 'admin')).id);
    checks = 0;
    const op = await s.engine.create('onboard', { candidateId: TG }, 'ops@example.com');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'failed' });
    expect(checks).toBe(1);
  });

  it('a Kubernetes candidate whose cluster the router may not use is not onboarded, with what the router lacks', async () => {
    const s = setup({ candidates: [k8sCandidate()], eks: fakeEks([eksCluster('eks-demo')]) });
    s.router.clusterChecks['eks-demo'] = { cluster: 'eks-demo', reachable: true, allowed: false, missing: ['get nodes', 'get, patch deployments/scale (apps)'] };
    const op = await s.engine.create('onboard', { candidateId: TG }, 'ops@example.com');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'failed' });
    const stored = (await s.records.getOperation(op.id))!;
    expect(stored.error).toBe('check clusters: cluster eks-demo: the router may not get nodes; get, patch deployments/scale (apps): apply dormeto-kubernetes-<version>.yaml of the release (the ClusterRole and its binding to the group dormeto:router): https://dormeto.com/organization-access.html#kubernetes');
    expect(s.invocations.some(([, p]) => p.action === 'onboard')).toBe(false);
  });

  // An access module older than 0.10.0 has no EKS statement: the router still naps everything else, so its install or
  // upgrade goes on, saying why its clusters are left; only what needs a cluster fails.
  const listDenied = () => Object.assign(new Error('User is not authorized to perform: eks:ListClusters'), { name: 'AccessDeniedException' });
  const createDenied = () => Object.assign(new Error('User is not authorized to perform: eks:CreateAccessEntry'), { name: 'AccessDeniedException' });

  it('a router installed or upgraded where the command role has no EKS statement: the access entries are skipped, saying to apply the access module again', async () => {
    for (const eks of [fakeEks([eksCluster('eks-demo')], { denyList: listDenied(), deny: createDenied() }), fakeEks([eksCluster('eks-demo')], { deny: createDenied() })]) {
      const s = setup({ eks });
      const op = await s.engine.create('install-router', { account: ACCOUNT, region: 'eu-west-3' }, 'admin@example.com');
      expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
      const step = (await s.records.getOperation(op.id))!.steps.find((x) => x.name === 'access entries')!;
      expect(step.status).toBe('skipped');
      expect(step.detail).toMatch(/^the command role may not (list the EKS clusters|manage the access entries of cluster eks-demo): apply the access module \(or the AWS CLI script\) of the manager's release again \(statement Eks(Clusters|AccessEntries)\)/);
    }
  });

  it('onboarding a Kubernetes candidate where the command role has no EKS statement fails, naming the access module to apply again', async () => {
    const s = setup({ candidates: [k8sCandidate()], eks: fakeEks([eksCluster('eks-demo')], { denyList: listDenied(), deny: createDenied() }) });
    const op = await s.engine.create('onboard', { candidateId: TG }, 'ops@example.com');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'failed' });
    expect((await s.records.getOperation(op.id))!.error).toBe('access entries: the command role may not list the EKS clusters: apply the access module (or the AWS CLI script) of the manager\'s release again (statement EksClusters): User is not authorized to perform: eks:ListClusters');
    expect(s.invocations.some(([, p]) => p.action === 'onboard')).toBe(false);
  });

  it('uninstalling a router where the command role has no EKS statement goes on, saying which entries are left', async () => {
    const s = setup({ eks: fakeEks([eksCluster('eks-demo')], { denyList: listDenied() }) });
    await s.drive((await s.engine.create('install-router', { account: ACCOUNT, region: 'eu-west-3' }, 'admin')).id);
    const op = await s.engine.create('uninstall-router', { account: ACCOUNT, region: 'eu-west-3' }, 'admin');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    const step = (await s.records.getOperation(op.id))!.steps.find((x) => x.name === 'remove access entries')!;
    expect(step).toMatchObject({ status: 'skipped' });
    expect(step.detail).toMatch(/^the command role may not list the EKS clusters: .*; remove the access entries of the router's roles \(dmtr-dev-eu-west-3-controller, dmtr-dev-eu-west-3-waker, dmtr-dev-eu-west-3-onboarder\) from the region's clusters by hand$/);
  });

  it('uninstalling a router removes its roles\' access entries from the clusters before its roles', async () => {
    const s = setup({ eks: fakeEks([eksCluster('eks-demo')]) });
    expect(await s.drive((await s.engine.create('install-router', { account: ACCOUNT, region: 'eu-west-3' }, 'admin')).id)).toEqual({ done: true, status: 'succeeded' });
    s.eks.writes.length = 0;
    const op = await s.engine.create('uninstall-router', { account: ACCOUNT, region: 'eu-west-3' }, 'admin');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    const stored = (await s.records.getOperation(op.id))!;
    const names = stored.steps.map((x) => x.name);
    expect(names.indexOf('remove access entries')).toBe(names.indexOf('check empty') + 1);
    expect(stored.steps.find((x) => x.name === 'remove access entries')).toMatchObject({ status: 'done', detail: 'cluster eks-demo: access entries of 3 router roles removed' });
    expect(s.eks.writes.map(([w, i]) => [w, i.principalArn])).toEqual(['controller', 'waker', 'onboarder'].map((r) => ['deleteAccessEntry', ROLE(r)]));
    expect([...s.eks.entries.keys()]).toEqual([`eks-demo arn:aws:iam::${ACCOUNT}:role/DmtDiscoveryRole`]);
  });

  it('the cluster-access operation runs the access entries and the check again (after the customer applied the manifest)', async () => {
    const s = setup({ eks: fakeEks([eksCluster('eks-demo')]) });
    await s.records.putRouter({ name: 'dmtr-dev', account: ACCOUNT, region: 'eu-west-3', controller: `arn:aws:lambda:eu-west-3:${ACCOUNT}:function:dmtr-dev-controller`, onboarder: `arn:aws:lambda:eu-west-3:${ACCOUNT}:function:dmtr-dev-onboarder`, version: '0.29.0', build: 'b', installedBy: 'a', installedAt: 'x' });
    const op = await s.engine.create('cluster-access', { account: ACCOUNT, region: 'eu-west-3' }, 'admin@example.com');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    expect((await s.records.getOperation(op.id))!.steps.map((x) => [x.name, x.status])).toEqual([['find router', 'done'], ['access entries', 'done'], ['kubernetes proxies', 'skipped'], ['check clusters', 'done']]);
  });
});

// Private EKS endpoints (vision docs/specs/2026-10-24-private-eks-endpoints-design.md, section 6): the router's proxy in each
// cluster whose endpoint is private, made in its cluster steps and removed when it uninstalls.
describe('Kubernetes proxies', () => {
  const FN = 'dmtr-dev-kube-eks-demo';
  const proxyOf = (cluster: string, group: string, clusterGroup: string) => ({
    cluster, function: `dmtr-dev-kube-${cluster}`, role: `dmtr-dev-eu-west-3-kube-${cluster}`, logGroup: `/aws/lambda/dmtr-dev-kube-${cluster}`, securityGroupId: group, clusterSecurityGroupId: clusterGroup, vpcId: 'vpc-0a1b2c3d',
  });
  const PROXY = proxyOf('eks-demo', 'sg-0proxy000', 'sg-0cluster00');
  const privateCluster = (name = 'eks-demo') => eksCluster(name, { public: false, private: true });
  const withClusters = (clusters: ReturnType<typeof eksCluster>[], over: Parameters<typeof setup>[0] = {}) => setup({ eks: fakeEks(clusters), clusters, ...over });
  const k8sCandidate = (cluster = 'eks-demo') => candidate({
    backend: { kind: 'k8s', id: `${cluster}/demo/Deployment/web`, kubernetes: { cluster, namespace: 'demo', owner: { kind: 'Deployment', name: 'web' }, switch: 'ingress', ingress: { name: 'web', ruleIndex: 0, groupOrder: -1, service: { name: 'web', port: { number: 80 } } }, hpa: false, keda: false, capacity: 'nodes', autoscaler: 'karpenter' } } as Candidate['backend'],
  });
  const refusal = 'You are not authorized to perform this operation. User: arn:aws:sts::121014831971:assumed-role/DmtCommandRole/dmt-dev-operations is not authorized to perform: ec2:CreateSecurityGroup';
  const unauthorized = () => Object.assign(new Error(refusal), { name: 'UnauthorizedOperation' });
  const stepOf = async (s: ReturnType<typeof setup>, id: string, name: string) => (await s.records.getOperation(id))!.steps.find((x) => x.name === name)!;
  const checked = (s: ReturnType<typeof setup>) => s.invocations.filter(([, p]) => p.action === 'clusterCheck').map(([, p]) => p.cluster);

  it('runs between the access entries and the check in the cluster steps, and uninstalling removes the proxies after the access entries', async () => {
    const s = setup({ routers: [DEV_ROUTER] });
    const cluster = ['access entries', 'kubernetes proxies', 'check clusters'];
    const plan = async (type: Parameters<typeof s.engine.create>[0], input: Record<string, unknown>) => (await s.engine.create(type, input, 'admin')).steps.map((x) => x.name);
    const install = await plan('install-router', { account: ACCOUNT, region: 'eu-west-1' });
    expect(install.slice(install.indexOf('register router'))).toEqual(['register router', ...cluster, 'verify router']);
    const upgrade = await plan('upgrade-router', { account: ACCOUNT, region: 'eu-west-2' });
    expect(upgrade.slice(upgrade.indexOf('register router'))).toEqual(['register router', ...cluster, 'verify router']);
    const onboard = await plan('onboard', { candidateId: TG });
    expect(onboard.slice(onboard.indexOf('register router'), onboard.indexOf('slot'))).toEqual(['register router', ...cluster]);
    expect(await plan('cluster-access', { account: ACCOUNT, region: 'eu-west-3' })).toEqual(['find router', ...cluster]);
    const uninstall = await plan('uninstall-router', { account: ACCOUNT, region: 'us-east-1' });
    expect(uninstall.slice(uninstall.indexOf('check empty'), uninstall.indexOf('check empty') + 4)).toEqual(['check empty', 'remove access entries', 'remove kubernetes proxies', 'uninstall event rule']);
  });

  it('a router installed where a cluster is private gets its proxy, waiting until it is Active, recorded with the router; the check follows', async () => {
    const s = withClusters([privateCluster(), eksCluster('open')]);
    const op = await s.engine.create('install-router', { account: ACCOUNT, region: 'eu-west-3' }, 'admin@example.com');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    const step = await stepOf(s, op.id, 'kubernetes proxies');
    expect(step).toMatchObject({ status: 'done', detail: `cluster eks-demo: proxy ${FN} in place; cluster open: reached directly` });
    expect(step.attempts).toBeGreaterThan(2);
    expect(s.kube.state.functions.get(FN)!.config).toMatchObject({ State: 'Active', Handler: 'kube-proxy.handler', Role: `arn:aws:iam::${ACCOUNT}:role/dormeto/router/dmtr-dev-eu-west-3-kube-eks-demo` });
    expect((await s.records.getRouter(ACCOUNT, 'eu-west-3'))!.proxies).toEqual([PROXY]);
    // Both clusters have their access entries and are checked.
    expect(checked(s)).toEqual(['eks-demo', 'open']);
    // An upgrade keeps the record (register router writes the router again) and changes nothing in place.
    s.kube.state.ops.length = 0;
    const upgrade = await s.engine.create('upgrade-router', { account: ACCOUNT, region: 'eu-west-3' }, 'admin');
    expect(await s.drive(upgrade.id)).toEqual({ done: true, status: 'succeeded' });
    expect(await stepOf(s, upgrade.id, 'kubernetes proxies')).toMatchObject({ status: 'skipped' });
    expect(s.kube.writes()).toEqual([]);
    expect((await s.records.getRouter(ACCOUNT, 'eu-west-3'))!.proxies).toEqual([PROXY]);
  });

  it('the cluster-access operation removes the proxy of a cluster deleted since, from the router\'s record', async () => {
    const clusters = [privateCluster()];
    const s = withClusters(clusters);
    await s.drive((await s.engine.create('install-router', { account: ACCOUNT, region: 'eu-west-3' }, 'admin')).id);
    clusters.splice(0, 1);
    s.kube.state.groups.delete('sg-0cluster00');
    const op = await s.engine.create('cluster-access', { account: ACCOUNT, region: 'eu-west-3' }, 'admin');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    expect(await stepOf(s, op.id, 'kubernetes proxies')).toMatchObject({ status: 'done', detail: `cluster eks-demo no longer exists: its proxy ${FN} removed` });
    expect((await s.records.getRouter(ACCOUNT, 'eu-west-3'))!.proxies).toEqual([]);
    expect([s.kube.state.functions.size, s.kube.state.roles.size, s.kube.state.groups.size]).toEqual([0, 0, 0]);
  });

  it('a router written in Terraform skips the step: its proxies are the customer\'s', async () => {
    const s = withClusters([privateCluster()], { routers: [DEV_ROUTER], candidates: [k8sCandidate()] });
    const op = await s.engine.create('onboard', { candidateId: TG }, 'ops@example.com');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    expect(await stepOf(s, op.id, 'kubernetes proxies')).toMatchObject({ status: 'skipped', detail: 'router dmt-dev is written in Terraform: its proxies are the customer\'s (module kubernetes-proxy)' });
    expect(s.kube.state.ops).toEqual([]);
  });

  // Ruling 19: the message names the manager's running version (VERSION), never a release number written in the code.
  it('an install or upgrade where the command role predates this manager\'s release goes on without the proxies, naming the organization access of the manager running; the clusters reached directly are checked', async () => {
    const s = withClusters([privateCluster(), eksCluster('open')], { version: '0.20.0-dev.1' });
    s.kube.state.deny.createSecurityGroup = unauthorized();
    for (const type of ['install-router', 'upgrade-router'] as const) {
      s.invocations.length = 0;
      const op = await s.engine.create(type, { account: ACCOUNT, region: 'eu-west-3' }, 'admin');
      expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
      expect(await stepOf(s, op.id, 'kubernetes proxies'), type).toMatchObject({
        status: 'skipped', detail: `cluster eks-demo: the command role may not set up its Kubernetes proxy: apply the organization access of manager 0.20.0-dev.1 (${refusal})`,
      });
      expect(await stepOf(s, op.id, 'check clusters'), type).toMatchObject({ status: 'done', detail: 'cluster open: reachable, every right' });
      expect(checked(s), type).toEqual(['open']);
    }
    expect([s.kube.state.roles.size, s.kube.state.functions.size]).toEqual([0, 0]);
    expect((await s.records.getRouter(ACCOUNT, 'eu-west-3'))!.proxies ?? []).toEqual([]);
  });

  it('the cluster-access operation where the command role predates this manager\'s release goes on without the proxies, saying what to apply (the manager\'s version unknown); the clusters reached directly are checked', async () => {
    const s = withClusters([privateCluster(), eksCluster('open')]);
    await s.records.putRouter({ name: 'dmtr-dev', account: ACCOUNT, region: 'eu-west-3', controller: `arn:aws:lambda:eu-west-3:${ACCOUNT}:function:dmtr-dev-controller`, onboarder: `arn:aws:lambda:eu-west-3:${ACCOUNT}:function:dmtr-dev-onboarder`, version: '0.33.0', build: 'b', installedBy: 'a', installedAt: 'x' });
    s.kube.state.deny.createSecurityGroup = unauthorized();
    const op = await s.engine.create('cluster-access', { account: ACCOUNT, region: 'eu-west-3' }, 'admin');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    expect(await stepOf(s, op.id, 'kubernetes proxies')).toMatchObject({
      status: 'skipped', detail: `cluster eks-demo: the command role may not set up its Kubernetes proxy: apply the organization access of this manager's release (${refusal})`,
    });
    expect(await stepOf(s, op.id, 'check clusters')).toMatchObject({ status: 'done', detail: 'cluster open: reachable, every right' });
    expect(checked(s)).toEqual(['open']);
  });

  // Waits do not use the step's retry budget (ruling 16): a proxy moved to another VPC waits for its interfaces many times,
  // then its role, made again, is not assumable by Lambda yet (RetryLater).
  it('a step that waited 40 times and then asks to retry later is retried, not failed', async () => {
    const clusters = [privateCluster()];
    const s = withClusters(clusters);
    await s.drive((await s.engine.create('install-router', { account: ACCOUNT, region: 'eu-west-3' }, 'admin')).id);
    s.kube.state.groups.delete('sg-0cluster00');
    clusters[0] = eksCluster('eks-demo', { public: false, private: true, vpc: 'vpc-0e5f6a7b', group: 'sg-0cluster02' });
    s.kube.addClusterGroup(clusters[0]);
    s.kube.state.releaseReads = 40;
    const op = await s.engine.create('cluster-access', { account: ACCOUNT, region: 'eu-west-3' }, 'admin');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    const step = await stepOf(s, op.id, 'kubernetes proxies');
    expect(step.attempts).toBeGreaterThan(42);
    expect(step.retries).toBe(1);
    expect((await s.records.getRouter(ACCOUNT, 'eu-west-3'))!.proxies).toEqual([{ ...PROXY, securityGroupId: 'sg-0proxy001', clusterSecurityGroupId: 'sg-0cluster02', vpcId: 'vpc-0e5f6a7b' }]);
  });

  it('onboarding a candidate whose cluster needs a proxy fails where the command role predates this manager\'s release; one reached directly goes on', async () => {
    const s = withClusters([privateCluster()], { candidates: [k8sCandidate()], version: '0.20.0' });
    s.kube.state.deny.createSecurityGroup = unauthorized();
    const op = await s.engine.create('onboard', { candidateId: TG }, 'ops@example.com');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'failed' });
    expect((await s.records.getOperation(op.id))!.error).toBe(`kubernetes proxies: cluster eks-demo: the command role may not set up its Kubernetes proxy: apply the organization access of manager 0.20.0 (${refusal})`);
    expect(s.invocations.some(([, p]) => p.action === 'onboard')).toBe(false);

    const direct = withClusters([eksCluster('eks-demo'), privateCluster('private')], { candidates: [k8sCandidate()], version: '0.20.0' });
    direct.kube.state.deny.createSecurityGroup = unauthorized();
    const onboard = await direct.engine.create('onboard', { candidateId: TG }, 'ops@example.com');
    expect(await direct.drive(onboard.id)).toEqual({ done: true, status: 'succeeded' });
    expect(await stepOf(direct, onboard.id, 'kubernetes proxies')).toMatchObject({ status: 'skipped', detail: expect.stringMatching(/^cluster private: the command role may not set up its Kubernetes proxy: apply the organization access of manager 0\.20\.0/) });
    expect(checked(direct)).toEqual(['eks-demo']);
  });

  it('uninstalling a router removes every proxy recorded, after the access entries, waiting while Lambda holds their network interfaces', async () => {
    const s = withClusters([privateCluster(), privateCluster('eks-other')]);
    await s.drive((await s.engine.create('install-router', { account: ACCOUNT, region: 'eu-west-3' }, 'admin')).id);
    expect((await s.records.getRouter(ACCOUNT, 'eu-west-3'))!.proxies).toEqual([PROXY, proxyOf('eks-other', 'sg-0proxy001', 'sg-0cluster-eks-other')]);
    s.kube.state.releaseReads = 3;
    const op = await s.engine.create('uninstall-router', { account: ACCOUNT, region: 'eu-west-3' }, 'admin');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    const step = await stepOf(s, op.id, 'remove kubernetes proxies');
    expect(step).toMatchObject({ status: 'done', detail: `cluster eks-demo: proxy ${FN} removed; cluster eks-other: proxy dmtr-dev-kube-eks-other removed` });
    expect(step.attempts).toBeGreaterThan(2);
    const { state } = s.kube;
    expect([state.functions.size, state.roles.size, state.logGroups.size, state.interfaces.size, [...state.groups.keys()]]).toEqual([0, 0, 0, 0, ['sg-0cluster00', 'sg-0cluster-eks-other']]);
    expect(await s.records.getRouter(ACCOUNT, 'eu-west-3')).toBeNull();
  });

  // Review focus 4: a removal that failed (interfaces held for more than an hour) keeps the proxies left on the record, and
  // the next uninstall finishes with them.
  it('an uninstall that failed while Lambda held a proxy\'s network interfaces keeps what is left, and the next one finishes it', async () => {
    const s = withClusters([privateCluster(), privateCluster('eks-other')]);
    await s.drive((await s.engine.create('install-router', { account: ACCOUNT, region: 'eu-west-3' }, 'admin')).id);
    s.kube.state.held.add('dmtr-dev-kube-eks-other');
    const failed = await s.engine.create('uninstall-router', { account: ACCOUNT, region: 'eu-west-3' }, 'admin');
    expect(await s.drive(failed.id, { maxIterations: 400 })).toEqual({ done: true, status: 'failed' });
    expect((await s.records.getOperation(failed.id))!.error).toMatch(/^remove kubernetes proxies: cluster eks-other: Lambda still holds the network interfaces eni-0\w+, eni-0\w+ of the proxy dmtr-dev-kube-eks-other an hour after its function was deleted$/);
    // Kept with the time its function was deleted: the hour counts from it.
    expect((await s.records.getRouter(ACCOUNT, 'eu-west-3'))!.proxies).toEqual([{ ...proxyOf('eks-other', 'sg-0proxy001', 'sg-0cluster-eks-other'), deletedAt: expect.any(String) }]);
    // Released since.
    s.kube.state.held.clear();
    s.kube.state.interfaces.clear();
    const again = await s.engine.create('uninstall-router', { account: ACCOUNT, region: 'eu-west-3' }, 'admin');
    expect(await s.drive(again.id)).toEqual({ done: true, status: 'succeeded' });
    expect(await stepOf(s, again.id, 'remove kubernetes proxies')).toMatchObject({ status: 'done', detail: 'cluster eks-other: proxy dmtr-dev-kube-eks-other removed' });
    expect([...s.kube.state.groups.keys()]).toEqual(['sg-0cluster00', 'sg-0cluster-eks-other']);
  });
});
