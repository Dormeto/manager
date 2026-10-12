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

const T0 = Date.UTC(2026, 9, 5, 12, 0);
const ACCOUNT = '121014831971';
const TG = `arn:aws:elasticloadbalancing:eu-west-3:${ACCOUNT}:targetgroup/paris-app/73e2d6bc24d8a067`;
const LB = `arn:aws:elasticloadbalancing:eu-west-3:${ACCOUNT}:loadbalancer/app/paris/50dc6c495c0c9188`;
const RULE = `arn:aws:elasticloadbalancing:eu-west-3:${ACCOUNT}:listener-rule/app/paris/50dc6c495c0c9188/f2f7dc8efc522ab2/0000000000000001`;
const ZIP = new Uint8Array([1, 2, 3]);

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  id: TG, account: ACCOUNT, region: 'eu-west-3', loadBalancer: 'paris', loadBalancerArn: LB, listener: 'HTTPS:443', priority: '10', conditions: 'host paris.example.com',
  hosts: ['paris.example.com'], targetGroup: 'paris-app', targetGroupArn: TG, suggestedId: 'paris', backend: { kind: 'instance', id: 'i-1' }, tags: {}, rules: [],
  eligibility: 'eligible', idleHours7d: 150, requests7d: 3, accountName: 'dormeto', ouPath: [], scope: 'in', scopeReason: 'in scope: filter "a", include 1',
  status: 'pending-onboarding', statusReason: 'eligible: instance i-1', firstSeenAt: '2026-10-05T10:00:00.000Z', lastSeenAt: '2026-10-05T10:00:00.000Z', history: [], ...over,
});

function setup({ routers = [] as RouterRef[], candidates = [candidate()] } = {}) {
  let now = T0;
  let ids = 0;
  const dynamo = fakeDynamo();
  const records = createRecords({ dynamo, table: 't', now: () => now });
  const account = fakeInstallAccount();
  const items = new Map(candidates.map((c) => [c.id, c]));
  const discovery = { getCandidate: async (id: string) => items.get(id) ?? null, putCandidates: async (list: Candidate[]) => { for (const c of list) items.set(c.id, c); } } as unknown as DiscoveryStore;
  // The router functions of the target account: onboarder and controller actions.
  const invocations: [string, Record<string, unknown>][] = [];
  const router = { state: 'AWAKE', previewOk: true, workloads: 0 };
  const answers: Record<string, (p: Record<string, unknown>) => unknown> = {
    preview: () => (router.previewOk ? { ok: true, problems: [] } : { ok: false, problems: ['no backend: no instance, Auto Scaling group or ECS service feeds the target group'] }),
    onboard: (p) => ({ steps: [{ name: 'tag backends', status: 'done' }], workload: { workloadId: p.workloadId, wakerTargetGroupArn: 'arn:waker' } }),
    offboard: () => ({ steps: [{ name: 'restore rules', status: 'done' }] }),
    status: () => ({ state: router.state, route: 'app', issues: [], targetGroupArn: TG, rules: [{ arn: RULE }], settings: { wakeTimeoutSeconds: 600 } }),
    'force-wake': () => { router.state = 'WAKING'; return { state: 'WAKING' }; },
    list: () => ({ workloads: Array.from({ length: router.workloads }, (_, i) => ({ workloadId: `w${i}` })) }),
    router: () => ({ router: { name: 'dmt-dev', version: '0.17.0', build: '1d50494cac65' } }),
  };
  const started: string[] = [];
  const engine = createEngine({
    records, discovery,
    routers: async () => [...routers, ...(await records.listRouters()).map((r) => ({ ...r, source: 'manager' as const }))],
    target: async () => ({
      installer: (options) => createInstaller(account.ports, options),
      invoke: async (functionArn, payload) => {
        invocations.push([functionArn, payload]);
        return answers[payload.action as string]!(payload);
      },
    }),
    bundle: async () => ({ blueprint: published as unknown as Blueprint, zip: ZIP, codeSha256: createHash('sha256').update(ZIP).digest('base64') }),
    settings: { env: 'dev', principals: [`arn:aws:iam::${ACCOUNT}:role/dmt-dev-manager-api`], routerSettings: { checkSchedule: 'rate(5 minutes)', ipLists: '[]', noWakeRules: '[]', metrics: 'false' } },
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
  return { engine, records, account, invocations, router, items, started, drive, advance: (ms: number) => { now += ms; }, now: () => now };
}

const DEV_ROUTER: RouterRef = {
  name: 'dmt-dev', account: ACCOUNT, region: 'eu-west-3', controller: `arn:aws:lambda:eu-west-3:${ACCOUNT}:function:dmt-dev-controller`,
  onboarder: `arn:aws:lambda:eu-west-3:${ACCOUNT}:function:dmt-dev-onboarder`, source: 'terraform',
};

describe('operations engine', () => {
  it('onboards a candidate with an existing router: lock, slot, preview, onboard, verify, candidate managed, everything released', async () => {
    const s = setup({ routers: [DEV_ROUTER] });
    const op = await s.engine.create('onboard', { candidateId: TG, workloadId: 'paris', settings: { idleMinutes: 30 } }, 'ops@example.com');
    expect(s.started).toEqual([op.id]);
    const result = await s.drive(op.id);
    expect(result).toEqual({ done: true, status: 'succeeded' });
    const stored = (await s.records.getOperation(op.id))!;
    expect(stored.steps.map((x) => [x.name, x.status])).toEqual([
      ['find router', 'done'], ['lock router', 'skipped'], ...['roles', 'table', 'queues', 'log groups', 'functions', 'async invoke', 'permissions', 'schedule'].map((n) => [`install ${n}`, 'skipped']),
      ['register router', 'skipped'], ['lock load balancer', 'done'], ['slot', 'done'], ['preview', 'done'], ['onboard', 'done'], ['verify', 'done'], ['candidate', 'done'],
    ]);
    expect(s.invocations.map(([fn, p]) => [fn.split(':').at(-1), p.action])).toEqual([['dmt-dev-onboarder', 'preview'], ['dmt-dev-onboarder', 'onboard'], ['dmt-dev-controller', 'status']]);
    expect(s.invocations[1]![1]).toEqual({ action: 'onboard', workloadId: 'paris', targetGroupArn: TG, settings: { idleMinutes: 30 }, databases: [], by: 'ops@example.com' });
    expect(s.account.state.roles.size, 'a Terraform router is never touched').toBe(0);
    expect(s.items.get(TG)).toMatchObject({ eligibility: 'managed', workloadId: 'paris', status: 'managed' });
    expect(await s.records.acquireLock(`LB#${LB}`, 'other', 60_000)).toBe(true);
    expect(await s.records.claimActive(`TG#${TG}`, 'other', 60_000)).toEqual({ ok: true });
  });

  it('installs the router of a new account and region first, waiting for the table and the IAM propagation, and registers it', async () => {
    const s = setup();
    const op = await s.engine.create('onboard', { candidateId: TG, workloadId: 'paris' }, 'ops@example.com');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    const stored = (await s.records.getOperation(op.id))!;
    expect(stored.steps.filter((x) => x.name.startsWith('install ')).map((x) => x.status)).toEqual(['done', 'done', 'done', 'done', 'done', 'done', 'done', 'done']);
    expect(stored.steps.find((x) => x.name === 'install functions')!.attempts).toBeGreaterThan(1);
    expect(await s.records.getRouter(ACCOUNT, 'eu-west-3')).toMatchObject({
      name: 'dmt-dev', controller: `arn:aws:lambda:eu-west-3:${ACCOUNT}:function:dmt-dev-controller`, onboarder: `arn:aws:lambda:eu-west-3:${ACCOUNT}:function:dmt-dev-onboarder`,
      version: '0.17.0', build: '1d50494cac65', installedBy: 'ops@example.com',
    });
    expect([...s.account.state.functions.keys()]).toEqual(['dmt-dev-controller', 'dmt-dev-waker', 'dmt-dev-onboarder']);
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

  it('offboards: wakes the workload, waits until awake, offboards, and the candidate is onboardable again', async () => {
    const s = setup({ routers: [DEV_ROUTER], candidates: [candidate({ eligibility: 'managed', workloadId: 'paris', status: 'managed', statusReason: 'managed as workload paris' })] });
    s.router.state = 'ASLEEP';
    const op = await s.engine.create('offboard', { router: 'dmt-dev', account: ACCOUNT, region: 'eu-west-3', workloadId: 'paris' }, 'ops');
    let polls = 0;
    const result = await s.drive(op.id, { between: () => { if (s.router.state === 'WAKING' && (polls += 1) > 3) s.router.state = 'AWAKE'; } });
    expect(result).toEqual({ done: true, status: 'succeeded' });
    expect((await s.records.getOperation(op.id))!.steps.map((x) => [x.name, x.status])).toEqual([
      ['locate', 'done'], ['lock load balancer', 'done'], ['slot', 'done'], ['wake', 'done'], ['wait awake', 'done'], ['offboard', 'done'], ['candidate', 'done'],
    ]);
    const actions = s.invocations.map(([, p]) => p.action);
    expect(actions.slice(0, 2)).toEqual(['status', 'force-wake']);
    expect(actions.at(-1)).toBe('offboard');
    expect(new Set(actions.slice(2, -1))).toEqual(new Set(['status']));
    expect(actions.length).toBeGreaterThan(4);
    expect(s.items.get(TG)).toMatchObject({ eligibility: 'eligible', status: 'pending-onboarding' });
    expect(s.items.get(TG)!.workloadId).toBeUndefined();
  });

  it('uninstalling a router with workloads is refused; without, every resource is deleted and the router unregistered', async () => {
    const s = setup();
    const install = await s.engine.create('install-router', { account: ACCOUNT, region: 'eu-west-3' }, 'admin');
    expect(await s.drive(install.id)).toEqual({ done: true, status: 'succeeded' });
    s.router.workloads = 1;
    const refused = await s.engine.create('uninstall-router', { account: ACCOUNT, region: 'eu-west-3' }, 'admin');
    expect(await s.drive(refused.id)).toEqual({ done: true, status: 'failed' });
    expect((await s.records.getOperation(refused.id))!.error).toBe('check empty: router dmt-dev still has 1 workload: offboard it first');
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

  it('a workflow failure releases what the operation holds and records the error', async () => {
    const s = setup({ routers: [DEV_ROUTER] });
    const op = await s.engine.create('onboard', { candidateId: TG, workloadId: 'paris' }, 'ops');
    for (let i = 0; i < 14; i += 1) await s.engine.next(op.id);
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
    expect((await s.records.getOperation(op.id))!.error).toBe('install table: still pending after 30 minutes (table dmt-dev-router CREATING)');
  });
});
