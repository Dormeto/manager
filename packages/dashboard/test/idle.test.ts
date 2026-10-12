// The Idle window card's sentence (R10): the recommended window against the current one, either way.
import { describe, expect, it } from 'vitest';
import { adviceSentence } from '../src/idle';
import type { IdleWindowAdvice, IdleWindowRow } from '../src/types';

const row = (minutes: number, usdMonth: number | null, wakesPerDay: number, asleepHours = 20): IdleWindowRow => ({ minutes, asleepHours, usdMonth, wakesPerDay, waitSecondsPerDay: null });
const advice = (current: number, recommended: number, windows: IdleWindowRow[], over: Partial<IdleWindowAdvice> = {}): IdleWindowAdvice => ({
  computedAt: '2026-10-10T12:00:00.000Z', from: '2026-09-26T12:00:00.000Z', to: '2026-10-10T12:00:00.000Z', current, recommended, checkMinutes: 5,
  wakeSeconds: 25, priced: true, windows, actual: { wakes: 10, replayedWakes: 10, noisy: false }, wakerTargetGroup: true, ...over,
});

describe('the idle window advice in a sentence', () => {
  it('a shorter window: more savings, more wakes, how long each', () => {
    expect(adviceSentence(advice(15, 10, [row(10, 32, 5), row(15, 20, 2)]))).toBe('Recommended: 10 minutes, about $12.00 a month more than now and 3 more wakes a day (about 25 seconds each)');
  });

  it('a longer window: fewer wakes, less savings', () => {
    expect(adviceSentence(advice(15, 30, [row(15, 20, 12), row(30, 16, 2)]))).toBe('Recommended: 30 minutes, about $4.00 a month less than now and 10 fewer wakes a day');
  });

  it('the current window recommended', () => {
    expect(adviceSentence(advice(15, 15, [row(15, 20, 2)]))).toBe('The current window, 15 minutes, is the recommended one');
  });

  it('not priced: hours asleep instead of dollars; no wake measured: no wait', () => {
    const a = advice(15, 5, [row(5, null, 2.5, 22.25), row(15, null, 1, 21)], { priced: false, wakeSeconds: null });
    expect(adviceSentence(a)).toBe('Recommended: 5 minutes, about 1.3 more hours asleep a day and 1.5 more wakes a day');
  });
});
