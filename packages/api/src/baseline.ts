// The savings baseline (R9b), from the manager's settings: always (24/7) or business hours in a time zone. A time zone
// Intl does not know is UTC, said in a warning (review I4: a typo must not break every workload's history).
import type { Baseline } from '@dormeto/fleet';

const known = (timeZone: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
};

export function baselineOf(kind: string | undefined, timeZone: string | undefined, warn: (message: string) => void = (m) => console.log(JSON.stringify({ level: 'warn', event: 'SavingsTimeZone', message: m }))): Baseline {
  if (kind !== 'business-hours') return { kind: 'always' };
  if (timeZone && !known(timeZone)) warn(`savings_timezone ${timeZone} is not a time zone: UTC is used`);
  return { kind: 'business-hours', timeZone: timeZone && known(timeZone) ? timeZone : 'UTC' };
}
