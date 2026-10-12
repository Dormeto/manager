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

function setup({ entries = [entry('ASLEEP', NOW - 3_600_000, { cause: 'idle' }), entry('WAKING', NOW - 600_000, { cause: 'normal' }), entry('AWAKE', NOW - 560_000, { durationMs: 40_000 })], truncated = false, before = entry('AWAKE', NOW - 90_000_000) as unknown, summary = null as unknown, savingsSummary = null as unknown, pricesFail = false } = {}) {
  const asked: unknown[][] = [];
  const calls: string[] = [];
  const api = createApi({
    routers: ROUTERS, now: () => NOW, version: '0.6.0', managerAccount: ACCOUNT,
    audit: { write: async () => {}, list: async () => [] },
    invoke: async (_r, payload) => { calls.push(payload.action as string); return null; },
    visible: (_identity, item) => item.account !== '038606077307',
    fleet: {
      listRouters: async () => [], listWorkloads: async () => [], getWorkload: async () => summary as never,
      listHistory: async (...args: unknown[]) => { asked.push(['list', ...args]); return { entries: entries as never, truncated }; },
      historyBefore: async (...args: unknown[]) => { asked.push(['before', ...args]); return before as never; },
      getSavingsSummary: async () => savingsSummary as never,
    },
    savings: { baseline: { kind: 'always' }, hourly: async (region: string, item: { kind: string }) => { if (pricesFail) throw new Error('DynamoDB unavailable'); return region === 'eu-west-1' && item.kind === 'ec2' ? 0.0456 : null; } },
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

  it('a capped period starts unknown before its oldest kept entry, not in the state before the period (review I2)', async () => {
    const { api } = setup({ truncated: true });
    const body = json(await api(event('/api/workloads/dmt-dev/a/history', { days: '1' })));
    expect(body.phases[0].state).toBe('UNKNOWN');
    expect(body.before).toBeNull();
  });

  it('a workload in one state for longer than the history keeps it: the summary says so (review I3)', async () => {
    const asleep = { account: ACCOUNT, region: 'eu-west-1', router: 'dmt-dev', workloadId: 'a', state: 'ASLEEP', historySince: iso(NOW - 900 * 86_400_000) };
    const quiet = setup({ entries: [], before: null, summary: asleep });
    expect(json(await quiet.api(event('/api/workloads/dmt-dev/a/history'))).phases.map((p: { state: string }) => p.state)).toEqual(['ASLEEP']);
    const woke = setup({ entries: [entry('WAKING', NOW - 600_000, { from: 'ASLEEP', cause: 'normal' })], before: null, summary: { ...asleep, state: 'WAKING' } });
    expect(json(await woke.api(event('/api/workloads/dmt-dev/a/history'))).phases.map((p: { state: string }) => p.state)).toEqual(['ASLEEP', 'WAKING']);
    const recent = setup({ entries: [], before: null, summary: { ...asleep, historySince: iso(NOW - 3_600_000) } });
    expect(json(await recent.api(event('/api/workloads/dmt-dev/a/history'))).phases[0].state).toBe('UNKNOWN');
  });

  it('estimates the period\'s savings from what each nap stopped (R9)', async () => {
    const stopped = [{ kind: 'ec2', type: 't3.medium', count: 1, os: 'Linux' }];
    const { api } = setup({ entries: [entry('ASLEEP', NOW - 3_600_000, { cause: 'idle', stopped }), entry('WAKING', NOW - 600_000, { cause: 'normal' })] });
    const body = json(await api(event('/api/workloads/dmt-dev/a/history', { days: '1' })));
    expect(body.savings.usd).toBeCloseTo((3_000 / 3_600) * 0.0456, 6);
    expect(body.savings.items[0].hourly).toBe(0.0456);
    expect(body.savings.baseline).toEqual({ kind: 'always' });
  });

  it('answers the savings summary the daily job wrote, for viewers; none yet before its first run (R9)', async () => {
    const summary = { day: '2026-10-07', last30: { usd: 12.5, asleepHours: 300, days: [] } };
    // No discounts item in this manager: no settings (R9.5).
    expect(json(await setup({ savingsSummary: summary }).api(event('/api/savings')))).toEqual({ summary, settings: null });
    expect(json(await setup().api(event('/api/savings')))).toEqual({ summary: null, settings: null });
  });

  it('answers the history without savings when they cannot be computed (review I4)', async () => {
    const stopped = [{ kind: 'ec2', type: 't3.medium', count: 1, os: 'Linux' }];
    const res = await setup({ entries: [entry('ASLEEP', NOW - 3_600_000, { stopped })], pricesFail: true }).api(event('/api/workloads/dmt-dev/a/history', { days: '1' }));
    expect(res.statusCode).toBe(200);
    expect(json(res).savings).toBeUndefined();
    expect(json(res).phases.length).toBeGreaterThan(0);
  });
});

