// Routers and their workloads as they report (scale design §4): summaries written from the router events.
import { describe, expect, it } from 'vitest';
import { fakeDynamo } from '../../discovery/test/dynamo-fake.js';
import { createFleetStore, reporting, type Group, type RouterEvent } from '../src/index.js';
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

  it('keeps `scheduled` when a router reports it true (routers 0.31.0), and nothing otherwise', async () => {
    const s = setup();
    await s.ingest(checked(T1, [workload('a', 'AWAKE', { scheduled: true }), workload('b', 'AWAKE', { scheduled: 'yes' }), workload('c', 'AWAKE')]));
    const [a, b, c] = await s.store.listWorkloads();
    expect([a!.scheduled, 'scheduled' in b!, 'scheduled' in c!]).toEqual([true, false, false]);
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

  it('keeps the tags a router reports (routers 0.30.0) when they follow the tag rules; none at all when one breaks them; a router before reports none', async () => {
    const s = setup();
    const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, 'v']));
    const fifty = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, 'v']));
    await s.ingest(checked(T1, [
      workload('a', 'AWAKE', { tags: { team: 'payments', env: 'prod', 'Ünï cödé': 'ça va' } }),
      workload('b', 'AWAKE', { tags: {} }), workload('c', 'AWAKE', { tags: ['team=payments'] }), workload('d'), workload('e', 'AWAKE', { tags: many }), workload('f', 'AWAKE', { tags: fifty }),
      workload('g', 'AWAKE', { tags: { team: 'payments', n: 7 } }), workload('h', 'AWAKE', { tags: { team: 'payments', ['k'.repeat(129)]: 'x' } }),
      workload('i', 'AWAKE', { tags: { team: 'payments', long: 'v'.repeat(257) } }), workload('j', 'AWAKE', { tags: { team: 'a,b' } }),
      workload('k', 'AWAKE', { tags: { team: 'payments', 'Dormeto:x': '1' } }), workload('l', 'AWAKE', { tags: { team: 'payments', '': 'y' } }),
      workload('m', 'AWAKE', { tags: { team: 'payments', script: '𝒜'.repeat(256) } }), workload('n', 'AWAKE', { tags: { team: 'payments', bad: 'tab\there' } }),
    ]));
    const get = async (id: string) => (await s.store.getWorkload(ACCOUNT, REGION, id))!.tags;
    expect([await get('a'), await get('b'), await get('c'), await get('d')]).toEqual([{ team: 'payments', env: 'prod', 'Ünï cödé': 'ça va' }, {}, undefined, undefined]);
    expect(Object.keys((await get('f')) as object)).toHaveLength(50);
    // Fail closed: a map that breaks a rule is kept as no tags, never trimmed.
    for (const id of ['e', 'g', 'h', 'i', 'j', 'k', 'l', 'n']) expect(await get(id), id).toEqual({});
    expect(await get('m'), 'a value of 256 code points is 512 UTF-16 units').toMatchObject({ team: 'payments' });
    // A later check replaces them; a state change keeps them.
    await s.ingest(checked(T2, [workload('a', 'AWAKE', { tags: { team: 'search' } })]));
    await s.ingest(stateChanged('a', 'AWAKE', 'NAPPING', at(T2, 30)));
    expect(await get('a')).toEqual({ team: 'search' });
  });

  it('replaces the tags of a stored workload at once; a workload not stored is not created', async () => {
    const s = setup();
    await s.ingest(checked(T1, [workload('a', 'AWAKE', { tags: { team: 'payments' } })]));
    expect(await s.store.putWorkloadTags(ACCOUNT, REGION, 'a', { team: 'search' })).toBe(true);
    expect(await s.store.getWorkload(ACCOUNT, REGION, 'a')).toMatchObject({ name: 'Name a', state: 'AWAKE', tags: { team: 'search' } });
    expect(await s.store.putWorkloadTags(ACCOUNT, REGION, 'ghost', { team: 'x' })).toBe(false);
    expect(await s.ids()).toEqual(['a']);
  });

  it('keeps a Kubernetes workload\'s backend kind and the failure kind cluster (routers 0.29.0, R10.5)', async () => {
    const s = setup();
    await s.ingest(checked(T1, [workload('a', 'FAILED', { backends: ['k8s', 'rds-instance'], failure: { kind: 'cluster', step: 'wake', backend: 'k8s:eks-demo/demo/Deployment/web', message: 'GET /apis: no connection within 3000 ms', at: at(T1, -60) }, consecutiveFailures: 1 })]));
    const w = await s.store.getWorkload(ACCOUNT, REGION, 'a');
    expect(w!.backends).toEqual(['k8s', 'rds-instance']);
    expect(w!.failure).toMatchObject({ kind: 'cluster' });
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

describe('failure index (R7b)', () => {
  const failure = { kind: 'capacity', step: 'wake', backend: 'rds:db1', message: 'no capacity for db.t4g.micro in eu-west-1b', at: at(T1, 10) };
  const failed = (when: string, extra: Record<string, unknown> = {}): RouterEvent => ({
    account: ACCOUNT, region: REGION, 'detail-type': 'Workload state changed',
    detail: { router: 'dmtr-dev', region: REGION, workloadId: 'a', from: 'WAKING', to: 'FAILED', at: when, wakeId: 'w1', cause: 'wake-failed', failure: { ...failure, at: when }, ...extra },
  });
  const awake = (when: string): RouterEvent => ({
    account: ACCOUNT, region: REGION, 'detail-type': 'Workload state changed', detail: { router: 'dmtr-dev', region: REGION, workloadId: 'a', from: 'WAKING', to: 'AWAKE', at: when, wakeId: 'w2', durationMs: 40000 },
  });

  it('indexes a failed wake from its event, with the workload\'s name, and deletes it at the next successful wake', async () => {
    const s = setup();
    await s.ingest(checked(T1, [workload('a', 'ASLEEP')]));
    await s.ingest(failed(at(T1, 10)));
    const [entry] = await s.store.listFailures();
    expect(entry).toMatchObject({ account: ACCOUNT, region: REGION, router: 'dmtr-dev', workloadId: 'a', name: 'Name a', wakeId: 'w1', failure: { kind: 'capacity', backend: 'rds:db1', at: at(T1, 10) } });
    await s.ingest(awake(at(T1, 20)));
    expect(await s.store.listFailures()).toEqual([]);
  });

  it('a stale success (older than the failure) leaves the failure indexed', async () => {
    const s = setup();
    await s.ingest(failed(at(T1, 30)));
    await s.ingest(awake(at(T1, 20)));
    expect(await s.store.listFailures()).toHaveLength(1);
  });

  it('a lost event is made good by the next check, and a check without the failure removes it', async () => {
    const s = setup();
    await s.ingest(checked(T1, [workload('a', 'ASLEEP', { failure: { ...failure, at: at(T1, -60) }, consecutiveFailures: 1 })]));
    expect((await s.store.listFailures()).map((f) => f.failure.kind)).toEqual(['capacity']);
    // Released (still the last wake's failure): kept.
    await s.ingest(checked(T2, [workload('a', 'ASLEEP', { failure: { ...failure, at: at(T1, -60) }, consecutiveFailures: 1 })]));
    expect(await s.store.listFailures()).toHaveLength(1);
    await s.ingest(checked(at(T2, 300), [workload('a', 'AWAKE')]));
    expect(await s.store.listFailures()).toEqual([]);
  });

  it('a router before 0.25.0 (FAILED without a reason) is indexed as unknown, kept back to ASLEEP, and removed once awake (review I4)', async () => {
    const s = setup();
    await s.ingest({ account: ACCOUNT, region: REGION, 'detail-type': 'Workload state changed', detail: { router: 'dmtr-dev', workloadId: 'a', from: 'WAKING', to: 'FAILED', at: at(T1, 10), cause: 'wake-failed' } });
    const [entry] = await s.store.listFailures();
    expect(entry!.failure).toEqual({ kind: 'unknown', step: 'wake', message: 'the wake failed (a router older than 0.25.0 gives no reason)', at: at(T1, 10) });
    // Its summaries have no failure fields: back to ASLEEP is not a successful wake ("woke again" would be wrong).
    await s.ingest(checked(T2, [workload('a', 'ASLEEP')]));
    expect(await s.store.listFailures()).toHaveLength(1);
    await s.ingest(checked(at(T2, 300), [workload('a', 'AWAKE')]));
    expect(await s.store.listFailures()).toEqual([]);
  });

  it('a workload no longer managed (unlisted by a whole check) leaves the index, so its alert resolves', async () => {
    const s = setup();
    await s.ingest(checked(T1, [workload('a', 'ASLEEP'), workload('b', 'ASLEEP')]));
    await s.ingest(failed(at(T1, 10)));
    await s.ingest(checked(T2, [workload('b', 'ASLEEP')]));
    expect(await s.store.getWorkload(ACCOUNT, REGION, 'a')).toBeNull();
    expect(await s.store.listFailures()).toEqual([]);
  });

  it('reads a failure time in milliseconds (router 0.25.0 before its fix), as found in dev', async () => {
    const s = setup();
    await s.ingest(failed(at(T1, 10), { failure: { ...failure, kind: 'unhealthy', at: Date.parse(at(T1, 10)) } }));
    const [entry] = await s.store.listFailures();
    expect(entry!.failure).toMatchObject({ kind: 'unhealthy', at: at(T1, 10) });
  });

  it('the next check\'s failure replaces a failure without reason, though a few milliseconds older than the change', async () => {
    const s = setup();
    await s.ingest({ account: ACCOUNT, region: REGION, 'detail-type': 'Workload state changed', detail: { router: 'dmtr-dev', workloadId: 'a', from: 'WAKING', to: 'FAILED', at: at(T1, 10), cause: 'wake-failed' } });
    const real = { ...failure, kind: 'unhealthy', at: new Date(Date.parse(at(T1, 10)) - 4).toISOString() };
    await s.ingest(checked(T2, [workload('a', 'FAILED', { failure: real, consecutiveFailures: 1, nextAttemptAt: at(T2, 60) })]));
    const [entry] = await s.store.listFailures();
    expect(entry).toMatchObject({ failure: { kind: 'unhealthy', at: real.at }, consecutiveFailures: 1, nextAttemptAt: at(T2, 60) });
  });

  it('a failure the index lost (or holds without reason) is written again at the next check, though the summary had it', async () => {
    const s = setup();
    const real = { ...failure, at: at(T1, -60) };
    await s.ingest(checked(T1, [workload('a', 'FAILED', { failure: real, consecutiveFailures: 1 })]));
    const [indexed] = await s.store.listFailures();
    await s.store.deleteFailure(ACCOUNT, REGION, 'a', (await s.store.getFailure(ACCOUNT, REGION, 'a'))!.version);
    await s.ingest(checked(T2, [workload('a', 'FAILED', { failure: real, consecutiveFailures: 1 })]));
    expect(await s.store.listFailures()).toEqual([indexed]);
    const puts: unknown[] = [];
    const put = s.store.putFailure;
    s.store.putFailure = async (...args) => { puts.push(args); return put(...args); };
    await s.ingest(checked(at(T2, 300), [workload('a', 'FAILED', { failure: real, consecutiveFailures: 1 })]));
    expect(puts, 'not written again when the index has it').toEqual([]);
  });

  it('keeps the fallback instance types in use, and drops what is not one', async () => {
    const s = setup();
    await s.ingest(checked(T1, [workload('a', 'AWAKE', { fallbacks: [{ instance: 'i-0123456789abcdef0', from: 't3.medium', to: 't3a.medium' }, { instance: 'x', from: 'a', to: 'b' }, 'junk'] })]));
    expect((await s.store.getWorkload(ACCOUNT, REGION, 'a'))!.fallbacks).toEqual([{ instance: 'i-0123456789abcdef0', from: 't3.medium', to: 't3a.medium' }]);
  });

  it('keeps the failure fields in summaries, and drops what is not one', async () => {
    const s = setup();
    await s.ingest(checked(T1, [workload('a', 'FAILED', { failure: { ...failure, kind: 'bogus', message: 'x'.repeat(500) }, consecutiveFailures: 2, nextAttemptAt: at(T1, 120) })]));
    const w = await s.store.getWorkload(ACCOUNT, REGION, 'a');
    expect(w!.failure).toMatchObject({ kind: 'unknown', step: 'wake' });
    expect((w!.failure as { message: string }).message).toHaveLength(300);
    expect([w!.consecutiveFailures, w!.nextAttemptAt]).toEqual([2, at(T1, 120)]);
  });
});

describe('state history (R8)', () => {
  const change = (to: string, when: string, extra: Record<string, unknown> = {}): RouterEvent => ({
    account: ACCOUNT, region: REGION, 'detail-type': 'Workload state changed',
    detail: { router: 'dmtr-dev', region: REGION, workloadId: 'a', to, at: when, ...extra },
  });
  const history = (s: ReturnType<typeof setup>, from = at(T1, -86_400), to = at(T2, 86_400)) => s.store.listHistory(ACCOUNT, REGION, 'a', from, to).then((r) => r.entries);

  it('stores each state change with its cause, wake id, duration, failure and who asked; a duplicate is one item', async () => {
    const s = setup();
    await s.ingest(change('WAKING', at(T1, 10), { from: 'ASLEEP', cause: 'normal', wakeId: 'w1' }));
    await s.ingest(change('WAKING', at(T1, 10), { from: 'ASLEEP', cause: 'normal', wakeId: 'w1' }));
    await s.ingest(change('AWAKE', at(T1, 50), { from: 'WAKING', wakeId: 'w1', durationMs: 40_000 }));
    await s.ingest(change('NAPPING', at(T1, 3_600), { from: 'AWAKE', cause: 'manager', by: 'ops@example.com' }));
    await s.ingest(change('FAILED', at(T1, 3_700), { from: 'NAPPING', cause: 'nap-failed', failure: { kind: 'permission', step: 'nap', message: 'denied', at: at(T1, 3_700) } }));
    const entries = await history(s);
    expect(entries.map((e) => [e.from, e.to, e.cause ?? null])).toEqual([['ASLEEP', 'WAKING', 'normal'], ['WAKING', 'AWAKE', null], ['AWAKE', 'NAPPING', 'manager'], ['NAPPING', 'FAILED', 'nap-failed']]);
    expect(entries[0]).toMatchObject({ account: ACCOUNT, region: REGION, router: 'dmtr-dev', workloadId: 'a', at: at(T1, 10), wakeId: 'w1' });
    expect(entries[1]!.durationMs).toBe(40_000);
    expect(entries[2]!.by).toBe('ops@example.com');
    expect(entries[3]!.failure).toMatchObject({ kind: 'permission', step: 'nap', message: 'denied' });
    expect(entries.some((e) => e.inferred)).toBe(false);
  });

  it('keeps entries history_days after their time (TTL), and a stale change too', async () => {
    const dynamo = fakeDynamo();
    const store = createFleetStore({ dynamo, table: 'dmt-dev-manager', now: () => NOW, historyDays: 30 });
    const ingest = createIngest({ store, now: () => NOW, log: { warn: () => {} } });
    await ingest(checked(T2, [workload('a', 'AWAKE')]));
    await ingest(change('ASLEEP', at(T1, 10), { from: 'NAPPING', cause: 'idle' }));
    const item = [...dynamo.items.values()].find((i) => i.sk?.S === `${at(T1, 10)}#ASLEEP`)!;
    expect(item.pk!.S).toBe(`HIST#${ACCOUNT}#${REGION}#a`);
    expect(Number(item.expiresAt!.N)).toBe(Math.floor(Date.parse(at(T1, 10)) / 1000) + 30 * 86_400);
  });

  it('a check after a lost event writes one inferred transition at the router\'s stateAt; the late event replaces it; unchanged checks write nothing', async () => {
    const s = setup();
    await s.ingest(checked(T1, [workload('a', 'AWAKE', { stateAt: at(T1, -100) })]));
    expect((await history(s)).map((e) => [e.from, e.to, e.at, e.inferred])).toEqual([[null, 'AWAKE', at(T1, -100), true]]);
    await s.ingest(checked(T2, [workload('a', 'ASLEEP', { stateAt: at(T2, -30) })]));
    expect((await history(s)).at(-1)).toMatchObject({ from: 'AWAKE', to: 'ASLEEP', at: at(T2, -30), inferred: true });
    await s.ingest(change('ASLEEP', at(T2, -30), { from: 'NAPPING', cause: 'idle' }));
    const entries = await history(s);
    expect(entries).toHaveLength(2);
    expect(entries.at(-1)).toEqual(expect.objectContaining({ from: 'NAPPING', to: 'ASLEEP', cause: 'idle' }));
    expect(entries.at(-1)!.inferred).toBeUndefined();
    await s.ingest(checked(at(T2, 300), [workload('a', 'ASLEEP', { stateAt: at(T2, -30) })]));
    await s.ingest(checked(at(T2, 600), [workload('a', 'ASLEEP', { stateAt: at(T2, -30) })]));
    expect(await history(s)).toHaveLength(2);
  });

  it('an inferred entry never replaces an event\'s, and a check after the event adds nothing', async () => {
    const s = setup();
    await s.ingest(checked(T1, [workload('a', 'ASLEEP', { stateAt: at(T1, -100) })]));
    await s.ingest(change('WAKING', at(T1, 10), { from: 'ASLEEP', cause: 'normal', wakeId: 'w1' }));
    await s.ingest(checked(T2, [workload('a', 'WAKING', { stateAt: at(T1, 10) })]));
    expect((await history(s)).map((e) => [e.to, e.cause ?? null, e.inferred ?? false])).toEqual([['ASLEEP', null, true], ['WAKING', 'normal', false]]);
    await s.store.putHistory({ account: ACCOUNT, region: REGION, router: 'dmtr-dev', workloadId: 'a', from: 'ASLEEP', to: 'WAKING', at: at(T1, 10), inferred: true });
    expect((await history(s)).at(-1)!.cause).toBe('normal');
  });

  it('the first entry once per workload, also for one known before the history; an older router dates it at the check', async () => {
    const s = setup();
    await s.store.writeWorkload({ account: ACCOUNT, region: REGION, router: 'dmtr-dev', workloadId: 'a', state: 'ASLEEP', checkedAt: at(T1, -300) } as never, 0);
    await s.ingest(checked(T1, [workload('a', 'ASLEEP')]));
    await s.ingest(checked(T2, [workload('a', 'ASLEEP')]));
    expect((await history(s)).map((e) => [e.from, e.to, e.at, e.inferred])).toEqual([[null, 'ASLEEP', T1, true]]);
    expect((await s.store.getWorkload(ACCOUNT, REGION, 'a'))!.historySince).toBe(T1);
    // An older router changes state, its event lost: dated at the check.
    await s.ingest(checked(at(T2, 300), [workload('a', 'AWAKE')]));
    expect((await history(s)).at(-1)).toMatchObject({ from: 'ASLEEP', to: 'AWAKE', at: at(T2, 300), inferred: true });
  });

  it('an event before the first check of a known workload writes what the manager knew as the first entry (found live)', async () => {
    const s = setup();
    await s.store.writeWorkload({ account: ACCOUNT, region: REGION, router: 'dmtr-dev', workloadId: 'a', state: 'ASLEEP', stateAt: at(T1, -7_200), checkedAt: at(T1, -60) } as never, 0);
    await s.ingest(change('WAKING', at(T1, 10), { from: 'ASLEEP', cause: 'normal' }));
    expect((await history(s)).map((e) => [e.from, e.to, e.at, e.inferred ?? false])).toEqual([[null, 'ASLEEP', at(T1, -7_200), true], ['ASLEEP', 'WAKING', at(T1, 10), false]]);
    await s.ingest(checked(T2, [workload('a', 'WAKING', { stateAt: at(T1, 10) })]));
    expect(await history(s)).toHaveLength(2);
  });

  it('a check\'s stateAt ahead of the clock is ignored: it never pins the summary (review I1)', async () => {
    const s = setup();
    await s.ingest(checked(T1, [workload('a', 'AWAKE', { stateAt: '2099-01-01T00:00:00.000Z' })]));
    expect((await s.store.getWorkload(ACCOUNT, REGION, 'a'))!.stateAt).not.toBe('2099-01-01T00:00:00.000Z');
    await s.ingest(change('NAPPING', at(T1, 60), { from: 'AWAKE', cause: 'idle' }));
    expect((await s.store.getWorkload(ACCOUNT, REGION, 'a'))!.state).toBe('NAPPING');
    expect((await history(s))[0]!.at).toBe(T1);
  });

  it('keeps the instances a nap hibernated (router 0.32.0): valid ids only, at most 50', async () => {
    const s = setup();
    await s.ingest(change('ASLEEP', at(T1, 10), { from: 'NAPPING', hibernated: ['i-0123456789abcdef0', 'bad', 7] }));
    expect((await history(s))[0]!.hibernated).toEqual(['i-0123456789abcdef0']);
    const many = setup();
    await many.ingest(change('ASLEEP', at(T1, 10), { from: 'NAPPING', hibernated: Array.from({ length: 60 }, (_, i) => `i-${String(i).padStart(8, '0')}`) }));
    expect((await history(many))[0]!.hibernated).toHaveLength(50);
    const none = setup();
    await none.ingest(change('ASLEEP', at(T1, 10), { from: 'NAPPING', hibernated: 'i-0123456789abcdef0' }));
    expect('hibernated' in (await history(none))[0]!).toBe(false);
  });

  it('keeps `hibernated` when a router reports it true (routers 0.32.0), and nothing otherwise', async () => {
    const s = setup();
    await s.ingest(checked(T1, [workload('a', 'ASLEEP', { hibernated: true }), workload('b', 'ASLEEP', { hibernated: 'yes' }), workload('c', 'ASLEEP')]));
    const [a, b, c] = await s.store.listWorkloads();
    expect([a!.hibernated, 'hibernated' in b!, 'hibernated' in c!]).toEqual([true, false, false]);
  });

  it('`hibernated` follows the state: a change out of ASLEEP drops it, a nap that hibernated sets it, a plain one does not', async () => {
    const s = setup();
    const hibernated = async () => (await s.store.getWorkload(ACCOUNT, REGION, 'a'))!.hibernated;
    await s.ingest(checked(T1, [workload('a', 'ASLEEP', { hibernated: true })]));
    await s.ingest(change('WAKING', at(T1, 10), { from: 'ASLEEP', cause: 'normal' }));
    expect(await hibernated()).toBeUndefined();
    await s.ingest(change('AWAKE', at(T1, 20), { from: 'WAKING' }));
    await s.ingest(change('NAPPING', at(T1, 30), { from: 'AWAKE', cause: 'idle' }));
    await s.ingest(change('ASLEEP', at(T1, 40), { from: 'NAPPING', hibernated: ['i-0123456789abcdef0'] }));
    expect(await hibernated()).toBe(true);
    // A check started before that nap, reported after it: the newer change keeps its state and what it says.
    await s.ingest(checked(at(T1, 35), [workload('a', 'NAPPING')]));
    expect([(await s.store.getWorkload(ACCOUNT, REGION, 'a'))!.state, await hibernated()]).toEqual(['ASLEEP', true]);
    await s.ingest(change('WAKING', at(T1, 50), { from: 'ASLEEP', cause: 'normal' }));
    await s.ingest(checked(at(T1, 45), [workload('a', 'ASLEEP', { hibernated: true })]));
    expect([(await s.store.getWorkload(ACCOUNT, REGION, 'a'))!.state, await hibernated()]).toEqual(['WAKING', undefined]);
    await s.ingest(change('AWAKE', at(T1, 60), { from: 'WAKING' }));
    await s.ingest(change('NAPPING', at(T1, 70), { from: 'AWAKE', cause: 'idle' }));
    await s.ingest(change('ASLEEP', at(T1, 80), { from: 'NAPPING', stopped: [] }));
    expect(await hibernated()).toBeUndefined();
  });

  it('keeps what a nap stopped (router 0.27.0), its known kinds only (R9)', async () => {
    const s = setup();
    await s.ingest(change('ASLEEP', at(T1, 10), { from: 'NAPPING', stopped: [
      { kind: 'ec2', type: 't3.medium', count: 2, os: 'Linux' }, { kind: 'fargate', vcpu: 0.5, memoryGb: 1, count: 1, arch: 'arm64', os: 'Linux' },
      { kind: 'rds', class: 'db.t4g.micro', engine: 'postgres', multiAz: true }, { kind: 'aurora-serverless', engine: 'aurora-mysql', acu: 0.5 },
      { kind: 'unknown', backend: 'ecs:x', reason: 'denied' }, { kind: 'ec2', type: 'bad type', count: 1, os: 'Linux' }, { kind: 'gpu', n: 1 }, 'junk',
    ] }));
    const [entry] = await history(s);
    expect(entry!.stopped!.map((i) => i.kind)).toEqual(['ec2', 'fargate', 'rds', 'aurora-serverless', 'unknown']);
  });

  it('keeps the pods a Kubernetes nap stopped (router 0.29.0, R10.5), well-formed only', async () => {
    const s = setup();
    const pods = { kind: 'k8s-pods', count: 2, cpu: 0.25, memoryGb: 0.5, nodeType: 'm5.large', os: 'Linux', spot: true, autoscaled: true, allocatable: { cpu: 1.93, memoryGb: 6.886 } };
    await s.ingest(change('ASLEEP', at(T1, 10), { from: 'NAPPING', stopped: [
      pods, { ...pods, nodeType: null, spot: false, autoscaled: false }, { ...pods, count: 0 }, { ...pods, allocatable: 'big' }, { ...pods, nodeType: 'not a type' },
    ] }));
    const [entry] = await history(s);
    expect(entry!.stopped).toEqual([pods, { kind: 'k8s-pods', count: 2, cpu: 0.25, memoryGb: 0.5, nodeType: null, os: 'Linux', autoscaled: false, allocatable: { cpu: 1.93, memoryGb: 6.886 } }]);
  });

  it('caches a price 30 days, the absence of one a day (R9)', async () => {
    const dynamo = fakeDynamo();
    const store = createFleetStore({ dynamo, table: 'dmt-dev-manager', now: () => NOW });
    await store.putPrice('eu-west-1#ec2#t3.medium#Linux', 0.0456);
    await store.putPrice('eu-west-1#ec2#x9.huge#Linux', null);
    expect(await store.getPrice('eu-west-1#ec2#t3.medium#Linux')).toEqual({ usd: 0.0456 });
    expect(await store.getPrice('eu-west-1#ec2#x9.huge#Linux')).toEqual({ usd: null });
    expect(await store.getPrice('eu-west-1#ec2#m5.large#Linux')).toBeNull();
    const ttl = (k: string) => Number([...dynamo.items.values()].find((i) => i.sk?.S === `PRICE#${k}`)!.expiresAt!.N) - Math.floor(NOW / 1000);
    expect([ttl('eu-west-1#ec2#t3.medium#Linux'), ttl('eu-west-1#ec2#x9.huge#Linux')]).toEqual([30 * 86_400, 86_400]);
  });

  it('keeps what ran on Spot (router 0.28.0, R9.5): spot only when true', async () => {
    const s = setup();
    await s.ingest(change('ASLEEP', at(T1, 10), { from: 'NAPPING', stopped: [
      { kind: 'ec2', type: 't3.medium', count: 2, os: 'Linux', spot: true }, { kind: 'fargate', vcpu: 0.5, memoryGb: 1, count: 1, arch: 'arm64', os: 'Linux', spot: true },
      { kind: 'ec2', type: 't3.small', count: 1, os: 'Linux', spot: 'yes' }, { kind: 'rds', class: 'db.t4g.micro', engine: 'postgres', multiAz: false, spot: true },
    ] }));
    const [entry] = await history(s);
    expect(entry!.stopped!.map((i) => 'spot' in i && i.spot)).toEqual([true, true, false, false]);
  });

  it('caches a Spot price a day (R9.5)', async () => {
    const dynamo = fakeDynamo();
    const store = createFleetStore({ dynamo, table: 'dmt-dev-manager', now: () => NOW });
    await store.putPrice('eu-west-1#ec2-spot#t3.medium#Linux', 0.019, 1);
    expect(Number([...dynamo.items.values()].find((i) => i.sk?.S === 'PRICE#eu-west-1#ec2-spot#t3.medium#Linux')!.expiresAt!.N) - Math.floor(NOW / 1000)).toBe(86_400);
  });

  it('keeps the savings discounts with who set them and when; none set is 0 and 0 (R9.5)', async () => {
    const store = createFleetStore({ dynamo: fakeDynamo(), table: 'dmt-dev-manager', now: () => NOW });
    expect(await store.getSavingsSettings()).toEqual({ compute: 0, databases: 0, updatedAt: null, updatedBy: null });
    await store.putSavingsSettings({ compute: 20, databases: 30 }, 'admin@example.com');
    expect(await store.getSavingsSettings()).toEqual({ compute: 20, databases: 30, updatedAt: new Date(NOW).toISOString(), updatedBy: 'admin@example.com' });
  });

  it('keeps the daily update check off by default, with who set it and when; and its last result', async () => {
    const store = createFleetStore({ dynamo: fakeDynamo(), table: 'dmt-dev-manager', now: () => NOW });
    expect(await store.getUpdateCheck()).toEqual({ enabled: false, alert: false });
    expect(await store.getUpdateResult()).toBeNull();
    await store.putUpdateCheck({ enabled: true, alert: true, updatedBy: 'admin@example.com' });
    expect(await store.getUpdateCheck()).toEqual({ enabled: true, alert: true, updatedAt: new Date(NOW).toISOString(), updatedBy: 'admin@example.com' });
    const result = { checkedAt: new Date(NOW).toISOString(), running: '0.13.0', latest: '0.14.0', notified: '0.14.0' };
    await store.putUpdateResult(result);
    expect(await store.getUpdateResult()).toEqual(result);
  });

  it('keeps the groups\' grants: a round trip with who set them and when, a list in name order, a delete (tags design §4)', async () => {
    const store = createFleetStore({ dynamo: fakeDynamo(), table: 'dmt-dev-manager', now: () => NOW });
    expect(await store.listGroups()).toEqual([]);
    expect(await store.getGroup('payments')).toBeNull();
    const grants: Group['grants'] = [{ tags: { team: 'payments' }, permissions: ['read', 'wake'] }, { tags: {}, permissions: ['read'] }];
    await store.putGroup({ name: 'payments', description: 'The payments team', grants, updatedBy: 'admin@example.com' });
    await store.putGroup({ name: 'data', description: '', grants: [], updatedBy: 'admin@example.com' });
    const stored = { name: 'payments', description: 'The payments team', grants, updatedAt: new Date(NOW).toISOString(), updatedBy: 'admin@example.com' };
    expect(await store.getGroup('payments')).toEqual(stored);
    expect((await store.listGroups()).map((g) => g.name)).toEqual(['data', 'payments']);
    await store.putGroup({ name: 'payments', description: 'Payments', grants: [], updatedBy: 'other@example.com' });
    expect(await store.getGroup('payments')).toMatchObject({ description: 'Payments', grants: [], updatedBy: 'other@example.com' });
    await store.deleteGroup('payments');
    expect(await store.getGroup('payments')).toBeNull();
    expect((await store.listGroups()).map((g) => g.name)).toEqual(['data']);
    await store.deleteGroup('payments');
  });

  it('skips a group item whose data cannot be read, among good ones', async () => {
    const dynamo = fakeDynamo();
    const store = createFleetStore({ dynamo, table: 'dmt-dev-manager', now: () => NOW });
    await store.putGroup({ name: 'a', description: '', grants: [], updatedBy: 'admin@example.com' });
    await store.putGroup({ name: 'bad', description: '', grants: [], updatedBy: 'admin@example.com' });
    await store.putGroup({ name: 'c', description: '', grants: [], updatedBy: 'admin@example.com' });
    [...dynamo.items.values()].find((i) => i.sk?.S === 'GROUP#bad')!.data = { S: '{not json' };
    expect((await store.listGroups()).map((g) => g.name)).toEqual(['a', 'c']);
    expect(await store.getGroup('bad')).toBeNull();
  });

  it('reads the discounts consistently: a change is seen at once after it is saved (final review 5)', async () => {
    const dynamo = fakeDynamo();
    const sent: Record<string, unknown>[] = [];
    const store = createFleetStore({ dynamo: { ...dynamo, send: (c: { input: Record<string, unknown> }) => { sent.push(c.input); return dynamo.send(c as never); } } as never, table: 'dmt-dev-manager', now: () => NOW });
    await store.getSavingsSettings();
    expect(sent.find((i) => (i.Key as { sk: { S: string } } | undefined)?.sk.S === 'SAVINGS#SETTINGS')).toMatchObject({ ConsistentRead: true });
  });

  it('a period is read in pages up to a cap, with the entry before it', async () => {
    const s = setup();
    for (let i = 0; i < 30; i += 1) await s.ingest(change(i % 2 ? 'ASLEEP' : 'AWAKE', at(T1, i * 60), { cause: 'idle' }));
    const capped = await s.store.listHistory(ACCOUNT, REGION, 'a', T1, at(T1, 3_600), { max: 10 });
    expect([capped.entries.length, capped.truncated]).toEqual([10, true]);
    // The newest are kept (review I2): the latest days are what people look at.
    expect([capped.entries[0]!.at, capped.entries.at(-1)!.at]).toEqual([at(T1, 20 * 60), at(T1, 29 * 60)]);
    const all = await s.store.listHistory(ACCOUNT, REGION, 'a', at(T1, 300), at(T1, 3_600));
    expect([all.entries.length, all.truncated]).toEqual([25, false]);
    expect(await s.store.historyBefore(ACCOUNT, REGION, 'a', at(T1, 300))).toMatchObject({ to: 'AWAKE', at: at(T1, 240) });
    expect(await s.store.historyBefore(ACCOUNT, REGION, 'a', T1)).toBeNull();
  });
});
