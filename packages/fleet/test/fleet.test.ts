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

// The manager's clock: every event of these tests is before it.
const NOW = Date.parse('2026-10-05T13:00:00.000Z');

function setup() {
  const dynamo = fakeDynamo();
  const store = createFleetStore({ dynamo, table: 'dmt-dev-manager', now: () => NOW });
  const refused: [string, object][] = [];
  const ingest = createIngest({ store, now: () => NOW, log: { warn: (event, data) => { refused.push([event, data]); } } });
  const ids = async () => (await store.listWorkloads()).map((w) => w.workloadId).sort();
  return { dynamo, store, ingest, ids, refused };
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

  // A store whose first read of a workload lets another event land before the read returns (two Lambdas at once).
  const racing = (s: ReturnType<typeof setup>, other: () => Promise<unknown>) => {
    let raced = false;
    const race = <A extends unknown[], R>(read: (...args: A) => Promise<R>) => async (...args: A) => {
      const value = await read(...args);
      if (!raced) {
        raced = true;
        await other();
      }
      return value;
    };
    const store = s.store as Record<string, any>;
    return createIngest({ store: { ...s.store, getWorkload: race(s.store.getWorkload), ...(store.readWorkload ? { readWorkload: race(store.readWorkload) } : {}) } as never, now: () => NOW });
  };

  it('a state change landing while a check writes the same workload is never overwritten by that check', async () => {
    const s = setup();
    await s.ingest(checked(T1, [workload('a')]));
    const ingest = racing(s, () => s.ingest(stateChanged('a', 'AWAKE', 'NAPPING', at(T2, 30))));
    await ingest(checked(T2, [workload('a', 'AWAKE', { name: 'Renamed' })]));
    expect(await s.store.getWorkload(ACCOUNT, REGION, 'a')).toMatchObject({ state: 'NAPPING', stateAt: at(T2, 30), name: 'Renamed' });
  });

  it('a chunk of an older check written after a newer check leaves the newer check\'s values', async () => {
    const s = setup();
    await s.ingest(checked(T1, [workload('a')]));
    const ingest = racing(s, () => s.ingest(checked(T2, [workload('a', 'AWAKE', { name: 'Newer' })])));
    await ingest(checked(at(T1, 60), [workload('a', 'AWAKE', { name: 'Older' })]));
    expect(await s.store.getWorkload(ACCOUNT, REGION, 'a')).toMatchObject({ name: 'Newer', checkedAt: T2 });
  });

  it('a workload changing state while the last chunk of a check removes the unlisted ones is kept', async () => {
    const s = setup();
    await s.ingest(checked(T1, [workload('a'), workload('b')]));
    let raced = false;
    const store = s.store as Record<string, any>;
    const routerWorkloads = async (account: string, region: string) => {
      const listed = await s.store.routerWorkloads(account, region);
      if (!raced) {
        raced = true;
        await s.ingest(stateChanged('b', 'AWAKE', 'NAPPING', at(T2, 30)));
      }
      return listed;
    };
    const ingest = createIngest({ store: { ...s.store, ...(store.readWorkload ? { readWorkload: store.readWorkload } : {}), routerWorkloads } as never, now: () => NOW });
    await ingest(checked(T2, [workload('a')]));
    expect(await s.ids()).toEqual(['a', 'b']);
  });

  it('summaries expire 7 days after their last write: those of a router uninstalled or gone leave the table', async () => {
    const s = setup();
    await s.ingest(checked(T1, [workload('a')]));
    await s.ingest(stateChanged('a', 'AWAKE', 'NAPPING', at(T1, 10)));
    const expires = Math.floor(NOW / 1000) + 7 * 86_400;
    const items = [...s.dynamo.items.values()].filter((i) => /^(RS|WS)#/.test(i.sk!.S!));
    expect(items.map((i) => [i.sk!.S, i.expiresAt?.N]).sort()).toEqual([[`RS#${ACCOUNT}#${REGION}`, String(expires)], [`WS#${ACCOUNT}#${REGION}#a`, String(expires)]]);
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

  it('takes the router\'s region from its event: publishing to the manager\'s region stamps the envelope with that region', async () => {
    const s = setup();
    // A router of eu-west-3 publishing to the bus in eu-west-1: the envelope says eu-west-1, the account is the caller's.
    const remote = checked(T1, [workload('p')]);
    remote.region = 'eu-west-1';
    remote.detail.router.region = 'eu-west-3';
    await s.ingest(remote);
    const local = checked(T1, [workload('l')]);
    local.region = 'eu-west-1';
    local.detail.router.region = 'eu-west-1';
    await s.ingest(local);
    expect((await s.store.listRouters()).map((r) => r.region).sort()).toEqual(['eu-west-1', 'eu-west-3']);
    expect((await s.store.listWorkloads()).map((w) => [w.region, w.workloadId]).sort()).toEqual([['eu-west-1', 'l'], ['eu-west-3', 'p']]);
    const state = stateChanged('p', 'AWAKE', 'NAPPING', at(T1, 10));
    state.region = 'eu-west-1';
    state.detail.region = 'eu-west-3';
    await s.ingest(state);
    expect((await s.store.listWorkloads()).find((w) => w.workloadId === 'p')!.state).toBe('NAPPING');
  });

  it('refuses a check or a state change dated ahead of the manager\'s clock, or not dated: one event never pins a summary', async () => {
    const s = setup();
    // Any principal of the organization may publish: a check dated in 2099 would win over every later one.
    await s.ingest(checked('2099-01-01T00:00:00.000Z', [workload('a', 'AWAKE')]));
    await s.ingest(checked('9', [workload('a', 'AWAKE')]));
    expect([await s.store.listRouters(), await s.ids()]).toEqual([[], []]);
    await s.ingest(checked(T1, [workload('a', 'ASLEEP')]));
    await s.ingest(stateChanged('a', 'ASLEEP', 'FAILED', '2099-01-01T00:00:00.000Z'));
    await s.ingest(checked(T2, [workload('a', 'AWAKE')]));
    expect([(await s.store.listRouters())[0]!.checkedAt, (await s.store.listWorkloads())[0]!.state]).toEqual([T2, 'AWAKE']);
    // Five minutes of clock difference are accepted.
    await s.ingest(stateChanged('a', 'AWAKE', 'NAPPING', at('2026-10-05T13:00:00.000Z', 240)));
    expect((await s.store.listWorkloads())[0]!.state).toBe('NAPPING');
    expect(s.refused.map(([event]) => event)).toEqual(['RouterEventRefused', 'RouterEventRefused', 'RouterEventRefused']);
  });

  it('keeps the known fields of a summary only, each of its type and size; a link other than https is dropped', async () => {
    const s = setup();
    const pauses = Array.from({ length: 100 }, (_, i) => ({ scope: 'workload', reason: `r${i}`, by: 'ops' }));
    await s.ingest(checked(T1, [
      workload('a', 'AWAKE', { url: 'javascript:alert(1)', name: 'n'.repeat(500), evil: 'x'.repeat(100_000), pauses, wakeCount: '3', stats7d: { wakes: 2, ignored: 'x' } }),
      workload('b', 'NOT-A-STATE', { url: 'https://b.example.com/' }),
      workload('../c'),
    ]));
    const [a, b] = await s.store.listWorkloads();
    expect([a!.url, (a!.name as string).length, 'evil' in a!, (a!.pauses as unknown[]).length, a!.wakeCount, a!.stats7d]).toEqual([null, 64, false, 20, undefined, { wakes: 2 }]);
    expect([b!.workloadId, b!.state, b!.url]).toEqual(['b', 'UNKNOWN', 'https://b.example.com/']);
    expect(await s.ids()).toEqual(['a', 'b']);
  });

  it('keeps the kinds of a workload\'s backends a router names (routers 0.23.3), the known ones only, once each', async () => {
    const s = setup();
    await s.ingest(checked(T1, [
      workload('a', 'AWAKE', { backends: ['asg', 'rds-instance', 'asg', 'evil'.repeat(100), 7] }),
      workload('b', 'AWAKE', { backends: 'instance' }),
      workload('c'),
    ]));
    const [a, b, c] = await s.store.listWorkloads();
    expect([a!.backends, b!.backends, c!.backends]).toEqual([['asg', 'rds-instance'], undefined, undefined]);
  });

  it('writes the workloads of a chunk ten at a time: a backlog drains within the Lambda timeout', async () => {
    const s = setup();
    let running = 0;
    let peak = 0;
    const slow = <A extends unknown[], R>(f: (...a: A) => Promise<R>) => async (...a: A) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 2));
      try { return await f(...a); } finally { running -= 1; }
    };
    const store = { ...s.store, readWorkload: slow(s.store.readWorkload), writeWorkload: slow(s.store.writeWorkload) };
    const ingest = createIngest({ store, now: () => NOW });
    await ingest(checked(T1, Array.from({ length: 90 }, (_, i) => workload(`w${i}`))));
    expect(peak).toBe(10);
    expect((await s.store.listWorkloads())).toHaveLength(90);
  });

  it('refuses a check of more chunks than a router can send', async () => {
    const s = setup();
    await s.ingest(checked(T1, [workload('a')], { index: 0, total: 1_000_000 }));
    expect(await s.ids()).toEqual([]);
  });

  it('tells a router not reporting: its last check older than 3 periods of its schedule', () => {
    const now = Date.parse(T2);
    expect(reporting({ checkedAt: at(T2, -14 * 60), checkSchedule: 'rate(5 minutes)' }, now)).toBe(true);
    expect(reporting({ checkedAt: at(T2, -16 * 60), checkSchedule: 'rate(5 minutes)' }, now)).toBe(false);
    expect(reporting({ checkedAt: at(T2, -2 * 3600), checkSchedule: 'rate(1 hour)' }, now)).toBe(true);
    expect(reporting({ checkedAt: null, checkSchedule: 'rate(5 minutes)' }, now)).toBe(false);
  });
});
