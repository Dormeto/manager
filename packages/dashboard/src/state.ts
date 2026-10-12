// A workload's state for people: its icon, what it means, and since when (from the time that belongs to that state; the
// run's last write also moves on a nap request or a held request, which change no state).
import { mdiAlertCircleOutline, mdiHelpCircleOutline, mdiPowerSleep, mdiWeatherSunny, mdiWeatherSunsetDown, mdiWeatherSunsetUp } from '@mdi/js';

const ICONS: Record<string, string> = {
  AWAKE: mdiWeatherSunny, NAPPING: mdiWeatherSunsetDown, ASLEEP: mdiPowerSleep, WAKING: mdiWeatherSunsetUp, FAILED: mdiAlertCircleOutline,
};
export const stateIcon = (state: string): string => ICONS[state] ?? mdiHelpCircleOutline;

const HELP: Record<string, string> = {
  AWAKE: 'Awake: requests go to the application; it naps once idle for its idle window.',
  NAPPING: 'Napping: requests go to the waker while the backends stop; a request meanwhile wakes it once the nap ends.',
  ASLEEP: 'Asleep: the backends are stopped and requests go to the waker; the next request wakes it, unless the wake rules ignore or defer it.',
  WAKING: 'Waking: the backends are starting; requests are held until the application answers, up to the wake timeout.',
  FAILED: 'Failed: a wake or a nap did not finish; the next request or idle check tries again.',
};
export const stateHelp = (state: string): string => HELP[state] ?? 'Unknown: the router has not reported this workload\'s state yet.';

// In a few words, beside its share of the 7-day bar.
const BRIEF: Record<string, string> = {
  AWAKE: 'serving requests', NAPPING: 'stopping its backends', ASLEEP: 'backends stopped, the next request wakes it', WAKING: 'starting its backends',
  FAILED: 'a wake or a nap did not finish',
};
export const stateBrief = (state: string): string => BRIEF[state] ?? '';

type Run = { state: string; awakeSince: string | null; wakeStartedAt: string | null; failedAt: string | null; updatedAt: string | null };
const LABEL: Record<string, string> = { AWAKE: 'Awake', NAPPING: 'Napping', ASLEEP: 'Asleep', WAKING: 'Waking', FAILED: 'Failed' };

// Napping or asleep, the last write is the change to that state: a nap writes nothing more until a wake.
export function stateSince(run: Run): { label: string; at: string | null } {
  const at = { AWAKE: run.awakeSince, WAKING: run.wakeStartedAt, FAILED: run.failedAt, NAPPING: run.updatedAt, ASLEEP: run.updatedAt }[run.state] ?? null;
  return { label: `${LABEL[run.state] ?? 'State'} since`, at };
}
