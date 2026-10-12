import { describe, expect, it } from 'vitest';
import type { RouterSummary } from '@dormeto/fleet';
import type { InstalledRouter } from '@dormeto/operations';
import { createWatchdog, listObservations, problemCode, type Alarm, type AlarmStore, type Notification } from '../src/watchdog.js';

const NOW = Date.UTC(2026, 9, 8, 12, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const MANAGER = '121014831971';
const iso = (ms: number) => new Date(ms).toISOString();

function summary(account: string, region: string, checkedAgoMs: number, problems: unknown[] = [], extra: Partial<RouterSummary> = {}): RouterSummary {
  return {
    account, region, name: 'r', version: '0.24.0', build: 'b', checkSchedule: 'rate(5 minutes)', checkedAt: iso(NOW - checkedAgoMs), durationMs: 1,
    health: { status: problems.length ? 'warning' : 'ok', problems }, pauses: [], counts: {}, check: { checkedAt: iso(NOW - checkedAgoMs), total: 1, received: [0] },
    ...extra,
  };
}

function installed(account: string, region: string, installedAgoMs = 10 * HOUR, extra: Partial<InstalledRouter> = {}): InstalledRouter {
  return { name: 'dmtr-dev', account, region, controller: 'c', onboarder: 'o', version: '0.24.0', build: 'b', installedBy: 'ops', installedAt: iso(NOW - installedAgoMs), ...extra };
}

function memoryAlarms(): AlarmStore & { items: Map<string, { alarm: Alarm; version: number }>; writes: number } {
  const items = new Map<string, { alarm: Alarm; version: number }>();
  const store = {
    items,
    writes: 0,
    async list() { return [...items.values()].map((x) => structuredClone(x)); },
    async put(alarm: Alarm, version: number) {
      if ((items.get(alarm.subject.id)?.version ?? 0) !== version) return false;
      store.writes++;
      items.set(alarm.subject.id, { alarm: structuredClone(alarm), version: version + 1 });
      return true;
    },
    async remove(id: string, version: number) {
      if ((items.get(id)?.version ?? 0) !== version) return false;
      store.writes++;
      items.delete(id);
      return true;
    },
  };
  return store;
}

function setup({ summaries = [] as RouterSummary[], registry = [] as InstalledRouter[], terraform = [{ name: 'dmt-dev', region: 'eu-west-1', controller: 'dmt-dev-controller' }], failPublish = false } = {}) {
  let now = NOW;
  const sent: Notification[] = [];
  const state = { summaries, registry, failPublish };
  const alarms = memoryAlarms();
  const watchdog = createWatchdog({
    env: 'dev', managerAccount: MANAGER, dashboardUrl: 'https://app.dev.dormeto.com', terraformRouters: terraform,
    fleet: { listRouters: async () => state.summaries },
    registry: { listRouters: async () => state.registry },
    alarms,
    notify: { async publish(n) { if (state.failPublish) throw new Error('throttled'); sent.push(n); } },
    now: () => now,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  return { watchdog, sent, alarms, state, advance: (ms: number) => { now += ms; } };
}

describe('watchdog: routers', () => {
  it('alarms a router whose reports stopped for 3 periods of its schedule, not before', async () => {
    const quiet = setup({ summaries: [summary(MANAGER, 'eu-west-1', 14 * MIN)] });
    await quiet.watchdog.run();
    expect(quiet.sent).toEqual([]);
    const silent = setup({ summaries: [summary(MANAGER, 'eu-west-1', 22 * MIN)] });
    await silent.watchdog.run();
    expect(silent.sent).toHaveLength(1);
    expect(silent.sent[0]!.subject).toBe('[Dormeto dev] dmt-dev (121014831971 eu-west-1): no report for 22 minutes');
    expect(silent.sent[0]!.attributes).toEqual({ level: 'error', kind: 'router' });
    expect(silent.sent[0]!.message).toContain('https://app.dev.dormeto.com/routers');
    const { alarm } = silent.alarms.items.get(`router#${MANAGER}#eu-west-1`)!;
    expect(alarm).toMatchObject({ level: 'error', since: iso(NOW), notified: ['silent'], subject: { kind: 'router', name: 'dmt-dev', account: MANAGER, region: 'eu-west-1' } });
  });

  it('expects an installed router 15 minutes after its install, and names it as the Routers view does', async () => {
    const fresh = setup({ terraform: [], registry: [installed('038606077307', 'eu-west-3', 10 * MIN)] });
    await fresh.watchdog.run();
    expect(fresh.sent).toEqual([]);
    fresh.advance(6 * MIN);
    await fresh.watchdog.run();
    expect(fresh.sent[0]!.subject).toBe('[Dormeto dev] dmtr-dev-038606077307-eu-west-3 (038606077307 eu-west-3): no report received');
    const uninstalling = setup({ terraform: [], registry: [installed(MANAGER, 'eu-west-3', HOUR, { uninstalling: true })] });
    await uninstalling.watchdog.run();
    expect(uninstalling.sent).toEqual([]);
  });

  it('opens the reported health problems by their code, once, and sends nothing while they stay', async () => {
    const s = setup({ summaries: [summary(MANAGER, 'eu-west-1', MIN, [{ level: 'warning', code: 'controller-errors', text: 'controller: 2 errors in 24 hours' }])] });
    await s.watchdog.run();
    expect(s.sent.map((n) => [n.subject, n.attributes.level])).toEqual([['[Dormeto dev] dmt-dev (121014831971 eu-west-1): controller: 2 errors in 24 hours', 'warning']]);
    const writes = s.alarms.writes;
    s.state.summaries = [summary(MANAGER, 'eu-west-1', MIN, [{ level: 'warning', code: 'controller-errors', text: 'controller: 3 errors in 24 hours' }])];
    s.advance(5 * MIN);
    await s.watchdog.run();
    expect(s.sent).toHaveLength(1);
    expect(s.alarms.writes, 'only a change is written').toBe(writes + 1);
    expect(s.alarms.items.get(`router#${MANAGER}#eu-west-1`)!.alarm.problems[0]).toMatchObject({ text: 'controller: 3 errors in 24 hours', since: iso(NOW) });
  });

  it('gives a router without codes (before 0.24.0) stable codes from its texts, numbers aside', () => {
    expect(problemCode({ text: 'controller: 2 errors in 24 hours' })).toBe(problemCode({ text: 'controller: 17 errors in 24 hours' }));
    expect(problemCode({ code: 'drift', text: '3 drift repairs' })).toBe('drift');
  });

  it('raises a warning that became an error, and resolves a router once clear', async () => {
    const s = setup({ summaries: [summary(MANAGER, 'eu-west-1', MIN, [{ level: 'warning', code: 'x', text: 'something' }])] });
    await s.watchdog.run();
    s.state.summaries = [summary(MANAGER, 'eu-west-1', MIN, [{ level: 'error', code: 'x', text: 'something worse' }])];
    s.advance(5 * MIN);
    await s.watchdog.run();
    expect(s.sent[1]!.attributes.level).toBe('error');
    expect(s.sent[1]!.message).toContain('something worse');
    s.state.summaries = [summary(MANAGER, 'eu-west-1', MIN)];
    s.advance(5 * MIN);
    await s.watchdog.run();
    expect(s.sent[2]!.attributes).toEqual({ level: 'resolved', kind: 'router' });
    expect(s.sent[2]!.subject).toBe('[Dormeto dev] dmt-dev (121014831971 eu-west-1): resolved');
    expect(s.alarms.items.get(`router#${MANAGER}#eu-west-1`)!.alarm.level).toBe('ok');
  });

  it('a code that comes and goes notifies its opening once in 6 hours', async () => {
    // Reports keep coming (checked a minute before each run), with the problem every other run.
    const s = setup();
    let elapsed = 0;
    const report = (open: boolean) => [summary(MANAGER, 'eu-west-1', MIN - elapsed, open ? [{ level: 'warning', code: 'queue-check', text: '1 message' }] : [])];
    for (let i = 0; i < 12; i++) {
      s.state.summaries = report(i % 2 === 0);
      await s.watchdog.run();
      s.advance(10 * MIN);
      elapsed += 10 * MIN;
    }
    expect(s.sent.filter((n) => n.attributes.level === 'warning')).toHaveLength(1);
    // Still there 6 hours after its last clearing: the problem is back for good, and said again.
    for (let i = 0; i < 37; i++) {
      s.state.summaries = report(true);
      await s.watchdog.run();
      s.advance(10 * MIN);
      elapsed += 10 * MIN;
    }
    expect(s.sent.filter((n) => n.attributes.level === 'warning')).toHaveLength(2);
  });

  it('sends 10 messages and one digest when 1,000 routers fall silent together', async () => {
    const registry = Array.from({ length: 1000 }, (_, i) => installed(String(100000000000 + i), 'eu-west-1'));
    const s = setup({ terraform: [], registry, summaries: registry.map((r) => summary(r.account, r.region, HOUR)) });
    await s.watchdog.run();
    expect(s.sent).toHaveLength(11);
    expect(s.sent[10]!.subject).toBe('[Dormeto dev] 990 more alarms changed');
    expect(s.sent[10]!.message).toContain('and 940 more');
    expect([...s.alarms.items.values()].every(({ alarm }) => alarm.notified.includes('silent'))).toBe(true);
    s.advance(5 * MIN);
    await s.watchdog.run();
    expect(s.sent).toHaveLength(11);
  });

  it('a failed publish is sent again at the next run', async () => {
    const s = setup({ summaries: [summary(MANAGER, 'eu-west-1', HOUR)], failPublish: true });
    await s.watchdog.run();
    expect(s.alarms.items.size).toBe(0);
    s.state.failPublish = false;
    s.advance(5 * MIN);
    await s.watchdog.run();
    expect(s.sent).toHaveLength(1);
  });

  it('a summary whose health cannot be read alarms its router, and the run goes on', async () => {
    const s = setup({
      terraform: [{ name: 'dmt-dev', region: 'eu-west-1', controller: 'c' }, { name: 'dmt-paris', region: 'eu-west-3', controller: 'c' }],
      summaries: [summary(MANAGER, 'eu-west-1', MIN, [], { health: { problems: 'garbage' } }), summary(MANAGER, 'eu-west-3', HOUR)],
    });
    await s.watchdog.run();
    expect(s.sent.map((n) => n.subject)).toEqual([
      '[Dormeto dev] dmt-paris (121014831971 eu-west-3): no report for 60 minutes',
      '[Dormeto dev] dmt-dev (121014831971 eu-west-1): its health report cannot be read',
    ]);
  });

  it('drops, without a message, the alarm of a router no longer known', async () => {
    const s = setup({ terraform: [], registry: [installed(MANAGER, 'eu-west-3')], summaries: [summary(MANAGER, 'eu-west-3', HOUR)] });
    await s.watchdog.run();
    s.state.registry = [];
    await s.watchdog.run();
    expect(s.alarms.items.size).toBe(0);
    expect(s.sent).toHaveLength(1);
  });

  it('keeps subjects to printable ASCII in 100 characters (SNS)', async () => {
    const long = 'x'.repeat(120);
    const s = setup({ summaries: [summary(MANAGER, 'eu-west-1', MIN, [{ level: 'warning', code: 'y', text: `naïve — ${long}` }])] });
    await s.watchdog.run();
    expect(s.sent[0]!.subject).toMatch(/^[\x20-\x7e]{1,100}$/);
    expect(s.sent[0]!.subject.endsWith('...')).toBe(true);
  });
});

describe('watchdog: IP lists (R6b)', () => {
  const line = (over: Record<string, unknown>) => ({ name: 'ipsum', url: 'https://x', version: '1', entries: 9, refreshHours: 24, fetchedAt: iso(NOW - HOUR), lastAttemptAt: iso(NOW - HOUR), ...over });

  it('alarms a list whose last download failed, and one with no new version for twice its period, an error after 7 days', () => {
    expect(listObservations({ lists: [line({})] }, NOW)).toEqual([{ subject: { id: 'list#ipsum', kind: 'list', name: 'ipsum' }, problems: [] }]);
    const failed = listObservations({ lists: [line({ error: 'HTTP 503', errorAt: iso(NOW - HOUR) })] }, NOW);
    expect(failed[0]!.problems).toEqual([{ code: 'download', level: 'warning', text: 'last download failed: HTTP 503', hint: expect.any(String) }]);
    const stale = listObservations({ lists: [line({ fetchedAt: iso(NOW - 50 * HOUR) })] }, NOW);
    expect(stale[0]!.problems.map((p) => [p.code, p.level, p.text])).toEqual([['stale', 'warning', 'no new version for 50 hours (refreshed every 24 hours)']]);
    const old = listObservations({ lists: [line({ fetchedAt: iso(NOW - 8 * 24 * HOUR) })] }, NOW);
    expect(old[0]!.problems[0]!.level).toBe('error');
    const never = listObservations({ lists: [{ name: 'gcp', url: 'https://y', refreshHours: 24, lastAttemptAt: iso(NOW - HOUR), error: 'HTTP 404' }] }, NOW);
    expect(never[0]!.problems.map((p) => p.text)).toEqual(['never downloaded: HTTP 404']);
  });

  it('sends a list\'s alarm through the run, as a router\'s', async () => {
    const s = setup({ summaries: [summary(MANAGER, 'eu-west-1', MIN)] });
    const watchdog = createWatchdog({
      env: 'dev', managerAccount: MANAGER, dashboardUrl: 'https://app.dev.dormeto.com', terraformRouters: [],
      fleet: { listRouters: async () => [] }, registry: { listRouters: async () => [] }, alarms: s.alarms,
      notify: { publish: async (n) => { s.sent.push(n); } }, now: () => NOW, log: { info: () => {}, warn: () => {}, error: () => {} },
      extraObservations: async () => listObservations({ lists: [line({ error: 'HTTP 503' })] }, NOW),
    });
    await watchdog.run();
    expect(s.sent.map((n) => [n.subject, n.attributes.kind])).toEqual([['[Dormeto dev] IP list ipsum: last download failed: HTTP 503', 'list']]);
    expect(s.sent[0]!.message).toContain('https://app.dev.dormeto.com/routers#ip-lists');
  });
});
