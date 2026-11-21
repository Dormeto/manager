// A failed standalone workload's row after the router's final fix wave of plan 5 (router 4c1fe78, task-R31-report.md "Final fix
// wave"), both clouds: the row the router builds (lambda/src/lib/summary.mjs's standaloneRowOf on AWS, gcp/src/rows.mjs's rowOf on
// Google Cloud, read from the router's checkout beside the manager) passes through workloadOf with its failure (a failed nap's
// step), its count, its failedAt and its nextAttemptAt (null when no retry is coming) unchanged.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { workloadOf } from '../src/clean.js';

const ROUTER = resolve(import.meta.dirname, '../../../../router');
const SUMMARY = resolve(ROUTER, 'lambda/src/lib/summary.mjs');
const ROWS = resolve(ROUTER, 'gcp/src/rows.mjs');
const T = Date.parse('2026-11-21T10:00:00.000Z');
const ARN = 'arn:aws:ec2:eu-west-1:111122223333:instance/i-0abc';
const PATH = 'projects/dormeto-dev/zones/europe-west1-b/instances/batch';
const PERMISSION = 'VM batch: Google refused the change: the router may change only a resource with the tag dormeto=managed: Required \'compute.instances.stop\' permission';
const SETTINGS = { idleMinutes: 120, wakeTimeoutSeconds: 600, idleCpuPercent: 5, idleNetworkBytes: 'off', idleMetric: 'off' };

// The runs the fix wave leaves: a failed release (a nap's failure, failedAt its time, the count up), a person's nap asked of a
// failed wake (no retry coming), a failed wake to retry, and a released one (the failure, its count and marks removed, failedAt kept).
const RUNS = {
  'a failed release': { state: 'FAILED', failedAt: T, consecutiveFailures: 3, failure: JSON.stringify({ kind: 'permission', step: 'nap', message: PERMISSION, at: T }) },
  'a nap asked': { state: 'FAILED', failedAt: T, consecutiveFailures: 2, napRequestedAt: T + 60_000, failure: JSON.stringify({ kind: 'timeout', step: 'wake', message: 'still starting', at: T }) },
  'a wake to retry': { state: 'FAILED', failedAt: T, consecutiveFailures: 1, failure: JSON.stringify({ kind: 'timeout', step: 'wake', message: 'still starting', at: T }) },
  'a release': { state: 'ASLEEP', failedAt: T, stateAt: T + 120_000 },
};
const KEYS = ['state', 'failedAt', 'failure', 'consecutiveFailures', 'nextAttemptAt'] as const;
const pick = (row: Record<string, unknown>) => Object.fromEntries(KEYS.map((k) => [k, row[k]]));

describe.skipIf(!existsSync(SUMMARY) || !existsSync(ROWS))('a failed standalone workload\'s row, as the router builds it', () => {
  it('keeps on AWS its failure, a failed nap\'s step, its count, failedAt and nextAttemptAt, null when no retry is coming', async () => {
    const { standaloneRowOf, workloadRow } = await import(pathToFileURL(SUMMARY).href) as { standaloneRowOf: (r: unknown, c: unknown, run: unknown) => Record<string, unknown>; workloadRow: (c: unknown, run: unknown, o: unknown) => Record<string, unknown> };
    const cfg = { workloadId: 'a1b2c3d4e5f60718', kind: 'standalone', resourceArn: ARN, source: 'manager', ...SETTINGS };
    const rows = Object.fromEntries(Object.entries(RUNS).map(([name, run]) => [name, standaloneRowOf(workloadRow(cfg, run, { identity: { kind: 'standalone', resourceArn: ARN }, defaultSource: 'terraform', backends: ['instance'] }), cfg, run)]));
    expect(pick(rows['a failed release']!)).toMatchObject({ failure: { step: 'nap', kind: 'permission', message: PERMISSION }, consecutiveFailures: 3, nextAttemptAt: null });
    expect(rows['a nap asked']!.nextAttemptAt).toBeNull();
    expect(typeof rows['a wake to retry']!.nextAttemptAt).toBe('string');
    expect(pick(rows['a release']!)).toEqual({ state: 'ASLEEP', failedAt: new Date(T).toISOString(), failure: null, consecutiveFailures: 0, nextAttemptAt: null });
    for (const [name, row] of Object.entries(rows)) expect(pick(workloadOf(row)!), name).toEqual(pick(row));
  });

  it('keeps them on Google Cloud, the permission failure naming the tag', async () => {
    const { rowOf } = await import(pathToFileURL(ROWS).href) as { rowOf: (o: unknown) => Record<string, unknown> };
    const cfg = { workloadId: 'batch', kind: 'standalone', resource: PATH, backends: [{ kind: 'vm', name: 'batch', zone: 'europe-west1-b' }], ...SETTINGS };
    const rows = Object.fromEntries(Object.entries(RUNS).map(([name, run]) => [name, rowOf({ cfg, run, routerName: 'dmtr-dormeto-dev-europe-west1' })]));
    expect((rows['a failed release']!.failure as { message: string }).message).toContain('dormeto=managed');
    expect(rows['a failed release']!.nextAttemptAt).toBeNull();
    for (const [name, row] of Object.entries(rows)) expect(pick(workloadOf(row, 'gcp')!), name).toEqual(pick(row));
  });
});
