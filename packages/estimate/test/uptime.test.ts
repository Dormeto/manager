// The measured uptime of EC2 instances without an Auto Scaling group (spec §5, --ec2-uptime): when each ran over the
// requests' 14 days, from its CPUUtilization (EC2 publishes it every 5 minutes while an instance runs, nothing while it
// is stopped), twenty instances per GetMetricData call, kept per account and region the same UTC day.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCache } from '../src/cache.js';
import type { RegionDiscovery, Workload } from '../src/discover.js';
import type { CloudWatchPort, RegionRequests } from '../src/requests.js';
import { readUptime, uptimeAll } from '../src/uptime.js';

const A = '111111111111';
const R = 'eu-west-1';
const NOW = Date.parse('2026-10-10T12:00:30.000Z');
const TO = '2026-10-10T12:00:00.000Z';
const FROM = '2026-09-26T12:00:00.000Z';
const minute = (m: number) => new Date(Date.parse(FROM) + m * 60_000);
type Result = { Id?: string; Timestamps?: Date[]; Values?: number[]; StatusCode?: string; Messages?: { Code?: string; Value?: string }[] };
// Every 5 minutes from one minute offset to another (end excluded).
const every5 = (from: number, to: number) => Array.from({ length: (to - from) / 5 }, (_, k) => minute(from + k * 5));
// 08:00 to 20:00 UTC each day: the period starts at 12:00, so 20:00 is minute 480, the next 08:00 minute 1200.
const DAYTIME = Array.from({ length: 14 }, (_, d) => [d * 1440 - 240, d * 1440 + 480] as [number, number]).map(([a, b]) => [Math.max(0, a), b] as [number, number]);

function cloudwatch(answer: (instance: string) => Result) {
  const calls: { instances: string[]; input: Parameters<CloudWatchPort['getMetricData']>[0] }[] = [];
  const port: CloudWatchPort = {
    getMetricData: async (input) => {
      const instances = input.MetricDataQueries.map((q) => q.MetricStat.Metric.Dimensions.find((d) => d.Name === 'InstanceId')!.Value);
      calls.push({ instances, input });
      return { MetricDataResults: input.MetricDataQueries.map((q, k) => ({ Id: q.Id, ...answer(instances[k]!) })) };
    },
  };
  return { port, calls };
}

describe('the measured uptime of EC2 instances', () => {
  it('each instance\'s running periods, in minutes of the period, from its 5-minute CPUUtilization; none for one that never ran', async () => {
    const { port, calls } = cloudwatch((instance) => (instance === 'i-day'
      ? { Timestamps: DAYTIME.flatMap(([a, b]) => every5(a, b)), Values: DAYTIME.flatMap(([a, b]) => every5(a, b).map(() => 1)), StatusCode: 'Complete' }
      : { Timestamps: [], Values: [], StatusCode: 'Complete' }));
    const read = await readUptime(port, ['i-day', 'i-off'], { from: FROM, to: TO });
    expect(read.running['i-day']).toEqual(DAYTIME);
    expect(read.running['i-off']).toEqual([]);
    expect(read.unreadable).toEqual({});
    expect(calls[0]!.input).toMatchObject({ StartTime: new Date(FROM), EndTime: new Date(TO), ScanBy: 'TimestampAscending' });
    expect(calls[0]!.input.MetricDataQueries[0]!.MetricStat).toEqual({
      Metric: { Namespace: 'AWS/EC2', MetricName: 'CPUUtilization', Dimensions: [{ Name: 'InstanceId', Value: 'i-day' }] }, Period: 300, Stat: 'SampleCount',
    });
  });

  it('a gap of one missing datapoint is a stop; datapoints out of order are sorted', async () => {
    const stamps = [...every5(0, 30), ...every5(35, 60)].reverse();
    const { port } = cloudwatch(() => ({ Timestamps: stamps, Values: stamps.map(() => 1), StatusCode: 'Complete' }));
    expect((await readUptime(port, ['i-1'], { from: FROM, to: TO })).running['i-1']).toEqual([[0, 30], [35, 60]]);
  });

  it('twenty instances per call; an instance CloudWatch could not read is unreadable, never stopped', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `i-${i}`);
    const { port, calls } = cloudwatch((instance) => (instance === 'i-3' ? { StatusCode: 'Forbidden', Messages: [{ Value: 'denied' }] } : { Timestamps: [], Values: [], StatusCode: 'Complete' }));
    const read = await readUptime(port, ids, { from: FROM, to: TO });
    expect(calls.map((c) => c.instances.length)).toEqual([20, 5]);
    expect(read.unreadable).toEqual({ 'i-3': 'CloudWatch could not read the uptime (Forbidden: denied)' });
    expect('i-3' in read.running).toBe(false);
  });
});

describe('the measured uptime of ECS services', () => {
  // ECS publishes a service's CPUUtilization every minute while it has a task, nothing at 0 tasks (read on dev's demo).
  it('each service\'s running periods from its CPUUtilization by cluster and service; an old ARN names the default cluster', async () => {
    const asked: { Name: string; Value: string }[][] = [];
    const port: CloudWatchPort = {
      getMetricData: async (input) => {
        asked.push(...input.MetricDataQueries.map((q) => q.MetricStat.Metric.Dimensions));
        return { MetricDataResults: input.MetricDataQueries.map((q) => ({ Id: q.Id, Timestamps: every5(0, 60), Values: every5(0, 60).map(() => 5), StatusCode: 'Complete' })) };
      },
    };
    const api = `arn:aws:ecs:${R}:${A}:service/prod/api`;
    const old = `arn:aws:ecs:${R}:${A}:service/legacy`;
    const read = await readUptime(port, [api, old, 'i-web'], { from: FROM, to: TO });
    expect(read.running).toEqual({ [api]: [[0, 60]], [old]: [[0, 60]], 'i-web': [[0, 60]] });
    expect(asked).toEqual([
      [{ Name: 'ClusterName', Value: 'prod' }, { Name: 'ServiceName', Value: 'api' }],
      [{ Name: 'ClusterName', Value: 'default' }, { Name: 'ServiceName', Value: 'legacy' }],
      [{ Name: 'InstanceId', Value: 'i-web' }],
    ]);
  });
});

describe('the uptime of every region', () => {
  const w = (name: string, over: Partial<Workload> = {}): Workload => ({
    account: A, region: R, loadBalancer: 'web', loadBalancerArn: 'arn:lb', targetGroup: name, targetGroupArn: `arn:tg/${name}`, hosts: [],
    backend: { kind: 'instance', id: `i-${name}` }, stopped: [], tags: {}, instanceState: 'running', ...over,
  });
  const regions: RegionDiscovery[] = [{
    account: A, region: R, ineligible: [],
    workloads: [w('web'), w('napped', { managed: true, instanceState: undefined }), w('fleet', { backend: { kind: 'asg', id: 'fleet' }, instanceState: undefined }), w('night', { instanceState: 'stopped' })],
  }];
  const requests: RegionRequests[] = [{ account: A, region: R, from: FROM, to: TO, minutes: {}, unreadable: {} }];

  it('the instances without an Auto Scaling group Dormeto does not manage, over their region\'s requests period; kept the same day', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dormeto-estimate-'));
    const { port, calls } = cloudwatch(() => ({ Timestamps: [], Values: [], StatusCode: 'Complete' }));
    const run = (refresh: 'metrics' | null = null) => uptimeAll({ regions, requests, cloudwatchOf: async () => port, cache: createCache({ dir, now: () => NOW }), refresh, now: () => NOW });
    const [read] = await run();
    expect(calls[0]!.instances).toEqual(['i-web', 'i-night']);
    expect(read).toMatchObject({ account: A, region: R, from: FROM, to: TO, running: { 'i-web': [], 'i-night': [] } });
    await run();
    expect(calls).toHaveLength(1);
    await run('metrics');
    expect(calls).toHaveLength(2);
  });

  it('--ecs-uptime measures the ECS services Dormeto does not manage, --ec2-uptime the instances, both with --uptime', async () => {
    const api = `arn:aws:ecs:${R}:${A}:service/prod/api`;
    const withEcs: RegionDiscovery[] = [{ ...regions[0]!, workloads: [...regions[0]!.workloads, w('api', { backend: { kind: 'ecs', id: api }, instanceState: undefined, ecsDesired: 0 }), w('demo-ecs', { backend: { kind: 'ecs', id: `arn:aws:ecs:${R}:${A}:service/prod/demo` }, instanceState: undefined, managed: true })] }];
    const measured = async (kinds: { ec2: boolean; ecs: boolean }) => {
      const asked: string[] = [];
      const port: CloudWatchPort = { getMetricData: async (input) => {
        asked.push(...input.MetricDataQueries.map((q) => q.MetricStat.Metric.Dimensions.map((d) => d.Value).join('/')));
        return { MetricDataResults: input.MetricDataQueries.map((q) => ({ Id: q.Id, Timestamps: [], Values: [], StatusCode: 'Complete' })) };
      } };
      const dir = mkdtempSync(join(tmpdir(), 'dormeto-estimate-'));
      await uptimeAll({ regions: withEcs, requests, cloudwatchOf: async () => port, cache: createCache({ dir, now: () => NOW }), refresh: null, now: () => NOW, kinds });
      return asked;
    };
    expect(await measured({ ec2: false, ecs: true })).toEqual(['prod/api']);
    expect(await measured({ ec2: true, ecs: false })).toEqual(['i-web', 'i-night']);
    expect(await measured({ ec2: true, ecs: true })).toEqual(['i-web', 'i-night', 'prod/api']);
  });

  it('a region whose uptime cannot be read at all: its instances unreadable with AWS\'s reason, the run goes on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dormeto-estimate-'));
    const port: CloudWatchPort = { getMetricData: async () => { throw Object.assign(new Error('not authorized to perform: cloudwatch:GetMetricData'), { name: 'AccessDenied' }); } };
    const [read] = await uptimeAll({ regions, requests, cloudwatchOf: async () => port, cache: createCache({ dir, now: () => NOW }), refresh: null, now: () => NOW });
    expect(read!.unreadable).toEqual({ 'i-web': 'AccessDenied: not authorized to perform: cloudwatch:GetMetricData', 'i-night': 'AccessDenied: not authorized to perform: cloudwatch:GetMetricData' });
  });
});
