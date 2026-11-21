// A standalone workload's Activity history (vision standalone workloads design §6, §7): GET /workloads/{router}/{id}/activity
// reads its signals over 7 days through the discovery function (the queries from its status, as the router reads them),
// each signal's 5-minute values, the hours asleep from its history, and the idle window advice replayed from 5 minutes to
// 24 hours, kept a day; a failed read is a 502, never an idle week.
import { describe, expect, it } from 'vitest';
import type { HistoryEntry } from '@dormeto/fleet';
import { createApi, type ApiEvent } from '../src/api.js';
import type { IdleActivity } from '../src/idle-requests.js';

const NOW = Date.UTC(2026, 10, 21, 12, 7);
const MANAGER = '121014831971';
const TO = Date.UTC(2026, 10, 21, 11, 55);
const FROM = TO - 7 * 86_400_000;
const ARN = `arn:aws:ec2:eu-west-1:${MANAGER}:instance/i-1`;
const STATUS = {
  workloadId: 'sa', name: 'build-agent', kind: 'standalone', resourceArn: ARN, state: 'AWAKE', backends: [{ kind: 'instance', id: 'i-1', status: 'running' }],
  settings: { idleMinutes: 120, wakeTimeoutSeconds: 600, idleCpuPercent: 5, idleNetworkBytes: 'off', idleMetric: 'off' },
  settingsFrom: { idleMinutes: 'default', wakeTimeoutSeconds: 'default', idleCpuPercent: 'type', idleNetworkBytes: 'default', idleMetric: 'default' },
};
// Busy an hour a day at 09:00 UTC, idle otherwise.
const cpu = (minute: number) => (((FROM / 60_000 + minute) % 1440) >= 540 && ((FROM / 60_000 + minute) % 1440) < 600 ? 80 : 1);
const POINTS: [number, number][] = Array.from({ length: 7 * 288 }, (_, p) => [p * 5, cpu(p * 5)]);

function setup({ read, status = STATUS, history = [] as HistoryEntry[] }: { read?: IdleActivity; status?: unknown; history?: HistoryEntry[] } = {}) {
  const asked: unknown[] = [];
  const kept = new Map<string, unknown>();
  const api = createApi({
    routers: [{ name: 'dmt-dev', region: 'eu-west-1', controller: 'c', account: MANAGER }], now: () => NOW, newId: () => 'x', version: '0.25.0', managerAccount: MANAGER,
    audit: { write: async () => {}, list: async () => [] },
    async invoke(_r, payload) { return payload.action === 'status' ? structuredClone(status) : null; },
    fleet: {
      listRouters: async () => [], listWorkloads: async () => [] as never, getWorkload: async () => ({ account: MANAGER, region: 'eu-west-1', router: 'dmt-dev', workloadId: 'sa', kind: 'standalone', state: 'AWAKE', historySince: new Date(FROM - 86_400_000).toISOString() }) as never,
      listHistory: async () => ({ entries: history, truncated: false }), historyBefore: async () => ({ account: MANAGER, region: 'eu-west-1', workloadId: 'sa', at: new Date(FROM - 3_600_000).toISOString(), from: 'WAKING', to: 'AWAKE' }) as never,
      getActivity: async (_a: string, _r: string, id: string) => kept.get(id) ?? null, putActivity: async (_a: string, _r: string, id: string, value: unknown) => { kept.set(id, value); },
    } as never,
    idleActivity: read ?? (async (account, region, queries, days) => { asked.push({ account, region, queries, days }); return { from: new Date(FROM).toISOString(), to: new Date(TO).toISOString(), points: { cpu_0: POINTS } }; }),
  });
  return { api, asked, kept };
}
const get = (path: string): ApiEvent => ({ rawPath: path, requestContext: { http: { method: 'GET' }, authorizer: { jwt: { claims: { sub: 'u', email: 'v@example.com', 'cognito:groups': '[dmt-viewer]' } } } } });
const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');

describe('a standalone workload\'s activity', () => {
  it('reads its signals with the router\'s queries, and answers each signal\'s values, the hours asleep and the advice from 5 minutes to 24 hours', async () => {
    const s = setup();
    const res = await s.api(get('/api/workloads/dmt-dev/sa/activity'));
    expect(res.statusCode).toBe(200);
    expect(s.asked).toEqual([{ account: MANAGER, region: 'eu-west-1', days: 7, queries: [{ id: 'cpu_0', namespace: 'AWS/EC2', name: 'CPUUtilization', dimensions: [{ Name: 'InstanceId', Value: 'i-1' }], stat: 'Maximum' }] }]);
    const a = json(res);
    expect([a.from, a.to]).toEqual([new Date(FROM).toISOString(), new Date(TO).toISOString()]);
    expect(a.signals.map((x: { signal: string; below: number | null; applies: boolean; from: string }) => [x.signal, x.below, x.applies, x.from])).toEqual([['cpu', 5, true, 'type'], ['network', null, false, 'default'], ['metric', null, false, 'default']]);
    expect(a.signals[0].values).toHaveLength(7 * 288);
    expect(a.signals[0].values.slice(253, 255)).toEqual([80, 80]);
    expect(a.advice.windows.map((w: { minutes: number }) => w.minutes)).toEqual([5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720, 1440]);
    expect(a.advice.current).toBe(120);
    expect(a.advice.windows.find((w: { minutes: number }) => w.minutes === 120).wakesPerDay).toBeCloseTo(1, 0);
    expect(a.advice.windows.find((w: { minutes: number }) => w.minutes === 1440).wakesPerDay).toBe(0);
    expect(a.asleep).toEqual([]);
  });

  it('keeps it a day, until its settings change', async () => {
    const s = setup();
    await s.api(get('/api/workloads/dmt-dev/sa/activity'));
    await s.api(get('/api/workloads/dmt-dev/sa/activity'));
    expect(s.asked).toHaveLength(1);
  });

  it('answers a failed read as such, never an idle week', async () => {
    const s = setup({ read: async () => { throw new Error('CloudWatch could not read the metrics (Forbidden: not authorized)'); } });
    const res = await s.api(get('/api/workloads/dmt-dev/sa/activity'));
    expect([res.statusCode, json(res)]).toEqual([502, { error: 'metrics_unreadable', message: 'the metrics could not be read: CloudWatch could not read the metrics (Forbidden: not authorized)' }]);
  });

  it('reads nothing when no signal applies, and has none for an HTTP workload', async () => {
    const off = setup({ status: { ...STATUS, settings: { ...STATUS.settings, idleCpuPercent: 'off' } } });
    const a = json(await off.api(get('/api/workloads/dmt-dev/sa/activity')));
    expect([off.asked, a.advice, a.reason]).toEqual([[], null, 'no idle signal applies: it naps on its schedule and on people\'s word only']);
    const http = setup({ status: { workloadId: 'web', state: 'AWAKE', route: 'app' } });
    const res = await http.api(get('/api/workloads/dmt-dev/web/activity'));
    expect([res.statusCode, json(res).message]).toEqual([404, 'workload web is an HTTP workload: its requests are on its idle window card']);
  });
});
