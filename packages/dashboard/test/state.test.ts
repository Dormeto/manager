import { describe, expect, it } from 'vitest';
import { runFacts, stateMeaning, stateSince, weekShares, weekText } from '../src/state';

const run = { awakeSince: '2026-10-07T21:20:00.000Z', wakeStartedAt: '2026-10-07T21:18:00.000Z', failedAt: '2026-10-06T10:00:00.000Z', updatedAt: '2026-10-07T21:50:00.000Z' };

describe('workload state', () => {
  it('dates a state from the time that belongs to it, never from the last write of an awake workload', () => {
    expect(stateSince({ ...run, state: 'AWAKE' })).toEqual({ label: 'Awake since', at: run.awakeSince });
    expect(stateSince({ ...run, state: 'WAKING' })).toEqual({ label: 'Waking since', at: run.wakeStartedAt });
    expect(stateSince({ ...run, state: 'FAILED' })).toEqual({ label: 'Failed since', at: run.failedAt });
    // Napping or asleep, the last write is the change to that state (a nap writes nothing more until a wake).
    expect(stateSince({ ...run, state: 'NAPPING' })).toEqual({ label: 'Napping since', at: run.updatedAt });
    expect(stateSince({ ...run, state: 'ASLEEP' })).toEqual({ label: 'Asleep since', at: run.updatedAt });
    expect(stateSince({ ...run, state: 'UNKNOWN' })).toEqual({ label: 'State since', at: null });
  });

  // M37 (user request): what a Workloads row's Since, Wake mode and Wakes columns said, now in its 7-day bar and that column's text.
  it('says since when a workload is in its state, its wake mode and its wakes, each one it has, its date as `when` says it', () => {
    const when = (iso: string) => `at ${iso}`;
    expect(runFacts({ ...run, state: 'AWAKE', wakeMode: 'any', wakeCount: 1234, stats7d: { wakes: 4, ignored: 1, deferred: 0 } }, when)).toEqual([
      { label: 'Awake since', value: `at ${run.awakeSince}` }, { label: 'Wake mode', value: 'any' }, { label: 'Wakes in the last 7 days', value: '4' }, { label: 'Wakes in total', value: '1,234' },
    ]);
    // None is a count too.
    expect(runFacts({ ...run, state: 'FAILED', wakeCount: 0, stats7d: { wakes: 0, ignored: 0, deferred: 0 } }, when)).toEqual([
      { label: 'Failed since', value: `at ${run.failedAt}` }, { label: 'Wakes in the last 7 days', value: '0' }, { label: 'Wakes in total', value: '0' },
    ]);
    // An awake run without its wake's time is dated from its last write, as the Since column was.
    expect(runFacts({ ...run, awakeSince: null, state: 'AWAKE' }, when)).toEqual([{ label: 'Awake since', value: `at ${run.updatedAt}` }]);
    // Nothing known, nothing said: no date, no wake mode, no statistics or none of its wakes, no count.
    const unknown = { awakeSince: null, wakeStartedAt: null, failedAt: null, updatedAt: null };
    expect(runFacts({ ...unknown, state: 'ASLEEP', stats7d: null }, when)).toEqual([]);
    expect(runFacts({ ...unknown, state: 'UNKNOWN', wakeMode: '', stats7d: { ignored: 2 } }, when)).toEqual([]);
  });

  // A sentence under the state's name (the state chip's tooltip, tables design §3).
  it('explains each state', () => {
    expect(stateMeaning('AWAKE')).toMatch(/^Requests go to the application/);
    expect(stateMeaning('NAPPING')).toMatch(/^Requests go to the waker while the backends stop/);
    expect(stateMeaning('ASLEEP')).toMatch(/^The backends are stopped.*the next request wakes it/);
    expect(stateMeaning('WAKING')).toMatch(/^The backends are starting/);
    expect(stateMeaning('FAILED')).toMatch(/^A wake or a nap did not finish/);
    expect(stateMeaning('UNKNOWN')).toMatch(/^The router has not reported this workload's state yet/);
  });

  // The 7-day bar's states in words: its name, and a table's export (tables design §5).
  it('says a workload\'s week by state, awake first and asleep last, a sliver as <1 %, the time without history left out', () => {
    const totals = { UNKNOWN: 86_400, ASLEEP: 432_000, AWAKE: 86_000, WAKING: 400 };
    expect(weekShares(totals)).toEqual([
      { state: 'AWAKE', seconds: 86_000, share: '17 %' }, { state: 'WAKING', seconds: 400, share: '<1 %' }, { state: 'ASLEEP', seconds: 432_000, share: '83 %' },
    ]);
    expect(weekText(totals)).toBe('awake 17 %, waking <1 %, asleep 83 %');
    expect(weekText({ UNKNOWN: 604_800 })).toBe('no history yet');
    expect(weekText(undefined)).toBe('no history yet');
  });
});
