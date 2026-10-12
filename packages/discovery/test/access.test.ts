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

  it('checks the command role through the operations Lambda (the role trusts it, not discovery): its refusal is an access denied', async () => {
    const asked: unknown[] = [];
    let answer: unknown = { ok: true };
    const check = commandCheck(async (payload) => { asked.push(payload); return answer; });
    await expect(check(B.id)).resolves.toBeUndefined();
    answer = { ok: false, name: 'AccessDenied', message: 'not authorized to perform: sts:AssumeRole' };
    await expect(check(C.id)).rejects.toMatchObject({ name: 'AccessDenied', message: 'not authorized to perform: sts:AssumeRole' });
    expect(asked).toEqual([{ task: 'check-command', account: B.id }, { task: 'check-command', account: C.id }]);
  });
});
