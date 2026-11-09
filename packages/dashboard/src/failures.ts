// Why a wake failed (routers 0.25.0, R7a): the kinds the router records, for people.
import type { Cloud } from '@dormeto/fleet/clouds';

export interface Failure { kind: string; step: 'wake' | 'nap'; backend?: string; message: string; at: string }
export interface Fallback { instance: string; from: string; to: string }

const LABELS: Record<string, string> = {
  capacity: 'no capacity', quota: 'quota reached', permission: 'permission refused', configuration: 'configuration refused',
  unhealthy: 'no healthy target', throttled: 'throttled', timeout: 'timed out', unknown: 'unknown error',
};
// A Google Cloud workload's backends pass a backend service's health check: it has no targets.
export const failureLabel = (kind: string, cloud: Cloud = 'aws') => (cloud === 'gcp' && kind === 'unhealthy' ? 'no healthy backend' : LABELS[kind] ?? LABELS.unknown!);
export const failureTitle = (f: Failure, cloud: Cloud = 'aws') => `Last ${f.step} failed: ${failureLabel(f.kind, cloud)}`;
