// Onboarding and offboarding a standalone candidate (vision standalone workloads design §5, §6): the target is its resource,
// the claim `RES#<arn>`, no load balancer to lock, the onboarder's payloads with `resourceArn` (the router's handover), the
// verification the workload's status AWAKE with its resource among its backends, the candidate managed.
import { describe, expect, it } from 'vitest';
import type { DiscoveryStore, StandaloneCandidate } from '@dormeto/discovery';
import { Conflict, createEngine, type RouterRef } from '../src/engine.js';
import { createRecords } from '../src/records.js';
import { fakeDynamo } from './dynamo-fake.js';

const T0 = Date.UTC(2026, 10, 21, 12, 0);
const ACCOUNT = '121014831971';
const ARN = `arn:aws:ec2:eu-west-3:${ACCOUNT}:instance/i-0abc`;
const WORKLOAD_ID = 'a1b2c3d4e5f60718';
const ROUTER: RouterRef = {
  name: 'dmt-dev', account: ACCOUNT, region: 'eu-west-3', controller: `arn:aws:lambda:eu-west-3:${ACCOUNT}:function:dmt-dev-controller`,
  onboarder: `arn:aws:lambda:eu-west-3:${ACCOUNT}:function:dmt-dev-onboarder`, source: 'terraform', version: '0.42.0',
};
const candidate = (over: Partial<StandaloneCandidate> = {}): StandaloneCandidate => ({
  kind: 'standalone', id: ARN, account: ACCOUNT, region: 'eu-west-3', resourceArn: ARN, name: 'build-agent', backend: { kind: 'instance', id: 'i-0abc', arn: ARN },
  tags: {}, eligibility: 'eligible', idleHours7d: 150, accountName: 'dormeto', ouPath: [], scope: 'in', scopeReason: 'in scope: filter "a", include 1',
  status: 'pending-onboarding', statusReason: 'eligible', firstSeenAt: '2026-11-21T10:00:00.000Z', lastSeenAt: '2026-11-21T10:00:00.000Z', history: [], ...over,
});

function setup({ candidates = [candidate()] }: { candidates?: StandaloneCandidate[] } = {}) {
  let now = T0;
  let ids = 0;
  const records = createRecords({ dynamo: fakeDynamo(), table: 't', now: () => now });
  const items = new Map(candidates.map((c) => [c.id, c]));
  const discovery = {
    getCandidate: async (id: string) => items.get(id) ?? null,
    replaceCandidates: async (after: StandaloneCandidate[]) => { for (const c of after) items.set(c.id, c); },
  } as unknown as DiscoveryStore;
  const invocations: [string, Record<string, unknown>][] = [];
  // The router's onboarder and controller of plan 1 (task-R27-report.md, "The onboarder", "The status").
  const router = {
    state: 'AWAKE', source: 'manager', kind: 'standalone' as string | undefined, problems: [] as string[], onboardError: null as string | null, offboardError: null as string | null,
    backends: [{ kind: 'instance', id: 'i-0abc', status: 'running' }] as Record<string, unknown>[], resourceMissing: false,
  };
  const answers: Record<string, (p: Record<string, unknown>) => unknown> = {
    preview: (p) => ({
      ok: router.problems.length === 0, problems: router.problems, workloadId: WORKLOAD_ID, ...(router.kind ? { kind: router.kind } : {}), name: p.name ?? 'build-agent', tags: p.tags ?? {},
      resourceArn: p.resourceArn, resource: { kind: 'instance', id: 'i-0abc', tagged: null }, databases: [],
    }),
    onboard: () => {
      if (router.onboardError) throw new Error(router.onboardError);
      return { steps: [{ name: 'tag resource and databases', status: 'done', detail: 'instance i-0abc' }, { name: 'workload configuration', status: 'done' }], workload: { workloadId: WORKLOAD_ID, name: 'build-agent' } };
    },
    offboard: () => {
      if (router.offboardError) throw new Error(router.offboardError);
      return { steps: [{ name: 'untag resource and databases', status: 'done' }, { name: 'workload configuration', status: 'done' }] };
    },
    status: () => ({
      workloadId: WORKLOAD_ID, name: 'build-agent', kind: 'standalone', resourceArn: ARN, source: router.source, state: router.state,
      backends: router.backends, ...(router.resourceMissing ? { resourceMissing: true } : {}), settings: { idleMinutes: 120, wakeTimeoutSeconds: 600 },
    }),
    pause: () => { if (router.state === 'ASLEEP') router.state = 'WAKING'; return { pause: {}, woken: [] }; },
    report: () => ({}),
  };
  const engine = createEngine({
    records, discovery,
    routers: async () => [ROUTER],
    target: async () => ({
      invoke: async (functionArn: string, payload: Record<string, unknown>) => {
        invocations.push([functionArn.split(':').at(-1)!, payload]);
        return answers[payload.action as string]!(payload);
      },
    }) as never,
    bundle: async () => { throw new Error('no bundle: the router exists'); },
    settings: { env: 'dev', principals: [], routerSettings: {} as never },
    start: async (op) => `arn:execution:${op.id}`,
    now: () => now, newId: () => `op${++ids}`, log: { info() {}, warn() {}, error() {} },
  });
  async function drive(id: string, between = () => {}) {
    for (let i = 0; i < 200; i += 1) {
      const r = await engine.next(id);
      if (r.done) return r;
      now += (r.waitSeconds ?? 0) * 1000;
      between();
    }
    throw new Error('the operation never finished');
  }
  return { engine, records, router, invocations, items, drive };
}

describe('onboarding a standalone candidate', () => {
  it('targets the resource, locks no load balancer, sends the onboarder its resource, verifies it AWAKE with its backends, and marks the candidate managed', async () => {
    const s = setup();
    const op = await s.engine.create('onboard', { candidateId: ARN, name: 'Build agent', settings: { idleCpuPercent: 3 }, databases: [{ kind: 'rds-instance', id: 'ci-db' }], tags: { team: 'ci' } }, 'ops@example.com');
    expect([op.target, op.activeKey]).toEqual([{ account: ACCOUNT, region: 'eu-west-3', resourceArn: ARN }, `RES#${ARN}`]);
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    const stored = (await s.records.getOperation(op.id))!;
    expect(stored.steps.filter((x) => x.status !== 'skipped' || x.name === 'lock load balancer').map((x) => [x.name, x.status, x.detail])).toEqual([
      ['find router', 'done', 'router dmt-dev'], ['slot', 'done', undefined], ['lock load balancer', 'skipped', 'a standalone workload: no load balancer to lock'],
      ['preview', 'done', `Build agent (${WORKLOAD_ID})`], ['onboard', 'done', 'tag resource and databases, workload configuration'],
      ['verify', 'done', 'Build agent AWAKE, instance i-0abc running; in the manager now'], ['candidate', 'done', undefined],
    ]);
    // The handover's payloads: resourceArn in place of targetGroupArn; the router derives the id.
    expect(s.invocations.map(([fn, p]) => [fn, p])).toEqual([
      ['dmt-dev-onboarder', { action: 'preview', resourceArn: ARN, name: 'Build agent', settings: { idleCpuPercent: 3 }, databases: [{ kind: 'rds-instance', id: 'ci-db' }], tags: { team: 'ci' } }],
      ['dmt-dev-onboarder', { action: 'onboard', resourceArn: ARN, name: 'Build agent', settings: { idleCpuPercent: 3 }, databases: [{ kind: 'rds-instance', id: 'ci-db' }], tags: { team: 'ci' }, by: 'ops@example.com' }],
      ['dmt-dev-controller', { action: 'status', workloadId: WORKLOAD_ID }],
      ['dmt-dev-controller', { action: 'report', workloadId: WORKLOAD_ID }],
    ]);
    expect(s.items.get(ARN)).toMatchObject({ eligibility: 'managed', workloadId: WORKLOAD_ID, status: 'managed' });
    expect(await s.records.claimActive(`RES#${ARN}`, 'other', 60_000)).toEqual({ ok: true });
  });

  it('refuses a second onboarding of the same resource while one runs, naming it', async () => {
    const s = setup();
    const first = await s.engine.create('onboard', { candidateId: ARN }, 'ops');
    await expect(s.engine.create('onboard', { candidateId: ARN }, 'ops')).rejects.toEqual(new Conflict(first.id));
  });

  it('relays the router\'s refusals as it says them: its preview\'s problems, its onboarding\'s error', async () => {
    const s = setup();
    s.router.problems = ['instance i-0abc is a Spot instance: Dormeto stops On-Demand instances only', 'settings: waitSeconds: a standalone workload has no waker: waitSeconds is for an HTTP workload'];
    const op = await s.engine.create('onboard', { candidateId: ARN }, 'ops');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'failed' });
    expect((await s.records.getOperation(op.id))!.error).toBe(`preview: ${s.router.problems.join('; ')}`);
    expect(s.items.get(ARN)!.status).toBe('pending-onboarding');

    const t = setup();
    t.router.onboardError = `cannot onboard ${WORKLOAD_ID}: instance i-0abc belongs to workload other (0123456789abcdef) (undone)`;
    const again = await t.engine.create('onboard', { candidateId: ARN }, 'ops');
    expect(await t.drive(again.id)).toEqual({ done: true, status: 'failed' });
    expect((await t.records.getOperation(again.id))!.error).toBe(`onboard: ${t.router.onboardError}`);
    expect(await t.records.claimActive(`RES#${ARN}`, 'other', 60_000)).toEqual({ ok: true });
  });

  it('fails at the preview on a router that does not know standalone workloads, asking for its upgrade', async () => {
    const s = setup();
    s.router.kind = undefined;
    const op = await s.engine.create('onboard', { candidateId: ARN }, 'ops');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'failed' });
    expect((await s.records.getOperation(op.id))!.error).toBe('preview: router dmt-dev is older than 0.42.0: upgrade it to onboard a standalone resource');
    expect(s.invocations.some(([, p]) => p.action === 'onboard')).toBe(false);
  });

  it('fails the verification when the workload is not AWAKE, is FAILED, or its resource stays missing from its backends for 3 minutes', async () => {
    const late = `verify: Build agent is onboarded, but its status has no backend for ${ARN} after 3 minutes: see it in Workloads, and offboard it there if it should not stay`;
    for (const [change, error] of [
      [(r: ReturnType<typeof setup>['router']) => { r.state = 'FAILED'; }, 'verify: Build agent FAILED'],
      [(r: ReturnType<typeof setup>['router']) => { r.state = 'ASLEEP'; }, 'verify: Build agent ASLEEP, not AWAKE'],
      [(r: ReturnType<typeof setup>['router']) => { r.backends = []; }, late],
      [(r: ReturnType<typeof setup>['router']) => { r.resourceMissing = true; }, late],
    ] as const) {
      const s = setup();
      change(s.router);
      const op = await s.engine.create('onboard', { candidateId: ARN, name: 'Build agent' }, 'ops');
      expect(await s.drive(op.id)).toEqual({ done: true, status: 'failed' });
      expect((await s.records.getOperation(op.id))!.error).toBe(error);
      expect(s.items.get(ARN)!.status).toBe('pending-onboarding');
    }
  });
});

describe('the verification of a standalone onboarding', () => {
  it('waits for the resource among the backends, 15 s a poll: an ECS service\'s tag listed late by the tagging API', async () => {
    const s = setup();
    s.router.backends = [];
    let polls = 0;
    const op = await s.engine.create('onboard', { candidateId: ARN, name: 'Build agent' }, 'ops');
    const result = await s.drive(op.id, () => {
      const statuses = s.invocations.filter(([, p]) => p.action === 'status').length;
      if (statuses > polls) polls = statuses;
      if (polls >= 2) s.router.backends = [{ kind: 'instance', id: 'i-0abc', status: 'running' }];
    });
    expect(result).toEqual({ done: true, status: 'succeeded' });
    expect(s.invocations.filter(([, p]) => p.action === 'status').length).toBe(3);
    expect(s.items.get(ARN)).toMatchObject({ status: 'managed' });
  });
});

describe('offboarding a standalone workload', () => {
  const managed = () => candidate({ eligibility: 'managed', workloadId: WORKLOAD_ID, status: 'managed', statusReason: 'managed' });

  it('wakes it as an HTTP workload\'s offboarding does, offboards it, and gives its candidate back by its resource', async () => {
    const s = setup({ candidates: [managed()] });
    s.router.state = 'ASLEEP';
    const op = await s.engine.create('offboard', { router: 'dmt-dev', account: ACCOUNT, region: 'eu-west-3', workloadId: WORKLOAD_ID }, 'ops');
    let polls = 0;
    expect(await s.drive(op.id, () => { if (s.router.state === 'WAKING' && (polls += 1) > 2) s.router.state = 'AWAKE'; })).toEqual({ done: true, status: 'succeeded' });
    expect((await s.records.getOperation(op.id))!.steps.map((x) => [x.name, x.status, x.detail])).toEqual([
      ['locate', 'done', 'build-agent ASLEEP'], ['slot', 'done', undefined], ['lock load balancer', 'skipped', 'a standalone workload: no load balancer to lock'],
      ['pause', 'done', undefined], ['wait awake', 'done', undefined], ['offboard', 'done', 'untag resource and databases, workload configuration'], ['candidate', 'done', undefined],
    ]);
    expect(s.invocations.find(([, p]) => p.action === 'offboard')![1]).toEqual({ action: 'offboard', workloadId: WORKLOAD_ID, by: 'ops' });
    expect(s.items.get(ARN)).toMatchObject({ eligibility: 'eligible', status: 'pending-onboarding' });
  });

  it('relays the router\'s refusal as it says it', async () => {
    const s = setup({ candidates: [managed()] });
    s.router.offboardError = `cannot offboard ${WORKLOAD_ID}: it is ASLEEP, wake it first`;
    const op = await s.engine.create('offboard', { router: 'dmt-dev', account: ACCOUNT, region: 'eu-west-3', workloadId: WORKLOAD_ID }, 'ops');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'failed' });
    expect((await s.records.getOperation(op.id))!.error).toBe(`offboard: cannot offboard ${WORKLOAD_ID}: it is ASLEEP, wake it first`);
    expect(s.items.get(ARN)!.status).toBe('managed');
  });

  it('offboards one whose resource is missing without waking it, whatever its state (the router offboards it)', async () => {
    for (const state of ['ASLEEP', 'FAILED', 'AWAKE']) {
      const s = setup({ candidates: [managed()] });
      Object.assign(s.router, { state, resourceMissing: true, backends: [] });
      const op = await s.engine.create('offboard', { router: 'dmt-dev', account: ACCOUNT, region: 'eu-west-3', workloadId: WORKLOAD_ID }, 'ops');
      expect(await s.drive(op.id), state).toEqual({ done: true, status: 'succeeded' });
      expect((await s.records.getOperation(op.id))!.steps.map((x) => [x.name, x.status, x.detail]), state).toEqual([
        ['locate', 'done', `build-agent ${state}, its resource missing`], ['slot', 'done', undefined], ['lock load balancer', 'skipped', 'a standalone workload: no load balancer to lock'],
        ['pause', 'skipped', 'its resource is missing: nothing to wake'], ['wait awake', 'skipped', 'its resource is missing: nothing to wake'],
        ['offboard', 'done', 'untag resource and databases, workload configuration'], ['candidate', 'done', undefined],
      ]);
      expect(s.invocations.map(([, p]) => p.action), state).toEqual(['status', 'offboard']);
    }
  });

  it('refuses a workload written by Terraform before waking it', async () => {
    const s = setup({ candidates: [managed()] });
    s.router.source = 'terraform';
    const op = await s.engine.create('offboard', { router: 'dmt-dev', account: ACCOUNT, region: 'eu-west-3', workloadId: WORKLOAD_ID }, 'ops');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'failed' });
    expect(s.invocations.map(([, p]) => p.action)).toEqual(['status']);
  });
});
