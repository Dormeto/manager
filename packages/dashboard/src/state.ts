// A workload's state for people: its icon, what it means, and since when (from the time that belongs to that state; the
// run's last write also moves on a nap request or a held request, which change no state).
import { mdiAlertCircleOutline, mdiHelpCircleOutline, mdiPowerSleep, mdiWeatherSunny, mdiWeatherSunsetDown, mdiWeatherSunsetUp } from '@mdi/js';
import { stateLabel } from './history';

const ICONS: Record<string, string> = {
  AWAKE: mdiWeatherSunny, NAPPING: mdiWeatherSunsetDown, ASLEEP: mdiPowerSleep, WAKING: mdiWeatherSunsetUp, FAILED: mdiAlertCircleOutline,
};
export const stateIcon = (state: string): string => ICONS[state] ?? mdiHelpCircleOutline;

// What a state means, in a sentence under its name (the state chip's tooltip).
const MEANING: Record<string, string> = {
  AWAKE: 'Requests go to the application; it naps once idle for its idle window.',
  NAPPING: 'Requests go to the waker while the backends stop; a request meanwhile wakes it once the nap ends.',
  ASLEEP: 'The backends are stopped and requests go to the waker; the next request wakes it, unless the wake rules ignore or defer it.',
  WAKING: 'The backends are starting; requests are held until the application answers, up to the wake timeout.',
  FAILED: 'A wake or a nap did not finish; the next request or idle check tries again.',
};
export const stateMeaning = (state: string): string => MEANING[state] ?? 'The router has not reported this workload\'s state yet.';

// In a few words, beside its share of the 7-day bar.
const BRIEF: Record<string, string> = {
  AWAKE: 'serving requests', NAPPING: 'stopping its backends', ASLEEP: 'backends stopped, the next request wakes it', WAKING: 'starting its backends',
  FAILED: 'a wake or a nap did not finish',
};
export const stateBrief = (state: string): string => BRIEF[state] ?? '';

// A workload's week by state, from its history (the 7-day bar's): awake to asleep, a failure next to the time awake, the
// wakes and naps where one turns into the other; each state's share of the time with history ("<1 %" for a sliver).
const WEEK_ORDER = ['AWAKE', 'FAILED', 'WAKING', 'NAPPING', 'ASLEEP'];
const shareOf = (part: number, total: number) => {
  const p = Math.round((100 * part) / total);
  return part > 0 && p < 1 ? '<1 %' : `${p} %`;
};
export function weekShares(totals: Record<string, number>): { state: string; seconds: number; share: string }[] {
  const known = WEEK_ORDER.filter((state) => (totals[state] ?? 0) > 0).map((state) => ({ state, seconds: totals[state]! }));
  const total = known.reduce((n, r) => n + r.seconds, 0);
  return known.map((r) => ({ ...r, share: shareOf(r.seconds, total) }));
}
// The same in words: the bar's accessible name, and a table's export.
export function weekText(totals: Record<string, number> | undefined): string {
  const shares = weekShares(totals ?? {});
  return shares.length ? shares.map((r) => `${stateLabel(r.state).toLowerCase()} ${r.share}`).join(', ') : 'no history yet';
}

type Run = { state: string; awakeSince: string | null; wakeStartedAt: string | null; failedAt: string | null; updatedAt: string | null };
const LABEL: Record<string, string> = { AWAKE: 'Awake', NAPPING: 'Napping', ASLEEP: 'Asleep', WAKING: 'Waking', FAILED: 'Failed' };

// Napping or asleep, the last write is the change to that state: a nap writes nothing more until a wake.
export function stateSince(run: Run): { label: string; at: string | null } {
  const at = { AWAKE: run.awakeSince, WAKING: run.wakeStartedAt, FAILED: run.failedAt, NAPPING: run.updatedAt, ASLEEP: run.updatedAt }[run.state] ?? null;
  return { label: `${LABEL[run.state] ?? 'State'} since`, at };
}
