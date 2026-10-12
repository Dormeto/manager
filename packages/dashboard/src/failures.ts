// Why a wake failed (routers 0.25.0, R7a): the kinds the router records, for people.
export interface Failure { kind: string; step: 'wake' | 'nap'; backend?: string; message: string; at: string }
export interface Fallback { instance: string; from: string; to: string }

const LABELS: Record<string, string> = {
  capacity: 'no capacity', quota: 'quota reached', permission: 'permission refused', configuration: 'configuration refused',
  unhealthy: 'no healthy target', throttled: 'throttled', timeout: 'timed out', unknown: 'unknown error',
};
export const failureLabel = (kind: string) => LABELS[kind] ?? LABELS.unknown!;
export const failureTitle = (f: Failure) => `Last ${f.step} failed: ${failureLabel(f.kind)}`;
