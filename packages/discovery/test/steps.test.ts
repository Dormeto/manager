// A run in steps (scale design §5): plan, one step per account (the Distributed Map), finalize.
import { describe, expect, it } from 'vitest';
import { lint, lintCounters, sumCounters } from '../src/lint.js';
import { restatus } from '../src/lifecycle.js';
import { abandonRun, finalizeRun, planRun, runDiscovery, scanAccount } from '../src/run.js';
import { A, B, C, INVENTORY, config, filter, rule } from './fixtures.js';
import { HOUR, setup } from './run-fakes.js';

const AB = config({ filters: [filter('ab', [{ accountIds: [A.id, B.id] }])] });
const writes = (calls: string[]) => calls.filter((c) => c === 'BatchWriteItemCommand').length;

describe('a run in steps', () => {
  it('plans the accounts to scan without assuming any role, stores the inventory and records the run as running', async () => {
    const s = setup({ cfg: AB });
    await s.ready;
    const plan = await planRun(s.deps, { source: 'manual', by: 'ops@example.com' });
    expect([plan.status, plan.accounts, s.assumed]).toEqual(['planned', [A.id, B.id], []]);
    expect(await s.store.lastRun()).toMatchObject({ startedAt: plan.runId, status: 'running', by: 'ops@example.com', skipped: [{ reason: 'no filter includes this account', accounts: 1, pairs: 2 }] });
    expect((await s.store.getInventory())!.accounts).toHaveLength(3);
    // The lock is held until the run is finalized.
    expect(await s.store.acquireLock('other')).toBe(false);
  });

  it('an account step writes only the candidates that changed: the same scan again writes none', async () => {
    const s = setup({ cfg: AB });
    await s.ready;
    const first = await planRun(s.deps, { source: 'manual' });
    expect(await scanAccount(s.deps, { runId: first.runId, account: A.id })).toEqual({ account: A.id, ok: true, written: 2 });
    await finalizeRun(s.deps, first);
    s.advance(HOUR);
    const second = await planRun(s.deps, { source: 'manual' });
    const before = writes(s.dynamo.calls);
    expect(await scanAccount(s.deps, { runId: second.runId, account: A.id })).toEqual({ account: A.id, ok: true, written: 0 });
    expect(writes(s.dynamo.calls)).toBe(before);
    // Its scan state says when each region was last seen.
    expect((await s.store.getAccountScan(A.id))!.regions['eu-west-1']!.scannedAt).toBe(new Date(Date.parse(first.runId) + HOUR).toISOString());
  });

  it('an account step keeps dismissals, and marks gone only what a pair it scanned no longer has', async () => {
    const s = setup({ cfg: config({ filters: [filter('a', [{ accountIds: [A.id] }])] }) });
    await s.ready;
    const scanned = (over: Record<string, ReturnType<typeof rule>[]>) => { s.deps.scan = async (_c, where) => { if (!over[where.region]) throw new Error('Rate exceeded'); return over[where.region]!; }; };
    const keep = rule({ id: 'keep', region: 'eu-west-1' });
    const drop = rule({ id: 'drop', region: 'eu-west-1' });
    const paris = rule({ id: 'paris', region: 'eu-west-3' });
    scanned({ 'eu-west-1': [keep, drop], 'eu-west-3': [paris] });
    await runDiscovery(s.deps, { source: 'manual' });
    const stored = (await s.store.accountCandidates(A.id)).find((c) => c.id === 'keep')!;
    await s.store.putCandidates([restatus({ ...stored, dismissed: { by: 'ops@example.com', at: 'x' } }, 'x')]);
    // eu-west-1 scanned without "drop"; eu-west-3 fails.
    scanned({ 'eu-west-1': [keep] });
    s.advance(HOUR);
    await runDiscovery(s.deps, { source: 'manual' });
    const status = async (id: string) => (await s.store.accountCandidates(A.id)).find((c) => c.id === id)!.status;
    expect([await status('keep'), await status('drop'), await status('paris')]).toEqual(['dismissed', 'gone', 'pending-onboarding']);
  });

  it('a failed account changes none of its candidates and records why', async () => {
    const s = setup({ cfg: AB });
    await s.ready;
    await runDiscovery(s.deps, { source: 'manual' });
    const before = (await s.store.accountCandidates(B.id)).map((c) => JSON.stringify(c)).sort();
    s.deps.assumeRole = async () => { throw Object.assign(new Error('not authorized to perform: sts:AssumeRole'), { name: 'AccessDenied' }); };
    s.advance(HOUR);
    const plan = await planRun(s.deps, { source: 'manual' });
    expect(await scanAccount(s.deps, { runId: plan.runId, account: B.id })).toEqual({ account: B.id, ok: false, written: 0 });
    expect((await s.store.accountCandidates(B.id)).map((c) => JSON.stringify(c)).sort()).toEqual(before);
    expect((await s.store.getAccountScan(B.id))!.result!.error).toMatch(/^no access: deploy DmtDiscoveryRole/);
  });

  it('scans a region found empty in three successive runs every seventh run only', async () => {
    const s = setup({ cfg: config({ regions: ['eu-west-1'], filters: [filter('a', [{ accountIds: [A.id] }])] }) });
    await s.ready;
    s.deps.scan = async (_c, where) => { s.scanned.push(`${where.account}/${where.region}`); return []; };
    const perRun: number[] = [];
    const runs = [];
    for (let run = 0; run < 10; run += 1) {
      const before = s.scanned.length;
      runs.push(await runDiscovery(s.deps, { source: 'manual' }));
      perRun.push(s.scanned.length - before);
      s.advance(HOUR);
    }
    expect(perRun).toEqual([1, 1, 1, 0, 0, 0, 0, 0, 0, 1]);
    expect(runs[3]!.skipped).toContainEqual({ reason: 'no load balancer in 3 runs: scanned every 7th run', accounts: 1, pairs: 1 });
    expect([runs[3]!.status, runs[9]!.skipped!.some((x) => x.reason.startsWith('no load balancer'))]).toEqual(['ok', false]);
  });

  it('finalize builds the run record from the account results; an account whose step never finished is an error; the lock is released', async () => {
    const s = setup({ cfg: AB });
    await s.ready;
    const plan = await planRun(s.deps, { source: 'manual' });
    await scanAccount(s.deps, { runId: plan.runId, account: A.id });
    const run = await finalizeRun(s.deps, plan);
    expect([run.status, run.counts]).toEqual(['partial', { 'pending-onboarding': 2 }]);
    expect(run.targets.map((t) => `${t.account}/${t.region} ${t.status}${t.error ? `: ${t.error}` : ''}`)).toEqual([
      `${A.id}/eu-west-1 ok`, `${A.id}/eu-west-3 ok`, `${B.id}/* error: the account step did not finish (timed out or failed)`,
    ]);
    expect((await s.store.lastRun())).toMatchObject({ startedAt: plan.runId, status: 'partial' });
    // The counts the Discovery view starts from, moved by the changes until the next run.
    expect((await s.store.getCounts())!.counts).toEqual({ 'pending-onboarding': 2 });
    expect(await s.store.acquireLock('next')).toBe(true);
  });

  it('finalize finds the result of every account even when the index has not caught up with their last writes', async () => {
    const s = setup({ cfg: AB, laggingIndex: true });
    await s.ready;
    const plan = await planRun(s.deps, { source: 'manual' });
    for (const account of plan.accounts) await scanAccount(s.deps, { runId: plan.runId, account });
    const run = await finalizeRun(s.deps, plan);
    expect([run.status, run.targets.filter((t) => t.status === 'error')]).toEqual(['ok', []]);
  });

  it('a run that never finished is abandoned after 3 hours: recorded as failed, and the next scheduled run starts', async () => {
    const s = setup({ cfg: AB });
    await s.ready;
    // Planned, then nothing more (the state machine timed out or was stopped).
    const lost = await planRun(s.deps, { source: 'manual' });
    s.advance(2 * HOUR);
    expect((await planRun(s.deps, { source: 'schedule' })).status).toBe('skipped');
    s.advance(2 * HOUR);
    const next = await planRun(s.deps, { source: 'schedule' });
    expect(next.status).toBe('planned');
    await finalizeRun(s.deps, next);
    expect((await s.store.lastRun({ completed: true }))!.startedAt).toBe(next.runId);
    // The lost run is recorded as failed.
    expect(await s.store.getRun(lost.runId)).toMatchObject({ status: 'failed', error: 'the run did not finish within 3 hours' });
  });

  it('abandoning a run whose finalize failed records it as failed with the error and releases the lock', async () => {
    const s = setup({ cfg: AB });
    await s.ready;
    const plan = await planRun(s.deps, { source: 'manual' });
    const run = await abandonRun(s.deps, plan, 'States.Timeout: finalize timed out');
    expect([run.status, run.error]).toEqual(['failed', 'finalize failed: States.Timeout: finalize timed out']);
    expect(await s.store.getRun(plan.runId)).toMatchObject({ status: 'failed' });
    expect(await s.store.acquireLock('next')).toBe(true);
  });

  it('finalize decides again, once, the candidates of an account that left the perimeter', async () => {
    const s = setup({ cfg: AB });
    await s.ready;
    await runDiscovery(s.deps, { source: 'manual' });
    await s.store.putConfig(config({ filters: [filter('a', [{ accountIds: [A.id] }])] }), 'admin@example.com');
    s.advance(HOUR);
    await runDiscovery(s.deps, { source: 'manual' });
    expect((await s.store.accountCandidates(B.id)).map((c) => [c.status, c.statusReason])).toEqual([
      ['out-of-scope', 'out of scope: no filter includes it'], ['out-of-scope', 'out of scope: no filter includes it'],
    ]);
    expect((await s.store.getAccountScan(B.id))!.retiredAt).toBe(new Date(Date.parse((await s.store.lastRun())!.startedAt)).toISOString());
    s.advance(HOUR);
    const run = await runDiscovery(s.deps, { source: 'manual' });
    expect(run.counts).toEqual({ 'pending-onboarding': 2, 'out-of-scope': 2 });
  });
});

describe('lint from the accounts of a run', () => {
  it('summed counters of each account give the lint of every rule', () => {
    const cfg = config({
      globalExcludes: [{ hosts: ['*.internal'] }],
      filters: [filter('f', [{ accountIds: [A.id] }, { accountIds: [C.id] }, { hosts: ['nothing.example.com'] }])],
    });
    const rules = [rule({ account: A.id }), rule({ id: 'r2', account: C.id, hosts: ['api.internal'] })];
    const perAccount = [A.id, C.id].map((id) => lintCounters(cfg, INVENTORY, rules.filter((r) => r.account === id)));
    expect(lint(cfg, INVENTORY, { counters: sumCounters(perAccount) })).toEqual(lint(cfg, INVENTORY, { rules }));
    expect(lint(cfg, INVENTORY, { rules }).map((f) => [f.code, f.include])).toEqual([['include-only-globally-excluded', 2], ['include-matches-nothing', 3]]);
  });
});
