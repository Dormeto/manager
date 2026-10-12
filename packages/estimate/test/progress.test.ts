// The discovery phase's progress (the user, 2026-10-11): in a terminal, one line rewritten in place (a bar, the accounts
// done, the regions, workloads and failures, the time); elsewhere (a log, CI), one line per account done.
import { describe, expect, it } from 'vitest';
import { discoveryView } from '../src/progress.js';

const A = '111111111111';
const B = '222222222222';
const region = (account: string, r: string, workloads: number, extra: { from?: 'cache' | 'aws'; error?: string } = {}) =>
  ({ phase: 'discovery' as const, account, region: r, from: extra.from ?? 'aws', workloads, ...(extra.error ? { error: extra.error } : {}) });

function terminal(accounts = 2) {
  let t = 0;
  const updates: string[] = [];
  const ends: string[] = [];
  const logs: string[] = [];
  const view = discoveryView({ accounts, now: () => t, log: (l) => logs.push(l), status: { update: (l) => updates.push(l), end: (l) => ends.push(l) } });
  return { view, updates, ends, logs, tick: (ms: number) => { t += ms; } };
}

describe('the discovery phase\'s progress', () => {
  it('in a terminal: one line, a bar by the regions scanned of each account, the accounts done, the regions, workloads, failures and time', () => {
    const s = terminal();
    s.view.account({ account: A, state: 'started', regions: 2 });
    s.tick(5_000);
    s.view.region(region(A, 'eu-west-1', 3));
    expect(s.updates.at(-1)).toBe('  Discovery [█████░░░░░░░░░░░░░░░]  25% · 0/2 accounts · 1 region · 3 workloads · 0:05');
    s.view.region(region(A, 'eu-west-3', 0, { error: 'opt-in region not enabled' }));
    s.view.account({ account: A, state: 'done', regions: 2 });
    s.view.account({ account: B, state: 'started', regions: 1 });
    s.tick(67_000);
    s.view.region(region(B, 'eu-west-1', 2, { from: 'cache' }));
    s.view.account({ account: B, state: 'done', regions: 1 });
    expect(s.updates.at(-1)).toBe('  Discovery [████████████████████] 100% · 2/2 accounts · 3 regions · 5 workloads · 1 failed · 1:12');
    s.view.end();
    expect(s.ends).toEqual(['  Discovery [████████████████████] 100% · 2/2 accounts · 3 regions · 5 workloads · 1 failed · 1:12']);
    expect(s.logs).toEqual([]);
  });

  it('an account whose regions cannot be listed counts as done and failed', () => {
    const s = terminal(1);
    s.view.account({ account: A, state: 'done', regions: 0, error: 'UnauthorizedOperation: not authorized' });
    s.view.end();
    expect(s.ends[0]).toBe('  Discovery [████████████████████] 100% · 1/1 account · 0 regions · 0 workloads · 1 failed · 0:00');
  });

  it('elsewhere: a line per account done, with its regions, workloads, those read from the cache and the failures', () => {
    const logs: string[] = [];
    const view = discoveryView({ accounts: 2, now: () => 0, log: (l) => logs.push(l) });
    view.account({ account: A, state: 'started', regions: 2 });
    view.region(region(A, 'eu-west-1', 3, { from: 'cache' }));
    view.region(region(A, 'eu-west-3', 0, { error: 'opt-in region not enabled' }));
    view.account({ account: A, state: 'done', regions: 2 });
    view.account({ account: B, state: 'done', regions: 0, error: 'UnauthorizedOperation: not authorized' });
    view.end();
    expect(logs).toEqual([
      `  discovery ${A} (1/2): 2 regions, 3 workloads, 1 from the cache, 1 failed`,
      `  discovery ${B} (2/2): failed (UnauthorizedOperation: not authorized)`,
    ]);
  });
});
