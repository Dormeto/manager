import { describe, expect, it } from 'vitest';
import { computeStatus, nextCandidates, restatus } from '../src/lifecycle.js';
import type { Candidate, PairResult, ScannedRule } from '../src/types.js';
import { A, C, INVENTORY, config, filter, rule } from './fixtures.js';

const T0 = Date.UTC(2026, 9, 4, 12, 0);
const T1 = T0 + 86_400_000;
const iso = (t: number) => new Date(t).toISOString();
const IN_A = config({ filters: [filter('a', [{ accountIds: [A.id, C.id] }])] });
const ok = (rules: ScannedRule[], account = A.id, region = 'eu-west-1'): PairResult => ({ account, region, ok: true, rules, ms: 10 });
const failed = (account = A.id, region = 'eu-west-1'): PairResult => ({ account, region, ok: false, error: 'throttled', rules: [], ms: 10 });
const run = (results: PairResult[], previous: Candidate[] = [], cfg = IN_A, now = T0) =>
  nextCandidates({ previous: new Map(previous.map((c) => [c.id, c])), results, inventory: INVENTORY, config: cfg, now });

describe('computeStatus', () => {
  const base = { scope: 'in' as const, scopeReason: 'in scope: filter "a", include 1', eligibility: 'eligible' as const };
  it.each([
    [{ ...base }, 'pending-onboarding'],
    [{ ...base, eligibility: 'ineligible' as const, reason: 'fixed response' }, 'ineligible'],
    [{ ...base, scope: 'out' as const, scopeReason: 'out of scope: no filter includes it' }, 'out-of-scope'],
    [{ ...base, scope: 'excluded' as const, scopeReason: 'excluded: global exclude 1 (account 1)' }, 'excluded'],
    [{ ...base, eligibility: 'managed' as const, workloadId: 'shop' }, 'managed'],
    [{ ...base, eligibility: 'managed' as const, scope: 'excluded' as const, scopeReason: 'excluded: filter "a", exclude 1' }, 'pending-offboarding'],
    [{ ...base, dismissed: { by: 'ops@example.com', at: iso(T0) } }, 'dismissed'],
    [{ ...base, scope: 'out' as const, scopeReason: 'x', dismissed: { by: 'ops@example.com', at: iso(T0) } }, 'dismissed'],
    [{ ...base, eligibility: 'managed' as const, dismissed: { by: 'ops@example.com', at: iso(T0) } }, 'managed'],
    [{ ...base, goneAt: iso(T0) }, 'gone'],
    [{ ...base, eligibility: 'managed' as const, workloadId: 'shop', reason: 'redirect action' }, 'pending-offboarding'],
  ])('%o → %s', (input, status) => {
    expect(computeStatus(input).status).toBe(status);
  });

  it('gives the decision reason to a pending offboarding, and a pending onboarding is just eligible', () => {
    expect(computeStatus({ ...base, eligibility: 'managed', reason: 'redirect action' }).statusReason).toBe('ineligible: redirect action');
    expect(computeStatus({ ...base, eligibility: 'managed', scope: 'excluded', scopeReason: 'excluded: filter "a", exclude 1' }).statusReason).toBe('excluded: filter "a", exclude 1');
    // The backend has its own column: the reason is just "eligible".
    expect(computeStatus({ ...base, backend: { kind: 'asg', id: 'web-asg' } }).statusReason).toBe('eligible');
  });
});

describe('nextCandidates', () => {
  it('creates candidates with the account name and OU path, first and last seen, and one history entry', () => {
    const [c] = run([ok([rule()])]);
    expect(c).toMatchObject({ accountName: 'tools', ouPath: A.ouPath, status: 'pending-onboarding', firstSeenAt: iso(T0), lastSeenAt: iso(T0) });
    expect(c!.history).toEqual([{ at: iso(T0), status: 'pending-onboarding', reason: 'eligible' }]);
  });

  it('keeps firstSeenAt, updates lastSeenAt, and appends history only on a change', () => {
    const [first] = run([ok([rule()])]);
    const [same] = run([ok([rule()])], [first!], IN_A, T1);
    expect([same!.firstSeenAt, same!.lastSeenAt, same!.history.length]).toEqual([iso(T0), iso(T1), 1]);
    const [changed] = run([ok([rule({ eligibility: 'ineligible', backend: null, reason: 'fixed response' })])], [same!], IN_A, T1);
    expect(changed!.history.map((h) => h.status)).toEqual(['pending-onboarding', 'ineligible']);
  });

  it('caps the history at 20 entries, dropping the oldest', () => {
    let [c] = run([ok([rule()])]);
    for (let i = 1; i <= 25; i += 1) {
      const r = i % 2 ? rule({ eligibility: 'ineligible', backend: null, reason: `reason ${i}` }) : rule();
      [c] = run([ok([r])], [c!], IN_A, T0 + i * 1000);
    }
    expect(c!.history).toHaveLength(20);
    expect(c!.history.at(-1)!.at).toBe(iso(T0 + 25_000));
  });

  it('marks a rule absent from a successful scan of its pair as gone', () => {
    const [c] = run([ok([rule()])]);
    const [gone] = run([ok([])], [c!], IN_A, T1);
    expect([gone!.status, gone!.goneAt]).toEqual(['gone', iso(T1)]);
  });

  it('leaves the candidates of a failed pair untouched', () => {
    const [c] = run([ok([rule({ eligibility: 'managed', workloadId: 'shop' })])]);
    expect(run([failed()], [c!], config(), T1)).toEqual([]);
  });

  it('turns a managed rule out of scope into a pending offboarding, and back to managed', () => {
    const managed = rule({ eligibility: 'managed', workloadId: 'shop', backend: null });
    const [c] = run([ok([managed])]);
    const narrowed = config({ filters: [filter('a', [{ accountIds: [A.id] }], [{ loadBalancers: ['web-*'] }])] });
    const [off] = run([ok([managed])], [c!], narrowed, T1);
    expect([off!.status, off!.statusReason]).toEqual(['pending-offboarding', 'excluded: filter "a", exclude 1']);
    const [back] = run([ok([managed])], [off!], IN_A, T1 + 1000);
    expect(back!.status).toBe('managed');
  });

  it('keeps a dismissed candidate dismissed whatever happens, until restored', () => {
    const [c] = run([ok([rule()])]);
    const dismissed = { ...c!, dismissed: { by: 'ops@example.com', at: iso(T0), note: 'legacy' } };
    const [still] = run([ok([rule({ eligibility: 'ineligible', backend: null, reason: 'fixed response' })])], [dismissed], IN_A, T1);
    expect(still!.status).toBe('dismissed');
    const { dismissed: _, ...restored } = still!;
    expect(computeStatus(restored).status).toBe('ineligible');
  });

  it('takes a candidate out of scope when its region left the perimeter', () => {
    const [c] = run([ok([rule({ eligibility: 'managed', workloadId: 'shop', region: 'eu-west-3' })], A.id, 'eu-west-3')]);
    const [after] = run([], [c!], { ...IN_A, regions: ['eu-west-1'] }, T1);
    expect([after!.status, after!.statusReason]).toEqual(['pending-offboarding', 'out of scope: region eu-west-3 is no longer in the perimeter']);
  });

  it('takes a candidate out of scope when its account left the organization', () => {
    const [c] = run([ok([rule({ account: '444444444444' })], '444444444444')], [], config({ filters: [filter('x', [{ accountIds: ['444444444444'] }])] }));
    const [after] = run([], [c!], config({ filters: [filter('x', [{ accountIds: ['444444444444'] }])] }), T1);
    expect([after!.status, after!.statusReason]).toEqual(['out-of-scope', 'out of scope: account no longer in the organization']);
  });

  it('re-decides the candidates of pairs skipped without a scan, such as a newly globally excluded account', () => {
    const [c] = run([ok([rule({ account: C.id })], C.id)]);
    const excluded = config({ globalExcludes: [{ accountIds: [C.id] }], filters: IN_A.filters });
    const [now] = run([], [c!], excluded, T1);
    expect([now!.status, now!.statusReason, now!.lastSeenAt]).toEqual(['excluded', `excluded: global exclude 1 (account ${C.id})`, iso(T0)]);
    expect(run([], [now!], excluded, T1 + 1000)).toEqual([]);
  });
});

describe('restatus', () => {
  it('recomputes the status of a stored candidate after a dismissal or a restore, with history', () => {
    const [c] = run([ok([rule()])]);
    const dismissed = restatus({ ...c!, dismissed: { by: 'ops@example.com', at: iso(T1), note: 'legacy' } }, iso(T1));
    expect([dismissed.status, dismissed.statusReason]).toEqual(['dismissed', 'dismissed by ops@example.com: legacy']);
    const { dismissed: _, ...rest } = dismissed;
    const restored = restatus(rest, iso(T1 + 1000));
    expect(restored.status).toBe('pending-onboarding');
    expect(restored.history.map((h) => h.status)).toEqual(['pending-onboarding', 'dismissed', 'pending-onboarding']);
  });
});
