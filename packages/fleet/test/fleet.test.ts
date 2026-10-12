// Routers and their workloads as they report (scale design §4): summaries written from the router events.
import { describe, expect, it } from 'vitest';
import { fakeDynamo } from '../../discovery/test/dynamo-fake.js';
import { createFleetStore, reporting, type RouterEvent } from '../src/index.js';
import { createIngest } from '../src/ingest.js';

const ACCOUNT = '121014831971';
const REGION = 'eu-west-3';
const T1 = '2026-10-05T12:00:00.000Z';
const T2 = '2026-10-05T12:05:00.000Z';
const at = (base: string, seconds: number) => new Date(Date.parse(base) + seconds * 1000).toISOString();

const workload = (id: string, state = 'AWAKE', over: Record<string, unknown> = {}) => ({ workloadId: id, name: `Name ${id}`, state, targetGroupArn: `arn:tg/${id}`, url: null, ...over });
const checked = (checkedAt: string, workloads: ReturnType<typeof workload>[], chunk = { index: 0, total: 1 }, account = ACCOUNT): RouterEvent => ({
  account, region: REGION, 'detail-type': 'Router checked',
  detail: {
    router: { name: 'dmtr-dev', version: '0.21.0', build: 'abc', checkSchedule: 'rate(5 minutes)' },
    checkedAt, durationMs: 1200, health: { status: 'ok', problems: [] }, pauses: [], counts: { AWAKE: workloads.length }, chunk, workloads,
  },
});
const stateChanged = (workloadId: string, from: string, to: string, when: string): RouterEvent => ({
  account: ACCOUNT, region: REGION, 'detail-type': 'Workload state changed', detail: { router: 'dmtr-dev', workloadId, from, to, at: when },
});

function setup() {
  const dynamo = fakeDynamo();
  const store = createFleetStore({ dynamo, table: 'dmt-dev-manager' });
  const ingest = createIngest({ store });
  const ids = async () => (await store.listWorkloads()).map((w) => w.workloadId).sort();
  return { dynamo, store, ingest, ids };
}

describe('fleet', () => {
  it('a checked router writes its summary and its workloads, and removes those it no longer lists', async () => {
    const s = setup();
    await s.ingest(checked(T1, [workload('a'), workload('b')]));
    const [router] = await s.store.listRouters();
    expect([router!.account, router!.region, router!.name, router!.version, router!.checkedAt, router!.counts]).toEqual([ACCOUNT, REGION, 'dmtr-dev', '0.21.0', T1, { AWAKE: 2 }]);
    const workloads = await s.store.listWorkloads();
    expect(workloads.map((w) => [w.account, w.region, w.router, w.workloadId, w.name, w.targetGroupArn])).toEqual([
      [ACCOUNT, REGION, 'dmtr-dev', 'a', 'Name a', 'arn:tg/a'], [ACCOUNT, REGION, 'dmtr-dev', 'b', 'Name b', 'arn:tg/b'],
    ]);
    await s.ingest(checked(T2, [workload('a')]));
    expect(await s.ids()).toEqual(['a']);
  });

  it('assembles the chunks of one check, whatever their order, before removing anything', async () => {
    const s = setup();
    await s.ingest(checked(T1, [workload('a'), workload('b'), workload('c')]));
    await s.ingest(checked(T2, [workload('d')], { index: 2, total: 3 }));
    await s.ingest(checked(T2, [workload('a')], { index: 0, total: 3 }));
    expect(await s.ids()).toEqual(['a', 'b', 'c', 'd']);
    await s.ingest(checked(T2, [workload('b')], { index: 1, total: 3 }));
    expect(await s.ids()).toEqual(['a', 'b', 'd']);
  });

  it('ignores a chunk of a check older than the last one', async () => {
    const s = setup();
    await s.ingest(checked(T2, [workload('a')]));
    await s.ingest(checked(T1, [workload('z')]));
    expect(await s.ids()).toEqual(['a']);
    expect((await s.store.listRouters())[0]!.checkedAt).toBe(T2);
  });

  it('applies a state change at once; a check older than it keeps the newer state; an older state change is ignored', async () => {
    const s = setup();
    await s.ingest(checked(T1, [workload('a')]));
    await s.ingest(stateChanged('a', 'AWAKE', 'NAPPING', at(T1, 10)));
    expect((await s.store.listWorkloads())[0]!.state).toBe('NAPPING');
    // A check started before the change, reported after it.
    await s.ingest(checked(at(T1, 5), [workload('a', 'AWAKE', { name: 'Renamed' })]));
    const [a] = await s.store.listWorkloads();
    expect([a!.state, a!.name]).toEqual(['NAPPING', 'Renamed']);
    await s.ingest(stateChanged('a', 'AWAKE', 'NAPPING', at(T1, 3)));
    await s.ingest(stateChanged('a', 'NAPPING', 'ASLEEP', at(T1, 60)));
    await s.ingest(stateChanged('a', 'AWAKE', 'NAPPING', at(T1, 30)));
    expect((await s.store.listWorkloads())[0]!.state).toBe('ASLEEP');
  });

  it('a state change of a workload not reported yet creates it; the next check that does not list it removes it', async () => {
    const s = setup();
    await s.ingest(checked(T1, [workload('a')]));
    await s.ingest(stateChanged('new', 'AWAKE', 'NAPPING', at(T1, 10)));
    expect(await s.ids()).toEqual(['a', 'new']);
    await s.ingest(checked(T2, [workload('a')]));
    expect(await s.ids()).toEqual(['a']);
  });

  it('identifies a router by the envelope: the same name in another account is another router', async () => {
    const s = setup();
    await s.ingest(checked(T1, [workload('a')]));
    await s.ingest(checked(T1, [workload('a')], { index: 0, total: 1 }, '038606077307'));
    expect((await s.store.listRouters()).map((r) => r.account).sort()).toEqual(['038606077307', ACCOUNT]);
    expect((await s.store.listWorkloads()).map((w) => w.account).sort()).toEqual(['038606077307', ACCOUNT]);
  });

  it('tells a router not reporting: its last check older than 3 periods of its schedule', () => {
    const now = Date.parse(T2);
    expect(reporting({ checkedAt: at(T2, -14 * 60), checkSchedule: 'rate(5 minutes)' }, now)).toBe(true);
    expect(reporting({ checkedAt: at(T2, -16 * 60), checkSchedule: 'rate(5 minutes)' }, now)).toBe(false);
    expect(reporting({ checkedAt: at(T2, -2 * 3600), checkSchedule: 'rate(1 hour)' }, now)).toBe(true);
    expect(reporting({ checkedAt: null, checkSchedule: 'rate(5 minutes)' }, now)).toBe(false);
  });
});
