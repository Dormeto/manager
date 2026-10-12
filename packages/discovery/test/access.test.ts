// Organization access (packaging design §3): each account step checks both organization roles, each run the delegation
// policy of the management account; the access report counts the accounts and lists those not ready.
import { describe, expect, it } from 'vitest';
import { commandCheck } from '../src/aws.js';
import { runDiscovery } from '../src/run.js';
import { A, B, C, config, filter } from './fixtures.js';
import { T0, setup } from './run-fakes.js';

const ALL = config({ regions: ['eu-west-1'], filters: [filter('all', [{}])] });
const DENIED = 'access denied: the role is missing or does not trust the manager';

describe('organization access', () => {
  it('the account step records both roles, each on its own: the discovery role refused, the command role refused, both ready', async () => {
    const s = setup({ cfg: ALL, deny: [B.id], denyCommand: [C.id] });
    await s.ready;
    await runDiscovery(s.deps, { source: 'manual' });
    const access = async (id: string) => (await s.store.getAccountScan(id))!.access;
    const at = new Date(T0).toISOString();
    expect(await access(A.id)).toEqual({ discovery: { ok: true }, command: { ok: true }, checkedAt: at });
    expect(await access(B.id)).toEqual({ discovery: { ok: false, reason: DENIED }, command: { ok: true }, checkedAt: at });
    expect(await access(C.id)).toEqual({ discovery: { ok: true }, command: { ok: false, reason: DENIED }, checkedAt: at });
  });

  it('organization mode without the delegation policy fails the run with the reason; with it, the run records it', async () => {
    const s = setup({ cfg: ALL });
    await s.ready;
    const ok = await runDiscovery(s.deps, { source: 'manual' });
    expect(ok.delegation).toBe('ok');
    s.deps.organizations!.listRoots = async () => { throw Object.assign(new Error('You don\'t have permissions to access this resource.'), { name: 'AccessDeniedException' }); };
    s.advance(60_000);
    const failed = await runDiscovery(s.deps, { source: 'manual' });
    expect([failed.status, failed.delegation, failed.error]).toEqual(['failed', 'missing', 'organization access missing: the delegation policy of the management account (see the Organization access page)']);
    // The panel says so, the accounts of the last complete run kept.
    const report = await s.store.accessReport({ limit: 10 });
    expect([report.delegation, report.counts.ready]).toEqual(['missing', 3]);
    // A single account needs none.
    const single = setup({ cfg: config({ mode: 'account', regions: ['eu-west-1'] }) });
    await single.ready;
    expect((await runDiscovery(single.deps, { source: 'manual' })).delegation).toBeUndefined();
  });

  it('the access report counts the accounts ready, missing a role or never checked, and pages those not ready', async () => {
    const s = setup({ cfg: ALL, deny: [B.id], denyCommand: [C.id] });
    await s.ready;
    await runDiscovery(s.deps, { source: 'manual' });
    const first = await s.store.accessReport({ limit: 1 });
    expect(first.counts).toEqual({ ready: 1, discoveryMissing: 1, commandMissing: 1, unchecked: 0 });
    expect(first.accounts.map((a) => [a.account, a.name, a.discovery.ok, a.command.ok])).toEqual([[B.id, B.name, false, true]]);
    const second = await s.store.accessReport({ limit: 1, cursor: first.cursor! });
    expect(second.accounts.map((a) => a.account)).toEqual([C.id]);
    expect(second.cursor).toBeNull();
    // Before any run: nothing known.
    const fresh = setup({ cfg: ALL });
    expect(await fresh.store.accessReport({ limit: 10 })).toEqual({ counts: { ready: 0, discoveryMissing: 0, commandMissing: 0, unchecked: 0 }, accounts: [], cursor: null, delegation: null, checkedAt: null });
  });

  it('checks the command role through the access check function (the role trusts the operations role, not discovery): its refusal is an access denied', async () => {
    const asked: unknown[] = [];
    let answer: unknown = { ok: true };
    const check = commandCheck(async (payload) => { asked.push(payload); return answer; });
    await expect(check(B.id)).resolves.toBeUndefined();
    answer = { ok: false, name: 'AccessDenied', message: 'not authorized to perform: sts:AssumeRole' };
    await expect(check(C.id)).rejects.toMatchObject({ name: 'AccessDenied', message: 'not authorized to perform: sts:AssumeRole' });
    expect(asked).toEqual([{ account: B.id }, { account: C.id }]);
  });

  it('a check that does not answer (its function throttled, missing or failing) is no verdict: the account keeps what the last check found', async () => {
    const down = commandCheck(async () => { throw Object.assign(new Error('Rate exceeded'), { name: 'TooManyRequestsException' }); });
    await expect(down(A.id)).rejects.toMatchObject({ unavailable: true });
    const failing = commandCheck(async () => { throw Object.assign(new Error('Unhandled: unknown task'), { name: 'FunctionError' }); });
    await expect(failing(A.id)).rejects.toMatchObject({ unavailable: true });
    // In a run: denied first, then the check down: still denied (never turned "missing" by a manager-side failure, nor ok).
    const s = setup({ cfg: ALL, denyCommand: [C.id] });
    await s.ready;
    await runDiscovery(s.deps, { source: 'manual' });
    s.deps.assumeCommand = async () => { throw Object.assign(new Error('Rate exceeded'), { name: 'TooManyRequestsException', unavailable: true }); };
    s.advance(60_000);
    await runDiscovery(s.deps, { source: 'manual' });
    expect((await s.store.getAccountScan(C.id))!.access!.command).toEqual({ ok: false, reason: DENIED });
    expect((await s.store.getAccountScan(A.id))!.access!.command).toEqual({ ok: true });
    // Never checked before: unchecked, not refused.
    const fresh = setup({ cfg: ALL });
    await fresh.ready;
    fresh.deps.assumeCommand = s.deps.assumeCommand;
    await runDiscovery(fresh.deps, { source: 'manual' });
    expect((await fresh.store.getAccountScan(A.id))!.access).toBeUndefined();
    expect((await fresh.store.accessReport({ limit: 10 })).counts).toEqual({ ready: 0, discoveryMissing: 0, commandMissing: 0, unchecked: 3 });
  });

  it('an account set up for discovery only (its discovery role tagged dormeto:command-role = none) is counted apart: never listed as missing a role, never connected', async () => {
    const s = setup({ cfg: { ...ALL, eventRefresh: { enabled: true } }, regions: ['eu-west-1'], denyCommand: [B.id, C.id], discoveryOnly: [B.id], trails: { [A.id]: ['eu-west-1'], [B.id]: ['eu-west-1'], [C.id]: ['eu-west-1'] } });
    await s.ready;
    const run = await runDiscovery(s.deps, { source: 'manual' });
    expect((await s.store.getAccountScan(B.id))!.access!.command).toEqual({ ok: false, reason: 'discovery only: set up without the command role', discoveryOnly: true });
    expect((await s.store.getAccountScan(C.id))!.access!.command).toEqual({ ok: false, reason: DENIED });
    // Read only where the command role was refused.
    expect(s.roleReads.sort()).toEqual([B.id, C.id]);
    const summary = (await s.store.getAccess())!;
    expect(summary.counts).toEqual({ ready: 1, discoveryMissing: 0, commandMissing: 1, discoveryOnly: 1, unchecked: 0 });
    expect(summary.accounts.map((a) => a.account)).toEqual([C.id]);
    // By id, so that the Discovery view says why Onboard is not possible (review of 4e1ee10, item 1).
    expect(summary.discoveryOnly).toEqual([B.id]);
    expect(summary.forwarders!.impossible.map((f) => f.account)).toEqual([C.id]);
    expect(run.connections!.connect.map((c) => c.account)).toEqual([A.id]);
  });

  it('a tag read that does not answer is no verdict: a discovery-only account stays so; refused, the account is not tagged', async () => {
    const s = setup({ cfg: ALL, regions: ['eu-west-1'], denyCommand: [B.id, C.id], discoveryOnly: [B.id, C.id] });
    await s.ready;
    await runDiscovery(s.deps, { source: 'manual' });
    expect((await s.store.getAccess())!.discoveryOnly).toEqual([B.id, C.id]);
    const again = setup({ cfg: ALL, regions: ['eu-west-1'], denyCommand: [B.id, C.id], discoveryOnlyErrors: { [B.id]: 'Throttling', [C.id]: 'AccessDenied' } });
    // The same store: the previous run's verdicts.
    again.deps.store = s.store;
    s.advance(60_000);
    again.deps.now = () => Date.parse('2026-10-04T13:00:00.000Z');
    await runDiscovery(again.deps, { source: 'manual' });
    expect((await s.store.getAccountScan(B.id))!.access!.command).toMatchObject({ discoveryOnly: true });
    expect((await s.store.getAccountScan(C.id))!.access!.command).toEqual({ ok: false, reason: DENIED });
  });
});
