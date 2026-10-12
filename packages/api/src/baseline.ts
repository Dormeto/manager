// The savings baseline (R9b), from the manager's settings: always (24/7) or business hours in a time zone.
import type { Baseline } from '@dormeto/fleet';

export const baselineOf = (kind: string | undefined, timeZone: string | undefined): Baseline =>
  (kind === 'business-hours' ? { kind: 'business-hours', timeZone: timeZone || 'UTC' } : { kind: 'always' });
