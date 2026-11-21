// A Google Cloud standalone workload's activity (plan 5, M51): the activity step's Google Cloud form reads the router's queries
// (gcp/src/idle-signals.mjs) as the discovery account, a group's VMs from its listManagedInstances, in 5-minute points; each signal's
// value at each point is the router's own on the same Cloud Monitoring answers (CPU a ratio to percent, a group's every VM, network
// in and out a minute, the custom metric, Cloud SQL's connections). The parity part is skipped without the router's checkout.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { signalValues, type GoogleBackend } from '@dormeto/fleet';
import { googleActivityStep } from '../src/gcp-activity.js';

const PROJECT = 'dormeto-dev';
const ZONE = 'europe-west1-b';
const NOW = Date.UTC(2026, 10, 21, 12, 7);
const POINT = 300_000;
// Each series' value at a point start: by metric type and key (a VM's name, a database id, 'custom'); undefined: no point.
function value(type: string, key: string, t: number): number | undefined {
  const p = Math.floor(t / POINT);
  const h = [...`${type}${key}`].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  if ((p + h) % 29 === 0) return undefined;
  const busy = (p + h) % 7 === 0;
  if (type.endsWith('cpu/utilization')) return busy ? 0.31 : 0.012 + ((p + h) % 5) / 1000;
  if (type.endsWith('bytes_count')) return busy ? 90_000 : 1200 + ((p + h) % 9) * 10;
  if (type.endsWith('/connections')) return busy ? 3 : 0;
  return busy ? 5 : 0;
}
// Cloud Monitoring and Compute Engine as the step and the router call them.
function google() {
  const calls: string[] = [];
  const call = async (method: string, url: string) => {
    calls.push(`${method} ${url}`);
    const u = new URL(url);
    if (u.pathname.endsWith('/listManagedInstances')) return { managedInstances: ['workers-a1', 'workers-b2'].map((n) => ({ instance: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/zones/${ZONE}/instances/${n}` })) };
    const q = u.searchParams;
    const filter = q.get('filter') ?? '';
    const type = /metric\.type = "([^"]+)"/.exec(filter)![1]!;
    const start = Date.parse(q.get('interval.startTime')!);
    const end = Date.parse(q.get('interval.endTime')!);
    const names = [...(/instance_name = one_of\(([^)]*)\)/.exec(filter)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    const db = /database_id = "([^"]+)"/.exec(filter)?.[1] ?? (/database_id = ends_with\("([^"]+)"\)/.exec(filter) ? `${PROJECT}${/ends_with\("([^"]+)"\)/.exec(filter)![1]}` : undefined);
    const keys = names.length ? names : [db ?? 'custom'];
    return {
      timeSeries: keys.map((key) => {
        const points = [];
        for (let t = start; t < end; t += POINT) {
          const v = value(type, key, t);
          if (v !== undefined) points.push({ interval: { startTime: new Date(t).toISOString(), endTime: new Date(t + POINT).toISOString() }, value: { doubleValue: v } });
        }
        return { metric: { type, labels: names.length ? { instance_name: key } : {} }, resource: { labels: { ...(db ? { database_id: db } : {}) } }, points: points.reverse() };
      }),
    };
  };
  return { calls, call };
}

const CUSTOM = { type: 'custom.googleapis.com/queue/depth', filter: 'metric.labels.agent = "${resource}"', aligner: 'ALIGN_MAX', below: 1 };
const CASES: [string, GoogleBackend[], Record<string, unknown>, unknown[]][] = [
  ['a VM: CPU, network, its custom metric', [{ kind: 'instance', id: 'build-agent', location: ZONE }], { idleCpuPercent: 5, idleNetworkBytes: 1000, idleMetric: CUSTOM }, [{ kind: 'vm', location: ZONE, name: 'build-agent' }]],
  ['a group: each VM', [{ kind: 'asg', id: 'workers', location: ZONE }], { idleCpuPercent: 5, idleNetworkBytes: 1000, idleMetric: 'off' }, [{ kind: 'mig', location: ZONE, name: 'workers', instances: ['workers-a1', 'workers-b2'] }]],
  ['a Cloud SQL resource: its connections', [{ kind: 'cloudsql-instance', id: 'orders' }], { idleCpuPercent: 'off', idleNetworkBytes: 1000, idleMetric: { type: 'cloudsql.googleapis.com/database/network/connections', filter: 'resource.type = "cloudsql_database" AND resource.labels.database_id = ends_with(":orders")', aligner: 'ALIGN_MAX', below: 1 } }, [{ kind: 'cloudsql', name: 'orders' }]],
  ['a VM with a Cloud SQL companion: its own CPU, and Cloud SQL\'s CPU not read', [{ kind: 'instance', id: 'api-1', location: ZONE }, { kind: 'cloudsql-instance', id: 'side', companion: true }], { idleCpuPercent: 5, idleNetworkBytes: 'off', idleMetric: 'off' }, [{ kind: 'vm', location: ZONE, name: 'api-1' }, { kind: 'cloudsql', name: 'side' }]],
];

describe('the activity step on Google Cloud', () => {
  it('reads a group\'s VMs, then the router\'s queries in 5-minute points to 10 minutes ago', async () => {
    const g = google();
    const read = await googleActivityStep(g.call as never, { project: PROJECT, backends: CASES[1]![1], settings: CASES[1]![2] as never, days: 1, now: NOW });
    expect(g.calls[0]).toBe(`POST https://compute.googleapis.com/compute/v1/projects/${PROJECT}/zones/${ZONE}/instanceGroupManagers/workers/listManagedInstances`);
    expect([read.from, read.to]).toEqual(['2026-11-20T11:55:00.000Z', '2026-11-21T11:55:00.000Z']);
    expect(Object.keys(read.points).sort()).toEqual(['cpu_0:workers-a1', 'cpu_0:workers-b2', 'rx_0:workers-a1', 'rx_0:workers-b2', 'tx_0:workers-a1', 'tx_0:workers-b2']);
    expect(read.signals.map((s) => [s.signal, s.applies])).toEqual([['cpu', true], ['network', true], ['metric', false]]);
  });
});

const GCP = resolve(import.meta.dirname, '../../../../router/gcp/src/idle-signals.mjs');
const router = (existsSync(GCP) ? await import(/* @vite-ignore */ GCP) : null) as { createIdleSignals(d: unknown): (cfg: unknown, b: unknown[], w: { startMs: number; endMs: number }) => Promise<{ signal: string; applies: boolean; value: number | null }[]> } | null;
describe.skipIf(!router)('the Google Cloud activity against the router\'s idle signals', () => {
  it.each(CASES)('%s: the same value at each point', async (_name, backends, settings, routerBackends) => {
    const g = google();
    const read = await googleActivityStep(g.call as never, { project: PROJECT, backends, settings: settings as never, days: 1, now: NOW });
    const values = signalValues(read.signals, read);
    const idleSignals = router!.createIdleSignals({ google: { request: g.call }, project: PROJECT, log: { warn() {} } });
    const from = Date.parse(read.from);
    let compared = 0;
    for (let p = 0; p < 288; p += 1) {
      const window = { startMs: from + p * POINT, endMs: from + (p + 1) * POINT };
      const theirs = (await idleSignals({ workloadId: 'w', idleMinutes: 5, ...settings }, routerBackends, window)).filter((s) => s.applies);
      expect(values.map((v) => v.signal)).toEqual(theirs.map((s) => s.signal));
      theirs.forEach((s, i) => {
        const ours = values[i]!.values[p]!;
        if (s.value === null) expect(ours, `${s.signal} at ${p}`).toBeNull();
        else expect(ours, `${s.signal} at ${p}`).toBeCloseTo(s.value, 9);
        compared += 1;
      });
    }
    expect(compared).toBeGreaterThan(200);
  });
});
