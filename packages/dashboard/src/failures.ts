// Why a wake failed (routers 0.25.0, R7a): the kinds the router records, for people.
import type { Cloud } from '@dormeto/fleet/clouds';
import { cloudWords } from './cloud-words';

export interface Failure { kind: string; step: 'wake' | 'nap'; backend?: string; message: string; at: string }
export interface Fallback { instance: string; from: string; to: string }

// `unhealthy` in its cloud's words: a Google Cloud workload's backends pass a backend service's health check, it has no targets.
const LABELS: Record<string, string> = {
  capacity: 'no capacity', quota: 'quota reached', permission: 'permission refused', configuration: 'configuration refused',
  throttled: 'throttled', timeout: 'timed out', unknown: 'unknown error',
};
export const failureLabel = (kind: string, cloud: Cloud = 'aws') => (kind === 'unhealthy' ? cloudWords(cloud).unhealthy : LABELS[kind] ?? LABELS.unknown!);
export const failureTitle = (f: Failure, cloud: Cloud = 'aws') => `Last ${f.step} failed: ${failureLabel(f.kind, cloud)}`;

// What comes after the last failure: an HTTP workload's next request wakes it again or retries it; a standalone workload is
// woken by no request: the router's check retries its failed wake, and its idle signals nap it again (the review's M1).
export function retryText(s: { state: string; nextAttemptAt?: string | null }, now: number, standalone: boolean, relative: (iso: string, now: number) => string): string {
  if (s.state !== 'FAILED') return standalone ? 'it naps again once idle' : 'the next request wakes it again';
  if (s.nextAttemptAt && Date.parse(s.nextAttemptAt) > now) return `next attempt ${relative(s.nextAttemptAt, now)}`;
  return standalone ? 'the check retries it' : 'the next request retries it';
}
