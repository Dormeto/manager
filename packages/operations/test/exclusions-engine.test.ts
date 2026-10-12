// Exclusions applied and lifted by the workflow (scale design §6): the API answers at once, the operation pauses or
// resumes the matched workloads in their routers, in batches, each pause recorded with the exclusion.
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

// Workloads each router knows; a pause or resume elsewhere answers "workload not configured".
function setup({ candidates, known, fail = new Set<string>() }: { candidates: Candidate[]; known: Record<string, string[]>; fail?: Set<string> }) {
  const dynamo = fakeDynamo();
  const records = createRecords({ dynamo, table: 't', now: () => Date.parse('2026-10-05T12:00:00.000Z') });
  const exclusions = new Map<string, Exclusion>();
  const calls: [string, Record<string, unknown>][] = [];
  const discovery = {
    getCandidate: async (id: string) => candidates.find((c) => c.id === id) ?? null,
    putCandidates: async () => {},
    accountCandidates: async (account: string) => candidates.filter((c) => c.account === account),
    getInventory: async () => ({ accounts: [{ id: ACCOUNT, name: 'dormeto', ouPath: [], tags: {} }], ous: {} }),
    getExclusion: async (id: string) => structuredClone(exclusions.get(id) ?? null),
    putExclusion: async (e: Exclusion) => { exclusions.set(e.id, structuredClone(e)); },
    deleteExclusion: async (id: string) => { exclusions.delete(id); },
  };
  let ids = 0;
  const engine = createEngine({
    records, discovery: discovery as never, routers: async () => ROUTERS,
    target: async () => ({
      installer: () => { throw new Error('no installer'); },
      invoke: async (arn: string, payload: Record<string, unknown>) => {
        const router = ROUTERS.find((r) => r.controller === arn)!.name;
        calls.push([router, payload]);
        const id = String(payload.workloadId);
        if (fail.has(`${router}/${id}`)) throw new Error('Throttling');
        if (!known[router]?.includes(id)) throw Object.assign(new Error(`workload not configured: ${id}`), { name: 'RouterError' });
        return payload.action === 'pause' ? { pause: {}, woken: [] } : { resumed: true };
      },
    }) as never,
    bundle: async () => { throw new Error('no bundle'); },
    settings: { env: 'dev', principals: [], routerSettings: { checkSchedule: '', ipLists: '', noWakeRules: '', metrics: '', managerBus: '' } },
    start: async () => 'arn:execution', now: () => Date.parse('2026-10-05T12:00:00.000Z'), newId: () => `op${++ids}`, log: { info() {}, warn() {}, error() {} },
  });
  async function drive(id: string) {
    for (let i = 0; i < 100; i += 1) {
      const r = await engine.next(id);
      if (r.done) return r;
    }
    throw new Error('never finished');
  }
  return { engine, records, exclusions, calls, drive };
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
    const op = await s.engine.create('exclude', { exclusionId: 'x1', hint: { router: 'dmt-dev', workloadId: 'shop' } }, 'ops');
    await s.drive(op.id);
    expect(s.exclusions.get('x1')!.paused!.map((p) => p.workloadId)).toEqual(['shop']);
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

  it('runs one operation per exclusion at a time', async () => {
    const s = setup({ candidates: [], known: {} });
    s.exclusions.set('x1', exclusion());
    const op = await s.engine.create('exclude', { exclusionId: 'x1' }, 'ops');
    await expect(s.engine.create('lift-exclusion', { exclusionId: 'x1' }, 'ops')).rejects.toThrow(new Conflict(op.id));
  });
});
