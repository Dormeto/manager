// A standalone workload's row as the fleet stores it (vision standalone workloads design §5, §6; the router's handover, "The
// row"): its kind, resource, missing resource and its kind's five settings with where each comes from kept whole; an HTTP
// row byte-equal to before (no kind).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { workloadOf } from '../src/clean.js';

const ARN = 'arn:aws:ec2:eu-west-1:111122223333:instance/i-0abc';
// The handover's row keys, in their order.
const ROW = {
  workloadId: 'a1b2c3d4e5f60718', name: 'build-agent', kind: 'standalone', resourceArn: ARN, source: 'manager', tags: { team: 'ci' }, state: 'ASLEEP',
  stateAt: '2026-11-21T10:00:00.000Z', wakeCount: 2, awakeSince: null, wakeStartedAt: null, failedAt: null, failure: null, consecutiveFailures: 0,
  nextAttemptAt: null, updatedAt: '2026-11-21T10:00:00.000Z', pendingWake: false, backends: ['instance', 'rds-instance'], resourceMissing: true, pauses: [],
  stats7d: { wakes: 4 }, type: 'instance',
  settingsFrom: { idleMinutes: 'default', wakeTimeoutSeconds: 'default', idleCpuPercent: 'type', idleNetworkBytes: 'workload', idleMetric: 'organization' },
  settings: {
    idleMinutes: 120, wakeTimeoutSeconds: 600, idleCpuPercent: 'off', idleNetworkBytes: 1000,
    idleMetric: { namespace: 'Custom/Jobs', name: 'Queue', dimensions: { Instance: '${resource}' }, statistic: 'Maximum', below: 1 },
  },
};

describe('a standalone workload\'s row', () => {
  it('keeps its kind, its resource, its missing resource and its five settings with their levels; no URL or wake mode', () => {
    const row = workloadOf(ROW)!;
    expect(row).toMatchObject({
      kind: 'standalone', resourceArn: ARN, resourceMissing: true, state: 'ASLEEP', backends: ['instance', 'rds-instance'], stats7d: { wakes: 4 },
      settings: ROW.settings, settingsFrom: ROW.settingsFrom, type: 'instance',
    });
    expect(Object.keys(row)).not.toEqual(expect.arrayContaining(['url']));
    for (const key of ['url', 'wakeMode', 'targetGroupArn']) expect(row, key).not.toHaveProperty(key);
  });

  it('drops what is not of its kind or shape: an HTTP key, a bad signal, a resource that is no ARN, a kind it does not know', () => {
    const row = workloadOf({
      ...ROW, resourceArn: 'i-0abc', resourceMissing: 'yes', kind: 'standalone',
      settings: { ...ROW.settings, idleCpuPercent: 'high', idleNetworkBytes: -1, idleMetric: { namespace: 'x', name: 'y', dimensions: {}, statistic: 'Median', below: 1 }, waitSeconds: 60 },
    })!;
    expect([row.resourceArn, row.resourceMissing]).toEqual([undefined, undefined]);
    expect(row.settings).toEqual({ idleMinutes: 120, wakeTimeoutSeconds: 600 });
    expect(workloadOf({ ...ROW, kind: 'batch' })!).not.toHaveProperty('kind');
  });
});

describe('an HTTP workload\'s row', () => {
  // The router's HTTP rows (its lambda/test/fixtures/http-rows.json, copied with what this manager stored of them before).
  const pinned = JSON.parse(readFileSync(new URL('./fixtures/http-rows-clean.json', import.meta.url), 'utf8')) as { input: Record<string, unknown>; output: Record<string, unknown> };
  it('is byte-equal to what the fleet stored before standalone workloads, without a kind', () => {
    for (const [name, input] of Object.entries(pinned.input)) {
      expect(JSON.stringify(workloadOf(input)), name).toBe(JSON.stringify(pinned.output[name]));
      expect(workloadOf(input), name).not.toHaveProperty('kind');
    }
  });

  const FIXTURE = resolve(import.meta.dirname, '../../../../router/lambda/test/fixtures/http-rows.json');
  it.skipIf(!existsSync(FIXTURE))('is the router\'s current HTTP row', () => {
    const rows = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, { list: { workloads: unknown[] } }>;
    for (const [name, r] of Object.entries(rows)) expect(r.list.workloads[0], name).toEqual(pinned.input[name]);
  });
});

// The router's own row of a standalone workload (lambda/src/lib/summary.mjs workloadSummary), kept whole but its null
// times. Skipped without the router's checkout beside the manager's.
const SUMMARY = resolve(import.meta.dirname, '../../../../router/lambda/src/lib/summary.mjs');
const summary = (existsSync(SUMMARY) ? await import(/* @vite-ignore */ SUMMARY) : null) as { workloadSummary(cfg: unknown, run?: unknown, host?: unknown, stats?: unknown): Record<string, unknown> } | null;
describe.skipIf(!summary)('the router\'s standalone row', () => {
  it('keeps every key the router sends that the manager shows', () => {
    const cfg = { workloadId: 'a1b2c3d4e5f60718', kind: 'standalone', resourceArn: ARN, name: 'build-agent', source: 'manager', tags: {}, idleMinutes: 120, wakeTimeoutSeconds: 600, idleCpuPercent: 5, idleNetworkBytes: 'off', idleMetric: 'off' };
    const row = summary!.workloadSummary(cfg, { state: 'AWAKE', backendKinds: 'instance', resourceMissing: true }, null, { wakes: 1, ignored: 0, deferred: 0 });
    const kept = workloadOf(row)!;
    expect(kept).toMatchObject({ kind: 'standalone', resourceArn: ARN, resourceMissing: true, backends: ['instance'], stats7d: { wakes: 1 }, settings: cfg.idleCpuPercent ? { idleMinutes: 120, wakeTimeoutSeconds: 600, idleCpuPercent: 5, idleNetworkBytes: 'off', idleMetric: 'off' } : {} });
    expect(Object.keys(row).filter((k) => !(k in kept) && row[k] !== null && row[k] !== undefined && !(Array.isArray(row[k]) && !(row[k] as unknown[]).length))).toEqual([]);
  });
});
