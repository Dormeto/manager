// Google Cloud standalone workloads in the fleet (plan 5, M51): a Google Cloud router's standalone row kept as the router sends it
// (its kind, its resource path, its missing resource, its five settings with Google Cloud's idleMetric), its HTTP rows unchanged;
// the organization's settings pushed to a Google Cloud router with the idle signals once its version knows them, never before.
import { describe, expect, it } from 'vitest';
import { workloadOf } from '../src/clean.js';
import { knowsIdleSignals, STANDALONE_ROUTERS } from '../src/idle-signals.js';
import { settingsDocument } from '../src/settings-json.js';

const RESOURCE = 'projects/dormeto-dev/zones/europe-west1-b/instances/build-agent';
const GCP_METRIC = { type: 'custom.googleapis.com/queue/depth', filter: 'resource.labels.instance_id = "${resource}"', aligner: 'ALIGN_MAX', below: 1 };
// The router's row keys (the Plan 5 router handover, "Row"), in their order.
const ROW = {
  workloadId: 'build-agent', name: 'Build agent', kind: 'standalone', resource: RESOURCE, source: 'manager', tags: { team: 'ci' }, state: 'FAILED', stateAt: '2026-11-21T10:00:00.000Z',
  wakeCount: 2, awakeSince: null, wakeStartedAt: null, failedAt: '2026-11-21T10:00:00.000Z',
  failure: { kind: 'permission', step: 'wake', message: 'VM build-agent: Google refused the change: the router may change only a resource with the tag dormeto=managed: denied', at: '2026-11-21T10:00:00.000Z' },
  consecutiveFailures: 3, nextAttemptAt: '2026-11-21T10:30:00.000Z', updatedAt: '2026-11-21T10:00:00.000Z', pendingWake: false,
  backends: [{ kind: 'vm', location: 'europe-west1-b', name: 'build-agent', id: '4471' }], resourceMissing: true, pauses: [], stats7d: { wakes: 4 }, type: 'instance',
  settingsFrom: { idleMinutes: 'default', wakeTimeoutSeconds: 'default', idleCpuPercent: 'type', idleNetworkBytes: 'workload', idleMetric: 'workload' },
  settings: { idleMinutes: 120, wakeTimeoutSeconds: 600, idleCpuPercent: 'off', idleNetworkBytes: 1000, idleMetric: GCP_METRIC },
};

describe('a Google Cloud standalone workload\'s row', () => {
  it('keeps its kind, its resource path, its missing resource, its failure and its five settings with Google Cloud\'s metric', () => {
    const row = workloadOf(ROW, 'gcp')!;
    expect(row).toMatchObject({
      workloadId: 'build-agent', name: 'Build agent', kind: 'standalone', resource: RESOURCE, resourceMissing: true, state: 'FAILED', stats7d: { wakes: 4 },
      failure: { kind: 'permission' }, settings: ROW.settings, settingsFrom: ROW.settingsFrom, type: 'instance',
    });
    for (const key of ['url', 'wakeMode', 'targetGroupArn', 'resourceArn', 'backendService', 'urlMap', 'lb', 'wakerBackendService']) expect(row, key).not.toHaveProperty(key);
    expect(Object.keys(row).slice(0, 4)).toEqual(['workloadId', 'name', 'kind', 'resource']);
  });

  it('drops a resource that is no path of its kinds, and an AWS-shaped metric', () => {
    const row = workloadOf({ ...ROW, resource: 'arn:aws:ec2:eu-west-1:1:instance/i-1', settings: { ...ROW.settings, idleMetric: { namespace: 'A', name: 'B', dimensions: {}, statistic: 'Maximum', below: 1 } } }, 'gcp')!;
    expect([row.resource, (row.settings as Record<string, unknown>).idleMetric]).toEqual([undefined, undefined]);
  });
});

describe('the organization\'s settings pushed to a Google Cloud router', () => {
  const DOC = { workloads: { defaults: { idleMinutes: 30, idleCpuPercent: 3, idleMetric: GCP_METRIC }, types: [{ name: 'api', settings: { waitSeconds: 20, idleNetworkBytes: 'off' } }] } };
  const read = { read: async () => ({ etag: '"e1"', text: JSON.stringify(DOC) }) };
  it('carry the idle signals to a router whose version knows them, never before or to one of unknown version', async () => {
    expect(STANDALONE_ROUTERS.gcp).toBe('0.42.0');
    expect(await settingsDocument(read, { version: '0.42.0' })).toEqual({ etag: '"e1"', settings: DOC });
    expect(await settingsDocument(read, { version: '0.42.1-dev.2' })).toEqual({ etag: '"e1"', settings: DOC });
    const stripped = { workloads: { defaults: { idleMinutes: 30 }, types: [{ name: 'api', settings: { waitSeconds: 20 } }] } };
    for (const version of ['0.41.9', null, '', 'dev']) expect(await settingsDocument(read, { version }), String(version)).toEqual({ etag: '"e1"', settings: stripped });
    expect(await settingsDocument(read)).toEqual({ etag: '"e1"', settings: stripped });
  });

  it('knowsIdleSignals by each cloud\'s first version', () => {
    expect([knowsIdleSignals('aws', '0.42.0'), knowsIdleSignals('aws', '0.41.0'), knowsIdleSignals('gcp', '0.42.0'), knowsIdleSignals('gcp', '0.40.3'), knowsIdleSignals('gcp', null)]).toEqual([true, false, true, false, false]);
  });
});
