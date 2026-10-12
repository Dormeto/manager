// A workload's state history (R8): read from the manager's store, never from the router; viewers too.
import { describe, expect, it } from 'vitest';
import { createApi, type ApiEvent, type Router } from '../src/api.js';

const NOW = Date.parse('2026-10-08T12:00:00.000Z');
const ACCOUNT = '121014831971';
const ROUTERS: Router[] = [
  { name: 'dmt-dev', region: 'eu-west-1', controller: 'c1', account: ACCOUNT },
  { name: 'other', region: 'eu-west-3', controller: 'c3', account: '038606077307' },
];
const iso = (ms: number) => new Date(ms).toISOString();
const entry = (to: string, ms: number, extra: Record<string, unknown> = {}) => ({ account: ACCOUNT, region: 'eu-west-1', router: 'dmt-dev', workloadId: 'a', from: null, to, at: iso(ms), ...extra });

function setup({ entries = [entry('ASLEEP', NOW - 3_600_000, { cause: 'idle' }), entry('WAKING', NOW - 600_000, { cause: 'normal' }), entry('AWAKE', NOW - 560_000, { durationMs: 40_000 })], truncated = false } = {}) {
  const asked: unknown[][] = [];
  const calls: string[] = [];
  const api = createApi({
    routers: ROUTERS, now: () => NOW, version: '0.6.0', managerAccount: ACCOUNT,
    audit: { write: async () => {}, list: async () => [] },
    invoke: async (_r, payload) => { calls.push(payload.action as string); return null; },
    visible: (_identity, item) => item.account !== '038606077307',
    fleet: {
      listRouters: async () => [], listWorkloads: async () => [], getWorkload: async () => null,
      listHistory: async (...args: unknown[]) => { asked.push(['list', ...args]); return { entries: entries as never, truncated }; },
      historyBefore: async (...args: unknown[]) => { asked.push(['before', ...args]); return entry('AWAKE', NOW - 90_000_000) as never; },
    },
  });
  return { api, asked, calls };
}
const event = (path: string, query: Record<string, string> = {}): ApiEvent => ({
  rawPath: path, queryStringParameters: query, requestContext: { http: { method: 'GET' }, authorizer: { jwt: { claims: { email: 'v@example.com', sub: 'u1', 'cognito:groups': '[dmt-viewer]' } } } },
});
const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');

describe('workload history (R8)', () => {
  it('answers a period\'s entries, phases, totals and wakes from the store, for viewers, without calling the router', async () => {
    const { api, asked, calls } = setup();
    const res = await api(event('/api/workloads/dmt-dev/a/history', { days: '1' }));
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect([body.from, body.to]).toEqual([iso(NOW - 86_400_000), iso(NOW)]);
    expect(asked).toEqual([['list', ACCOUNT, 'eu-west-1', 'a', iso(NOW - 86_400_000), iso(NOW)], ['before', ACCOUNT, 'eu-west-1', 'a', iso(NOW - 86_400_000)]]);
    expect(body.phases.map((p: { state: string }) => p.state)).toEqual(['AWAKE', 'ASLEEP', 'WAKING', 'AWAKE']);
    expect(body.totals.ASLEEP).toBe(3_000);
    expect(body.wakes).toEqual({ count: 1, failed: 0, medianMs: 40_000, maxMs: 40_000 });
    expect(body.entries).toHaveLength(3);
    expect(body.before.to).toBe('AWAKE');
    expect(body.truncated).toBe(false);
    expect(calls).toEqual([]);
  });

  it('7 days by default, at most 31; a bad period, an unknown or an unseen router is refused', async () => {
    const { api, asked } = setup({ truncated: true });
    const res = await api(event('/api/workloads/dmt-dev/a/history'));
    expect(json(res).from).toBe(iso(NOW - 7 * 86_400_000));
    expect(json(res).truncated).toBe(true);
    for (const days of ['0', '32', 'x', '1.5']) expect((await api(event('/api/workloads/dmt-dev/a/history', { days }))).statusCode, days).toBe(400);
    expect((await api(event('/api/workloads/nope/a/history'))).statusCode).toBe(404);
    expect((await api(event('/api/workloads/other/a/history'))).statusCode).toBe(404);
    expect(asked.filter((a) => a[0] === 'list')).toHaveLength(1);
  });
});
