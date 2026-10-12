// The discovery phase's progress (the user, 2026-10-11): in a terminal, one line rewritten in place (a bar, the accounts
// done, the regions, workloads and failures, the time); elsewhere (a log, CI), one line per account done.
import { describe, expect, it } from 'vitest';
import { discoveryView, regionsView } from '../src/progress.js';

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

// A scheduler that runs when told: the view's timer, advanced by hand.
function clock() {
  let t = 0;
  const timers: { ms: number; fn: () => void }[] = [];
  return {
    now: () => t,
    every: (ms: number, fn: () => void) => { const timer = { ms, fn }; timers.push(timer); return () => { timers.splice(timers.indexOf(timer), 1); }; },
    advance: (ms: number) => { t += ms; for (const timer of [...timers]) timer.fn(); },
    timers,
  };
}

describe('the discovery phase\'s progress while it waits (the user, 2026-10-11: it seemed stuck at 99%)', () => {
  it('in a terminal: redrawn every second (the clock goes on), and the last accounts still read named with how long they take', () => {
    const c = clock();
    const updates: string[] = [];
    const view = discoveryView({ accounts: 3, now: c.now, every: c.every, log: () => {}, status: { update: (l) => updates.push(l), end: () => {} } });
    expect(c.timers.map((t) => t.ms)).toEqual([1000]);
    view.account({ account: A, state: 'started', regions: 1 });
    view.region(region(A, 'eu-west-1', 2));
    view.account({ account: A, state: 'done', regions: 1 });
    c.advance(20_000);
    view.account({ account: B, state: 'started', regions: 1 });
    c.advance(40_000);
    view.account({ account: '333333333333', state: 'started', regions: 1 });
    c.advance(5_000);
    expect(updates.at(-1)).toBe(`  Discovery [███████░░░░░░░░░░░░░]  33% · 1/3 accounts · 1 region · 2 workloads · 1:05 · waiting for ${B} (0:45), 333333333333 (0:05)`);
    view.end();
    expect(c.timers).toEqual([]);
  });

  it('elsewhere: every minute, the accounts still read with how long they take (at most five named)', () => {
    const c = clock();
    const logs: string[] = [];
    const view = discoveryView({ accounts: 8, now: c.now, every: c.every, log: (l) => logs.push(l) });
    expect(c.timers.map((t) => t.ms)).toEqual([60_000]);
    for (let i = 1; i <= 7; i += 1) view.account({ account: String(i).repeat(12), state: 'started', regions: 1 });
    c.advance(60_000);
    expect(logs).toEqual([`  discovery: still reading 7 accounts: ${'1'.repeat(12)} (1:00), ${'2'.repeat(12)} (1:00), ${'3'.repeat(12)} (1:00), ${'4'.repeat(12)} (1:00), ${'5'.repeat(12)} (1:00) and 2 more`]);
    view.end();
    expect(c.timers).toEqual([]);
  });
});

describe('the discovery phase\'s progress', () => {
  it('in a terminal: one line, a bar by the regions scanned of each account, the accounts done, the regions, workloads, failures and time', () => {
    const s = terminal();
    s.view.account({ account: A, state: 'started', regions: 2 });
    s.tick(5_000);
    s.view.region(region(A, 'eu-west-1', 3));
    expect(s.updates.at(-1)).toBe(`  Discovery [█████░░░░░░░░░░░░░░░]  25% · 0/2 accounts · 1 region · 3 workloads · 0:05 · waiting for ${A} (0:05)`);
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

// The user, 2026-10-11: phase 2's CloudWatch reads (the requests, then the uptime) shown as discovery is.
describe('phase 2\'s progress, by region', () => {
  const done = (phase: 'requests' | 'uptime', account: string, workloads: number, extra: { from?: 'cache' | 'aws'; error?: string } = {}) =>
    ({ phase, account, region: 'eu-west-1', from: extra.from ?? 'aws', workloads, ...(extra.error ? { error: extra.error } : {}) });

  it('in a terminal: one line redrawn every second, the regions read of those to read, the workloads, failures, time, the last regions named', () => {
    const c = clock();
    const updates: string[] = [];
    const ends: string[] = [];
    const view = regionsView({ label: 'Requests', now: c.now, every: c.every, log: () => {}, status: { update: (l) => updates.push(l), end: (l) => ends.push(l) } });
    expect(c.timers.map((t) => t.ms)).toEqual([1000]);
    view.plan(3);
    view.start(A, 'eu-west-1');
    c.advance(10_000);
    view.done(done('requests', A, 5));
    view.start(B, 'eu-west-1');
    view.start('333333333333', 'eu-west-1');
    c.advance(30_000);
    expect(updates.at(-1)).toBe(`  Requests [███████░░░░░░░░░░░░░]  33% · 1/3 regions · 5 workloads · 0:40 · waiting for ${B} eu-west-1 (0:30), 333333333333 eu-west-1 (0:30)`);
    view.done(done('requests', B, 2, { error: 'Throttling: rate exceeded' }));
    view.done(done('requests', '333333333333', 1, { from: 'cache' }));
    view.end();
    expect(ends).toEqual(['  Requests [████████████████████] 100% · 3/3 regions · 8 workloads · 1 failed · 0:40']);
    expect(c.timers).toEqual([]);
  });

  it('elsewhere: a line per region read, as before, and every minute the regions still read', () => {
    const c = clock();
    const logs: string[] = [];
    const view = regionsView({ label: 'Uptime', now: c.now, every: c.every, log: (l) => logs.push(l) });
    view.plan(2);
    view.start(A, 'eu-west-1');
    view.start(B, 'eu-west-1');
    view.done(done('uptime', A, 1, { from: 'cache' }));
    c.advance(60_000);
    view.end();
    expect(logs).toEqual([`  uptime ${A} eu-west-1: 1 workload (cache)`, `  uptime: still reading 1 region: ${B} eu-west-1 (1:00)`]);
  });

  it('nothing to read: no line at all', () => {
    const c = clock();
    const ends: string[] = [];
    const view = regionsView({ label: 'Uptime', now: c.now, every: c.every, log: () => {}, status: { update: () => {}, end: (l) => ends.push(l) } });
    view.plan(0);
    view.end();
    expect(ends).toEqual([]);
  });
});
