// The Idle window card's words (R10): the recommended window against the current one, either way; the money is what it
// saves (a longer window saves less), never read as a cost.
import { usd } from './format';
import type { IdleWindowAdvice } from './types';

// A number a day: whole from 10, one decimal below.
export const perDay = (n: number): string => String(n >= 10 ? Math.round(n) : Math.round(n * 10) / 10);
export const hoursText = (hours: number): string => `${Math.round(hours * 10) / 10} h`;

export function adviceSentence(a: IdleWindowAdvice): string {
  if (a.recommended === a.current) return `The current window, ${a.current} minutes, is the recommended one`;
  const r = a.windows.find((w) => w.minutes === a.recommended);
  const c = a.windows.find((w) => w.minutes === a.current);
  if (!r || !c) return `Recommended: ${a.recommended} minutes`;
  const gain = a.priced && r.usdMonth !== null && c.usdMonth !== null
    ? `saves about ${usd(Math.abs(r.usdMonth - c.usdMonth))} a month ${r.usdMonth >= c.usdMonth ? 'more' : 'less'} than now`
    : `about ${perDay(Math.abs(r.asleepHours - c.asleepHours))} ${r.asleepHours >= c.asleepHours ? 'more' : 'fewer'} hours asleep a day`;
  const more = r.wakesPerDay - c.wakesPerDay;
  const wakes = more === 0 ? 'the same wakes' : `${perDay(Math.abs(more))} ${more > 0 ? 'more' : 'fewer'} wakes a day`;
  const wait = more > 0 && a.wakeSeconds !== null ? ` (about ${Math.round(a.wakeSeconds)} seconds each)` : '';
  return `Recommended: ${a.recommended} minutes, ${gain}, with ${wakes}${wait}`;
}
