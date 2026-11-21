// The demo's standalone workloads and candidates (vision standalone workloads design §6): every new view has something to
// show, in the shapes the manager answers (task-M45-report.md).
import { describe, expect, it } from 'vitest';
import { mockApi } from '../src/mock';
import { decide, state } from '../src/mock/state';
import type { WorkloadStatus, WorkloadSummary } from '../src/types';

describe('the demo\'s standalone workloads', () => {
  it('has one of each kind of resource, awake, asleep by its schedule and on idle, failed, and one without its resource', async () => {
    const { workloads } = await mockApi('/workloads?kind=standalone&limit=100') as { workloads: WorkloadSummary[] };
    expect(workloads.map((w) => [w.name, w.state, w.kind, w.resourceMissing ?? false])).toEqual(expect.arrayContaining([
      ['build-agent', 'AWAKE', 'standalone', false], ['batch-workers', 'ASLEEP', 'standalone', false], ['queue-worker', 'ASLEEP', 'standalone', false],
      ['reports-db', 'FAILED', 'standalone', false], ['analytics', 'AWAKE', 'standalone', true],
    ]));
    for (const w of workloads) {
      for (const key of ['url', 'wakeMode', 'targetGroupArn']) expect(w, `${w.name} ${key}`).not.toHaveProperty(key);
      expect(Object.keys(w.settings).sort()).toEqual(['idleCpuPercent', 'idleMetric', 'idleMinutes', 'idleNetworkBytes', 'wakeTimeoutSeconds']);
    }
    const http = (await mockApi('/workloads?kind=http&limit=1000') as { workloads: WorkloadSummary[] }).workloads;
    expect(http.length).toBeGreaterThan(0);
    expect(http.every((w) => !('kind' in w))).toBe(true);
  });

  it('answers a standalone workload\'s status with its signals, nap estimate and backends, and nothing of a route', async () => {
    const d = state();
    const agent = d.workloads.find((w) => w.name === 'build-agent')!;
    const status = await mockApi(`/workloads/${agent.router}/${agent.workloadId}`) as WorkloadStatus;
    expect(status).toMatchObject({ kind: 'standalone', state: 'AWAKE' });
    expect(status.idle!.map((s) => s.signal)).toEqual(['cpu', 'network', 'metric']);
    for (const key of ['url', 'route', 'rules', 'targets', 'ipLists', 'wakeMode', 'wakeRules', 'noWakeRules']) expect(status, key).not.toHaveProperty(key);
    const analytics = d.workloads.find((w) => w.name === 'analytics')!;
    expect(await mockApi(`/workloads/${analytics.router}/${analytics.workloadId}`)).toMatchObject({ resourceMissing: true, backends: [] });
  });

  it('lists standalone candidates to onboard and one of each family the router refuses, with the perimeter\'s scan on', async () => {
    const d = state();
    expect(d.config.config.standalone).toBe('on');
    const standalone = d.candidates.filter((c) => (c as { kind?: string }).kind === 'standalone');
    expect(standalone.filter((c) => c.status === 'pending-onboarding').length).toBeGreaterThanOrEqual(3);
    expect(standalone.filter((c) => c.status === 'managed').length).toBe(5);
    const reasons = standalone.filter((c) => c.status === 'ineligible').map((c) => c.reason!.split(': ')[0]!.replace(/^\S+ \S+ /, '').replace(/^(group |service |instance |cluster )\S+ /, ''));
    expect(reasons.length).toBe(9);
    const { candidates } = await mockApi('/discovery/candidates?status=ineligible&kind=standalone&limit=200') as { candidates: { kind?: string }[] };
    expect(candidates.length).toBe(9);
    expect(candidates.every((c) => c.kind === 'standalone')).toBe(true);
    const gone = decide(d, { ...standalone.find((c) => c.status === 'managed')!, goneAt: new Date().toISOString() }, Date.now());
    expect(gone.statusReason).toBe('managed resource not found in the last scan: offboard it');
  });
});
