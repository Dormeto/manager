// A period's phases and totals from its transitions (R8), computed when read.
import { describe, expect, it } from 'vitest';
import { historyView } from '../src/history.js';
import type { HistoryEntry } from '../src/store.js';

const DAY = '2026-10-08T00:00:00.000Z';
const t = (minutes: number) => new Date(Date.parse(DAY) + minutes * 60_000).toISOString();
const e = (to: string, minutes: number, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({ account: '1', region: 'eu-west-1', router: 'r', workloadId: 'w', from: null, to, at: t(minutes), ...extra });

describe('history view', () => {
  it('a day with a nap and a wake: phases from the state before the period to its end, totals that add up', () => {
    const v = historyView({
      before: e('AWAKE', -30), from: t(0), to: t(1440), now: t(2000),
      entries: [e('NAPPING', 60, { cause: 'idle' }), e('ASLEEP', 61), e('WAKING', 600, { cause: 'normal' }), e('AWAKE', 601, { durationMs: 45_000 })],
    });
    expect(v.phases.map((p) => [p.state, p.from, p.to])).toEqual([
      ['AWAKE', t(0), t(60)], ['NAPPING', t(60), t(61)], ['ASLEEP', t(61), t(600)], ['WAKING', t(600), t(601)], ['AWAKE', t(601), t(1440)],
    ]);
    expect(v.phases[1]!.cause).toBe('idle');
    expect(v.totals).toEqual({ AWAKE: (60 + 839) * 60, NAPPING: 60, ASLEEP: 539 * 60, WAKING: 60 });
    expect(Object.values(v.totals).reduce((a, b) => a + b, 0)).toBe(1440 * 60);
    expect(v.wakes).toEqual({ count: 1, failed: 0, medianMs: 45_000, maxMs: 45_000 });
  });

  it('a period without transitions is one phase; before the history, UNKNOWN; it ends at now', () => {
    expect(historyView({ before: e('ASLEEP', -100), entries: [], from: t(0), to: t(60), now: t(90) }).phases).toEqual([{ state: 'ASLEEP', from: t(0), to: t(60) }]);
    const start = historyView({ before: null, entries: [e('AWAKE', 30, { inferred: true })], from: t(0), to: t(120), now: t(90) });
    expect(start.phases.map((p) => [p.state, p.from, p.to])).toEqual([['UNKNOWN', t(0), t(30)], ['AWAKE', t(30), t(90)]]);
    expect(start.to).toBe(t(90));
  });

  it('an inferred twin of a transition is absorbed, a future time ends at now, and a zero-length phase is dropped', () => {
    const v = historyView({
      before: e('ASLEEP', -10), from: t(0), to: t(60), now: t(60),
      entries: [e('WAKING', 5, { cause: 'normal' }), e('WAKING', 6, { inferred: true }), e('AWAKE', 7), e('NAPPING', 7), e('ASLEEP', 90)],
    });
    expect(v.phases.map((p) => [p.state, p.from, p.to])).toEqual([['ASLEEP', t(0), t(5)], ['WAKING', t(5), t(7)], ['NAPPING', t(7), t(60)]]);
    expect(v.phases[1]!.cause).toBe('normal');
  });

  it('counts failed wakes and gives the median and longest wake', () => {
    const v = historyView({
      before: e('ASLEEP', -10), from: t(0), to: t(100), now: t(100),
      entries: [
        e('WAKING', 1), e('AWAKE', 2, { durationMs: 30_000 }), e('NAPPING', 10), e('ASLEEP', 11),
        e('WAKING', 20), e('FAILED', 30, { failure: { kind: 'capacity', step: 'wake', message: 'no capacity' } }),
        e('WAKING', 40), e('AWAKE', 41, { durationMs: 90_000 }), e('NAPPING', 50), e('ASLEEP', 51),
        e('WAKING', 60), e('AWAKE', 61, { durationMs: 40_000 }),
      ],
    });
    expect(v.wakes).toEqual({ count: 4, failed: 1, medianMs: 40_000, maxMs: 90_000 });
  });

  it('a first entry\'s phase says so; with no entry before the period, the initial state given is used (review M7, I3)', () => {
    const v = historyView({ before: null, initial: 'ASLEEP', entries: [e('WAKING', 30, { from: 'ASLEEP', cause: 'normal' })], from: t(0), to: t(60), now: t(60) });
    expect(v.phases.map((p) => [p.state, p.from])).toEqual([['ASLEEP', t(0)], ['WAKING', t(30)]]);
    const first = historyView({ before: null, entries: [e('AWAKE', 10, { inferred: true })], from: t(0), to: t(60), now: t(60) });
    expect(first.phases[1]).toMatchObject({ state: 'AWAKE', first: true });
  });

  it('an asleep phase carries what its nap stopped (R9)', () => {
    const stopped = [{ kind: 'ec2' as const, type: 't3.medium', count: 1, os: 'Linux' }];
    const v = historyView({ before: e('AWAKE', -10), entries: [e('ASLEEP', 10, { stopped })], from: t(0), to: t(60), now: t(60) });
    expect(v.phases[1]).toMatchObject({ state: 'ASLEEP', stopped });
  });

  it('the first phase keeps what the entry before the period says: its cause, who, what it stopped (R9, review M4)', () => {
    const stopped = [{ kind: 'ec2' as const, type: 't3.medium', count: 1, os: 'Linux' }];
    const v = historyView({ before: e('ASLEEP', -100, { cause: 'idle', stopped }), entries: [], from: t(0), to: t(60), now: t(60) });
    expect(v.phases).toEqual([{ state: 'ASLEEP', from: t(0), to: t(60), cause: 'idle', stopped }]);
  });
});

