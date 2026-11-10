import { describe, expect, it } from 'vitest';
import { createFleetStore, createIngest, type RouterPoll, type RouterSummary } from '@dormeto/fleet';
import { createRegistry } from '@dormeto/fleet/registry';
import type { InstalledRouter } from '@dormeto/operations';
import { fakeDynamo } from '../../discovery/test/dynamo-fake.js';
import { createPoll } from '../../fleet/src/poll.js';
import { createWatchdog, listObservations, problemCode, snsInput, workloadObservations, type Alarm, type AlarmStore, type Notification } from '../src/watchdog.js';

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

function setup({ summaries = [] as RouterSummary[], registry = [] as InstalledRouter[], polls = [] as { account: string; region: string; checkedAt: string | null; poll: Partial<RouterPoll> | null }[], terraform = [{ name: 'dmt-dev', region: 'eu-west-1', controller: 'dmt-dev-controller' }], failPublish = false } = {}) {
  let now = NOW;
  const sent: Notification[] = [];
  const state = { summaries, registry, polls, failPublish };
  const alarms = memoryAlarms();
  const watchdog = createWatchdog({
    env: 'dev', managerAccount: MANAGER, dashboardUrl: 'https://app.dev.dormeto.com', terraformRouters: terraform,
    fleet: { listRouters: async () => state.summaries, routerPolls: async () => state.polls as never },
    routerVersion: '0.40.0',
    registry: { listRouters: async () => state.registry },
    alarms,
    notify: { async publish(n) { if (state.failPublish) throw new Error('throttled'); sent.push(n); } },
    now: () => now,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  return { watchdog, sent, alarms, state, advance: (ms: number) => { now += ms; } };
}

const PROJECT = 'acme-prod';
const gcp = (installedAgoMs = 10 * HOUR, extra: Partial<InstalledRouter> = {}) => installed(PROJECT, 'europe-west1', installedAgoMs, { cloud: 'gcp', onboarder: '', installedBy: 'cli', controller: 'https://c.run.app', version: '0.40.0', ...extra });

describe('watchdog: Google Cloud routers', () => {
  it('compares a dev router\'s version by major.minor.patch: 0.39.0-dev.3 is too old, 0.40.0-dev.1 is not', async () => {
    const old = setup({ terraform: [], registry: [gcp(10 * HOUR, { version: '0.39.0-dev.3' })] });
    await old.watchdog.run();
    expect(old.alarms.items.get(`router#${PROJECT}#europe-west1`)!.alarm.problems.map((p) => p.code)).toEqual(['too-old']);
    const dev = setup({ terraform: [], registry: [gcp(10 * HOUR, { version: '0.40.0-dev.1' })] });
    await dev.watchdog.run();
    expect(dev.alarms.items.get(`router#${PROJECT}#europe-west1`)!.alarm.problems.map((p) => p.code)).toEqual(['silent']);
  });

  it('calls a router below 0.40.0 too old, with the install command, never silent', async () => {
    const s = setup({ terraform: [], registry: [gcp(10 * HOUR, { version: '0.39.0' })] });
    await s.watchdog.run();
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.message).toContain(`router 0.39.0 can't report to the manager: dormeto gcp routers install --project ${PROJECT} --region europe-west1 --version 0.40.0`);
    expect(s.sent[0]!.attributes).toEqual({ level: 'error', kind: 'router', cloud: 'gcp', account: PROJECT, region: 'europe-west1', router: `dmtr-${PROJECT}-europe-west1` });
    expect(s.alarms.items.get(`router#${PROJECT}#europe-west1`)!.alarm.problems.map((p) => p.code)).toEqual(['too-old']);
  });

  it('calls a router too old when its poll says it has no /v1/actions, even with an unknown version', async () => {
    const s = setup({ terraform: [], registry: [gcp(10 * HOUR, { version: '' })], polls: [{ account: PROJECT, region: 'europe-west1', checkedAt: null, poll: { tooOld: '' } }] });
    await s.watchdog.run();
    expect(s.sent[0]!.message).toContain(`router older than 0.40.0 can't report to the manager: dormeto gcp routers install --project ${PROJECT} --region europe-west1 --version 0.40.0`);
    expect(s.alarms.items.get(`router#${PROJECT}#europe-west1`)!.alarm.problems.map((p) => p.code)).toEqual(['too-old']);
  });

  it('gives an installed router of unknown version the grace of 15 minutes, then calls it silent', async () => {
    const s = setup({ terraform: [], registry: [gcp(10 * MIN, { version: '' })] });
    await s.watchdog.run();
    expect(s.sent).toEqual([]);
    s.advance(6 * MIN);
    await s.watchdog.run();
    expect(s.sent[0]!.subject).toContain('no report received');
  });

  it('calls a 0.40.0 router silent after 16 minutes, with the advice of Cloud Run and its Scheduler job', async () => {
    const s = setup({ terraform: [], registry: [gcp()], summaries: [summary(PROJECT, 'europe-west1', 16 * MIN, [], { checkSchedule: '*/5 * * * *', version: '0.40.0' })] });
    await s.watchdog.run();
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.subject).toContain('no report for 16 minutes');
    for (const text of [s.sent[0]!.message, JSON.stringify(s.sent[0]!.chat)]) {
      expect(text).toContain('Cloud Run');
      expect(text).toContain('dmtr-europe-west1-check');
      expect(text).not.toContain('Lambda');
    }
    expect(s.sent[0]!.attributes.cloud).toBe('gcp');
  });

  // The poll's refusal says what to run; a silent router's advice would send the operator to Cloud Run's logs instead.
  it('says the refusal the poll met, with its command, instead of silent: the manager\'s access missing, a controller not found yet', async () => {
    const access = 'the manager\'s accounts can\'t reach the router: dormeto gcp connect --project dormeto-host --profile <profile> --env dev';
    const refused = setup({
      terraform: [], registry: [gcp()],
      summaries: [summary(PROJECT, 'europe-west1', 40 * MIN, [], { checkSchedule: '*/5 * * * *', version: '0.40.0' })],
      polls: [{ account: PROJECT, region: 'europe-west1', checkedAt: iso(NOW - 40 * MIN), poll: { lastRefusal: 'no_access', lastError: `events: ${access}` } }],
    });
    await refused.watchdog.run();
    expect(refused.alarms.items.get(`router#${PROJECT}#europe-west1`)!.alarm.problems.map((p) => [p.code, p.level, p.text])).toEqual([['no-access', 'error', access]]);
    expect(refused.sent).toHaveLength(1);
    expect(refused.sent[0]!.message).toContain(access);
    expect(refused.sent[0]!.message).not.toContain('Cloud Scheduler');
    const unknown = 'discovery hasn\'t found this router\'s controller yet: dormeto gcp connect --project dormeto-host --profile <profile> --env dev again';
    const undiscovered = setup({
      terraform: [], registry: [gcp(10 * HOUR, { controller: '' })],
      polls: [{ account: PROJECT, region: 'europe-west1', checkedAt: null, poll: { lastRefusal: 'router_unknown', lastError: `controller: ${unknown}` } }],
    });
    await undiscovered.watchdog.run();
    expect(undiscovered.alarms.items.get(`router#${PROJECT}#europe-west1`)!.alarm.problems.map((p) => [p.code, p.text])).toEqual([['router-unknown', unknown]]);
  });

  it('gives a refused router installed lately the grace of a silent one, and a reporting one its own report', async () => {
    const poll = { lastRefusal: 'no_access' as const, lastError: 'events: the manager\'s accounts can\'t reach the router: dormeto gcp connect --project dormeto-host --profile <profile> --env dev' };
    const fresh = setup({ terraform: [], registry: [gcp(5 * MIN)], polls: [{ account: PROJECT, region: 'europe-west1', checkedAt: null, poll }] });
    await fresh.watchdog.run();
    expect(fresh.sent).toEqual([]);
    const reporting = setup({
      terraform: [], registry: [gcp()], summaries: [summary(PROJECT, 'europe-west1', 2 * MIN, [], { checkSchedule: '*/5 * * * *', version: '0.40.0' })],
      polls: [{ account: PROJECT, region: 'europe-west1', checkedAt: iso(NOW - 2 * MIN), poll }],
    });
    await reporting.watchdog.run();
    expect(reporting.sent).toEqual([]);
  });

  it('keeps an AWS router\'s advice as it was', async () => {
    const s = setup({ summaries: [summary(MANAGER, 'eu-west-1', 22 * MIN)] });
    await s.watchdog.run();
    expect(s.sent[0]!.message).toContain('Its idle check does not run');
    expect(s.sent[0]!.message).not.toContain('Cloud Run');
  });

  it('puts the cloud in the digest when every alarm of it is of one cloud, and in a workload\'s message', async () => {
    const s = setup({ terraform: [], registry: Array.from({ length: 12 }, (_, i) => gcp(10 * HOUR, { region: `europe-west${i + 1}`, version: '0.39.0' })) });
    await s.watchdog.run();
    expect(s.sent.at(-1)!.attributes).toMatchObject({ kind: 'digest', cloud: 'gcp' });
  });

  // An SNS filter policy matches a String.Array attribute when one of its elements matches: a cloud's filter gets the digest.
  it('gives a digest whose alarms mix the clouds both, as a String.Array: a filter on either cloud receives it', async () => {
    const s = setup({
      terraform: [], registry: [
        // 15 of each: whatever their order, the 20 past the first 10 messages hold both.
        ...Array.from({ length: 15 }, (_, i) => gcp(10 * HOUR, { region: `europe-west${i + 1}`, version: '0.39.0' })),
        ...Array.from({ length: 15 }, (_, i) => installed(`0386060773${String(i).padStart(2, '0')}`, 'eu-west-3')),
      ],
    });
    await s.watchdog.run();
    const digest = s.sent.at(-1)!;
    expect(digest.attributes).toMatchObject({ kind: 'digest', cloud: ['aws', 'gcp'] });
    expect(snsInput(digest, 'arn:topic').MessageAttributes.cloud).toEqual({ DataType: 'String.Array', StringValue: '["aws","gcp"]' });
    expect(snsInput(s.sent[0]!, 'arn:topic').MessageAttributes.cloud).toEqual({ DataType: 'String', StringValue: s.sent[0]!.attributes.cloud });
  });
});

// The fleet's poll and the watchdog over one table: the advised `dormeto gcp routers install` clears too-old within 10 minutes.
describe('watchdog and the poll: a too-old Google Cloud router upgraded', () => {
  it('resolves the router\'s too-old alarm once the poll read 0.40.0 from its health and polled it at the next run', async () => {
    let t = NOW;
    const table = 'dmt-dev-manager';
    const dynamo = fakeDynamo();
    const store = createFleetStore({ dynamo, table, now: () => t });
    const registry = createRegistry({ dynamo, table });
    const controller = 'https://dmtr-europe-west1-controller-abc-ew.a.run.app';
    await registry.put(gcp(10 * HOUR, { name: 'dmtr-europe-west1', controller, version: '0.39.0' }));
    // The router as its controller answers: its health, its journal with its last check, its rows.
    const running = { version: '0.39.0' };
    const answer = (body: unknown) => ({ status: 200, text: JSON.stringify(body) });
    const request = async (_sa: string, _audience: string, method: string, _url: string, body?: unknown) => {
      if (method === 'GET') return answer({ version: running.version, project: PROJECT, region: 'europe-west1' });
      const { action } = body as { action: string };
      if (action === 'events') return answer({ events: [], next: null, check: { checkedAt: iso(t - 30_000), durationMs: 800, checkSchedule: '*/5 * * * *', health: { status: 'ok', problems: [] }, pauses: [], counts: {} }, managerSettings: { etag: null } });
      if (action === 'list') return answer({ router: { name: 'dmtr-europe-west1', version: running.version, build: 'b', checkSchedule: '*/5 * * * *', pauses: [] }, workloads: [] });
      return { status: 400, text: JSON.stringify({ error: 'unknown-action' }) };
    };
    const poll = createPoll({
      store, ingest: createIngest({ store, now: () => t }), registry, env: 'dev', routerVersion: '0.40.0', now: () => t,
      google: { current: async () => ({ connection: { project: 'dormeto-host' } as never, google: { request } }) },
      settings: { etag: async () => null, read: async () => null },
    });
    const sent: Notification[] = [];
    const watchdog = createWatchdog({
      env: 'dev', managerAccount: MANAGER, dashboardUrl: 'https://app.dev.dormeto.com', terraformRouters: [], routerVersion: '0.40.0',
      fleet: { listRouters: () => store.listRouters(), routerPolls: () => store.routerPolls() }, registry: { listRouters: () => registry.list() },
      alarms: memoryAlarms(), notify: { publish: async (n) => { sent.push(n); } }, now: () => t, log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    await poll();
    await watchdog.run();
    expect(sent.map((n) => n.attributes.level)).toEqual(['error']);
    expect(sent[0]!.message).toContain(`router 0.39.0 can't report to the manager: dormeto gcp routers install --project ${PROJECT} --region europe-west1 --version 0.40.0`);
    // The advised install.
    running.version = '0.40.0';
    t += 10 * MIN;
    await poll();
    t += MIN;
    await poll();
    await watchdog.run();
    expect(sent.map((n) => n.attributes.level)).toEqual(['error', 'resolved']);
    expect(sent[1]!.attributes).toMatchObject({ kind: 'router', cloud: 'gcp', account: PROJECT, region: 'europe-west1' });
  });
});

describe('watchdog: routers', () => {
  it('alarms a router whose reports stopped for 3 periods of its schedule, not before', async () => {
    const quiet = setup({ summaries: [summary(MANAGER, 'eu-west-1', 14 * MIN)] });
    await quiet.watchdog.run();
    expect(quiet.sent).toEqual([]);
    const silent = setup({ summaries: [summary(MANAGER, 'eu-west-1', 22 * MIN)] });
    await silent.watchdog.run();
    expect(silent.sent).toHaveLength(1);
    expect(silent.sent[0]!.subject).toBe('[Dormeto dev] dmt-dev (121014831971 eu-west-1): no report for 22 minutes');
    expect(silent.sent[0]!.attributes).toEqual({ level: 'error', kind: 'router', cloud: 'aws', account: MANAGER, region: 'eu-west-1', router: 'dmt-dev' });
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

  it('a router\'s failed workloads open no router alert: each failed wake is its own (R7b)', async () => {
    const s = setup({ summaries: [summary(MANAGER, 'eu-west-1', MIN, [{ level: 'warning', code: 'failed-workloads', text: '1 failed workload' }])] });
    await s.watchdog.run();
    expect(s.sent).toEqual([]);
    s.state.summaries = [summary(MANAGER, 'eu-west-1', MIN, [{ level: 'warning', text: '2 failed workloads' }])];
    s.advance(5 * MIN);
    await s.watchdog.run();
    expect(s.sent, 'nor from a router before 0.24.0 (no codes)').toEqual([]);
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
    expect(s.sent[2]!.attributes).toEqual({ level: 'resolved', kind: 'router', cloud: 'aws', account: MANAGER, region: 'eu-west-1', router: 'dmt-dev' });
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
    await expect(s.watchdog.run()).rejects.toThrow('not sent');
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

describe('watchdog: review fixes', () => {
  it('I3: a failed publish fails the run (the watchdog errors alarm sees it), after writing what was sent', async () => {
    const s = setup({
      terraform: [{ name: 'dmt-dev', region: 'eu-west-1', controller: 'c' }, { name: 'dmt-paris', region: 'eu-west-3', controller: 'c' }],
      summaries: [summary(MANAGER, 'eu-west-1', HOUR), summary(MANAGER, 'eu-west-3', HOUR)],
    });
    let calls = 0;
    const watchdog = createWatchdog({
      env: 'dev', managerAccount: MANAGER, dashboardUrl: 'https://app.dev.dormeto.com', terraformRouters: [{ name: 'dmt-dev', region: 'eu-west-1', controller: 'c' }, { name: 'dmt-paris', region: 'eu-west-3', controller: 'c' }],
      fleet: { listRouters: async () => s.state.summaries }, registry: { listRouters: async () => [] }, alarms: s.alarms,
      notify: { publish: async (n) => { calls += 1; if (calls === 1) throw new Error('AuthorizationError'); s.sent.push(n); } },
      now: () => NOW, log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    await expect(watchdog.run()).rejects.toThrow('1 alert not sent: AuthorizationError');
    expect(s.alarms.items.size).toBe(1);
  });

  it('I6: unreadable list statuses keep the routers\' alarms going and the lists\' alarms as they are', async () => {
    const s = setup({ summaries: [summary(MANAGER, 'eu-west-1', HOUR)] });
    const line = { name: 'ipsum', url: 'https://x', version: '1', entries: 9, refreshHours: 24, fetchedAt: iso(NOW - HOUR), error: 'HTTP 503' };
    let failing = false;
    const watchdog = createWatchdog({
      env: 'dev', managerAccount: MANAGER, dashboardUrl: 'https://app.dev.dormeto.com', terraformRouters: [{ name: 'dmt-dev', region: 'eu-west-1', controller: 'c' }],
      fleet: { listRouters: async () => s.state.summaries }, registry: { listRouters: async () => [] }, alarms: s.alarms,
      notify: { publish: async (n) => { s.sent.push(n); } }, now: () => NOW, log: { info: () => {}, warn: () => {}, error: () => {} },
      extraObservations: async () => { if (failing) throw new Error('S3 SlowDown'); return listObservations({ lists: [line] }, NOW); },
    });
    await watchdog.run();
    expect([...s.alarms.items.keys()].sort()).toEqual(['list#ipsum', `router#${MANAGER}#eu-west-1`]);
    failing = true;
    s.state.summaries = [summary(MANAGER, 'eu-west-1', MIN)];
    // Review M8: the routers are done, then the run fails, so that the watchdog's errors alarm says the lists are unread.
    await expect(watchdog.run()).rejects.toThrow('subjects unreadable: S3 SlowDown');
    expect(s.sent.at(-1)!.subject).toBe('[Dormeto dev] dmt-dev (121014831971 eu-west-1): resolved');
    expect(s.alarms.items.has('list#ipsum'), 'kept while its status cannot be read').toBe(true);
  });
});

describe('watchdog: failed wakes (R7b)', () => {
  const entry = (kind: string, over: Record<string, unknown> = {}) => ({
    account: '038606077307', region: 'eu-west-3', router: 'dmtr-dev-038606077307-eu-west-3', workloadId: 'f1e2', name: 'shop', url: 'https://shop.example.com/',
    failure: { kind, step: 'wake', backend: 'rds:shop-db', message: 'no capacity for your instance class db.t4g.micro in AZ eu-west-3a', at: iso(NOW - 2 * MIN) },
    consecutiveFailures: 1, nextAttemptAt: iso(NOW + MIN), ...over,
  });
  const watchdogWith = (s: ReturnType<typeof setup>, entries: () => unknown[]) => createWatchdog({
    env: 'dev', managerAccount: MANAGER, dashboardUrl: 'https://app.dev.dormeto.com', terraformRouters: [],
    fleet: { listRouters: async () => [] }, registry: { listRouters: async () => [] }, alarms: s.alarms,
    notify: { publish: async (n) => { s.sent.push(n); } }, now: () => NOW, log: { info: () => {}, warn: () => {}, error: () => {} },
    extraObservations: async () => workloadObservations(entries() as never, NOW),
  });

  it('advises a Google Cloud workload\'s failed wake in Google Cloud\'s words for each kind; an AWS one\'s advice stays AWS\'s', () => {
    const hint = (kind: string, over: Record<string, unknown> = {}) => workloadObservations([entry(kind, over)] as never, NOW)[0]!.problems[0]!.hint!;
    const google = (kind: string) => hint(kind, {
      account: 'acme-prod', region: 'europe-west1', router: 'dmtr-acme-prod-europe-west1',
      failure: { kind, step: 'wake', backend: 'projects/acme-prod/zones/europe-west1-b/instances/web-1', message: 'ZONE_RESOURCE_POOL_EXHAUSTED', at: iso(NOW - 2 * MIN) },
    });
    expect(google('capacity')).toContain('Compute Engine had no capacity for it in its zone');
    expect(google('capacity')).toContain('Fallback machine types');
    expect(google('quota')).toContain('A Compute Engine quota of the project and region was reached');
    expect(google('permission')).toContain('the router\'s service account dmtr-europe-west1');
    expect(google('permission')).toContain('dormeto gcp routers show --project acme-prod --region europe-west1');
    expect(google('unhealthy')).toContain('the backend service\'s health check');
    expect(google('unhealthy')).toContain('If its backends keep running without passing the health check, Dormeto stops them after its idle window.');
    for (const kind of ['capacity', 'quota', 'permission', 'configuration', 'unhealthy', 'throttled', 'timeout', 'cluster', 'unknown']) {
      expect(google(kind), kind).not.toMatch(/AWS|EC2|Auto Scaling|ECS|ELB|target|DmtRouterBoundary|Service Quotas|wake_timeout_seconds|launch template|subnet|task definition/);
    }
    expect(hint('capacity')).toContain('AWS had no capacity for it: Dormeto retried during the wake. Fallback instance types (EC2), a mixed instances policy or several subnets (Auto Scaling), or capacity providers (ECS) let it start elsewhere.');
    expect(hint('permission')).toContain('A permission refused it: the router\'s role or DmtRouterBoundary (apply the access module of the manager\'s release again), or the key policy of an encrypted volume or snapshot.');
    expect(hint('unhealthy')).toContain('If its backends keep running without a healthy target, Dormeto stops them after its idle window.');
  });

  it('says that the next request retries it once the next attempt has passed, not a past time', () => {
    const [o] = workloadObservations([entry('unhealthy', { nextAttemptAt: iso(NOW - 10 * MIN) })] as never, NOW);
    expect(o!.problems[0]!.hint).toMatch(/^Backend: rds:shop-db\. The next request retries it \(1 failure in a row\)\./);
  });

  it('names the router as the Routers view does (the index has the router\'s own name), in the link and the attributes', async () => {
    const s = setup();
    await createWatchdog({
      env: 'dev', managerAccount: MANAGER, dashboardUrl: 'https://app.dev.dormeto.com', terraformRouters: [],
      fleet: { listRouters: async () => [] }, registry: { listRouters: async () => [installed('038606077307', 'eu-west-3')] }, alarms: s.alarms,
      notify: { publish: async (n) => { s.sent.push(n); } }, now: () => NOW, log: { info: () => {}, warn: () => {}, error: () => {} },
      extraObservations: async () => workloadObservations([entry('capacity', { router: 'dmtr-dev' })] as never, NOW),
    }).run();
    const n = s.sent.find((x) => x.attributes.kind === 'workload')!;
    expect(n.attributes.router).toBe('dmtr-dev-038606077307-eu-west-3');
    expect(n.message).toContain('https://app.dev.dormeto.com/workloads/dmtr-dev-038606077307-eu-west-3/f1e2');
  });

  it('a failed wake is an error alert naming the workload, its kind, backend, message, next attempt and advice', async () => {
    const s = setup();
    await watchdogWith(s, () => [entry('capacity')]).run();
    const [n] = s.sent;
    // Cut at SNS's 100 characters.
    expect(n!.subject).toMatch(/^\[Dormeto dev\] shop \(038606077307 eu-west-3\): wake failed: no capacity for your instance class db\.+$/);
    expect(n!.message).toContain('wake failed: no capacity for your instance class db.t4g.micro in AZ eu-west-3a');
    expect(n!.attributes).toEqual({ level: 'error', kind: 'workload', cloud: 'aws', account: '038606077307', region: 'eu-west-3', router: 'dmtr-dev-038606077307-eu-west-3', workload: 'f1e2' });
    expect(n!.message).toContain('https://shop.example.com/');
    expect(n!.message).toContain('rds:shop-db');
    expect(n!.message).toMatch(/next attempt after \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    expect(n!.message).toMatch(/fallback instance types|several subnets/);
    expect(n!.message).toContain('https://app.dev.dormeto.com/workloads/dmtr-dev-038606077307-eu-west-3/f1e2');
  });

  it('one alert across retries; a new kind is a new alert; a successful wake says it woke again', async () => {
    const s = setup();
    let entries = [entry('capacity')];
    const watchdog = watchdogWith(s, () => entries);
    await watchdog.run();
    entries = [entry('capacity', { consecutiveFailures: 3, nextAttemptAt: iso(NOW + 4 * MIN) })];
    await watchdog.run();
    expect(s.sent).toHaveLength(1);
    entries = [entry('quota')];
    await watchdog.run();
    expect(s.sent.map((n) => n.attributes.level)).toEqual(['error', 'error']);
    entries = [];
    // The index entry removed by a successful wake: the subject is no longer known, so it is resolved, not dropped.
    await watchdog.run();
    expect(s.sent.at(-1)!.subject).toBe('[Dormeto dev] shop (038606077307 eu-west-3): woke again');
  });

  it('a workload failing again 15 minutes after it woke is alerted again; a quicker flap is not (found live)', async () => {
    const s = setup();
    let t = NOW;
    let entries: unknown[] = [entry('unhealthy')];
    const watchdog = createWatchdog({
      env: 'dev', managerAccount: MANAGER, dashboardUrl: 'https://app.dev.dormeto.com', terraformRouters: [],
      fleet: { listRouters: async () => [] }, registry: { listRouters: async () => [] }, alarms: s.alarms,
      notify: { publish: async (n) => { s.sent.push(n); } }, now: () => t, log: { info: () => {}, warn: () => {}, error: () => {} },
      extraObservations: async () => workloadObservations(entries as never, t),
    });
    const step = async (minutes: number, next: unknown[]) => { t += minutes * MIN; entries = next; await watchdog.run(); };
    await watchdog.run();
    await step(5, []);
    expect(s.sent.map((n) => n.subject.split(': ')[1])).toEqual(['wake failed', 'woke again'].map((x, i) => (i ? x : expect.stringMatching(/^wake failed/)) as never));
    await step(10, [entry('unhealthy')]);
    expect(s.sent, 'failing again 10 minutes after waking: damped').toHaveLength(2);
    await step(5, []);
    await step(20, [entry('unhealthy')]);
    expect(s.sent, 'failing again 20 minutes after waking: a new alert').toHaveLength(3);
    expect(s.sent.at(-1)!.subject).toMatch(/wake failed/);
  });

  it('every message has a chat body (Amazon Q Developer custom notification) beside its text', async () => {
    const s = setup();
    await watchdogWith(s, () => [entry('unhealthy', { failure: { kind: 'unhealthy', step: 'wake', message: '2 targets, none healthy: Target.FailedHealthChecks', at: iso(NOW) } })]).run();
    const chat = s.sent[0]!.chat!;
    expect(chat.version).toBe('1.0');
    expect(chat.source).toBe('custom');
    expect(chat.content.textType).toBe('client-markdown');
    expect(chat.content.title).toBe(s.sent[0]!.subject);
    expect(chat.content.description).toContain('Target.FailedHealthChecks');
    expect(chat.content.nextSteps!.length).toBeGreaterThan(0);
  });

  it('1,000 workloads failing at once (a region without capacity) send 10 messages and a digest', async () => {
    const s = setup();
    const entries = Array.from({ length: 1000 }, (_, i) => entry('capacity', { workloadId: `w${i}`, name: `app-${i}` }));
    await watchdogWith(s, () => entries).run();
    expect(s.sent).toHaveLength(11);
    expect(s.sent[10]!.attributes.kind).toBe('digest');
    // Chat channels get the digest too (review I5): Amazon Q Developer drops a message without the custom format.
    expect(s.sent[10]!.chat).toMatchObject({ version: '1.0', source: 'custom', content: { textType: 'client-markdown', title: '[Dormeto dev] 990 more alarms changed' } });
    expect(s.sent[10]!.chat!.content.description).toMatch(/app-\d+ \(038606077307 eu-west-3\)[\s\S]*and 9\d\d more/);
  });
});

describe('watchdog: SNS input (R7b)', () => {
  it('sends the text to email and the chat body to https subscriptions, with filterable attributes', () => {
    const input = snsInput({
      subject: 's', message: 'text',
      chat: { version: '1.0', source: 'custom', content: { textType: 'client-markdown', title: 's', description: 'd' } },
      attributes: { level: 'error', kind: 'workload', account: '1', region: 'eu-west-3', router: 'r', workload: 'w' },
    }, 'arn:topic');
    expect(input.MessageStructure).toBe('json');
    const bodies = JSON.parse(input.Message);
    expect([bodies.default, bodies.email]).toEqual(['text', 'text']);
    expect(JSON.parse(bodies.https).source).toBe('custom');
    expect(Object.fromEntries(Object.entries(input.MessageAttributes).map(([k, v]) => [k, (v as { StringValue: string }).StringValue])))
      .toEqual({ level: 'error', kind: 'workload', account: '1', region: 'eu-west-3', router: 'r', workload: 'w' });
    expect(input.TopicArn).toBe('arn:topic');
    expect(input.Subject).toBe('s');
  });
});
