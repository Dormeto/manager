// The watchdog's probe of the Google Cloud routers (router push design 2026-11-14 §6.3, §6.4): the routers report, and the
// manager calls only one that is silent (no check within 3 check periods) or never reported: its health (GET /v1/health),
// then, at 0.41.0 or later, `manager-settings` with where to report, and settings.json when the router holds another ETag.
// Google's own 404 twice running unregisters it; a refusal is recorded for the watchdog; a router below 0.41.0 is too old,
// its version read from its health. The calls go through the real callRouter and routerHealth, Google's token stubbed.
import { PutItemCommand } from '@aws-sdk/client-dynamodb';
import { GoogleError, type GoogleConnection } from '@dormeto/google';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeDynamo } from '../../discovery/test/dynamo-fake.js';
import { googleEvent } from '../src/google-report.js';
import { createIngest } from '../src/ingest.js';
import { createProbe } from '../src/probe.js';
import { createRegistry, routerItem, type InstalledRouter } from '../src/registry.js';
import { createFleetStore } from '../src/store.js';

const TABLE = 'dmt-dev-manager';
const PROJECT = 'dormeto-dev';
const T0 = Date.parse('2026-11-14T12:00:00.000Z');
const S = 1000;
const MIN = 60 * S;
const iso = (ms: number) => new Date(ms).toISOString();
const EVENTS = { url: 'https://abc123.execute-api.eu-west-1.amazonaws.com/routers/credentials', audience: 'https://abc123.execute-api.eu-west-1.amazonaws.com' };

const connection: GoogleConnection = {
  project: 'dormeto-host', projectNumber: '1034397096264', pool: 'dmt-dev', provider: 'aws', scopes: ['projects/dormeto-dev'],
  serviceAccounts: { discovery: 'dmt-dev-discovery@dormeto-host.iam.gserviceaccount.com', command: 'dmt-dev-command@dormeto-host.iam.gserviceaccount.com' },
  routers: [{ project: PROJECT, region: 'europe-west2' }], googleAdded: [], connectedAt: iso(T0 - 86_400 * S), connectedBy: 'admin@example.com', cli: '0.15.0',
};

type Payload = Record<string, any>;
type Answer = { status: number; text: string };
const json = (status: number, body: unknown): Answer => ({ status, text: JSON.stringify(body) });
// Google's own page for a Cloud Run URL it knows no service at: HTML, not the controller's JSON.
const GOOGLE_404: Answer = { status: 404, text: '<!DOCTYPE html>\n<html lang=en><meta charset=utf-8><title>Error 404 (Not Found)!!1</title><p><b>404.</b> <ins>That’s an error.</ins></html>' };
const GOOGLE_403: Answer = { status: 403, text: '<html><title>403 Forbidden</title></html>' };

// A Google Cloud router as its controller answers (router 0.41.0): its health with its version and its reports' state, and
// `manager-settings` with where to report alone (it keeps its settings and answers the ETag it holds) or with the settings.
// `answer` in place of an action's answer, `healthAnswer` in place of the health's, `throws` before any call (Google's
// token refused), `delayMs` before it answers.
function fakeRouter(project: string, region: string, order: string[]) {
  const r = {
    region,
    controller: `https://dmtr-${region}-controller-${project}.${region}.run.app`,
    version: '0.41.0',
    etag: null as string | null,
    settings: undefined as unknown,
    events: undefined as unknown,
    calls: [] as Payload[],
    healthReads: 0,
    answer: undefined as ((payload: Payload) => Answer | undefined) | undefined,
    healthAnswer: undefined as Answer | undefined,
    throws: undefined as Error | undefined,
    delayMs: 0,
    async health(): Promise<Answer> {
      order.push(r.controller);
      r.healthReads += 1;
      if (r.delayMs) await new Promise((done) => setTimeout(done, r.delayMs));
      if (r.throws) throw r.throws;
      return r.healthAnswer ?? json(200, { version: r.version, project, region, report: null });
    },
    async respond(payload: Payload): Promise<Answer> {
      r.calls.push(payload);
      if (r.throws) throw r.throws;
      const own = r.answer?.(payload);
      if (own) return own;
      if (payload.action === 'manager-settings') {
        if (payload.events !== undefined) r.events = payload.events;
        if (payload.settings === undefined) return json(200, { etag: r.etag });
        r.settings = payload.settings;
        r.etag = payload.etag;
        return json(200, { etag: payload.etag });
      }
      return json(400, { error: 'unknown-action', message: `unknown action: ${payload.action}` });
    },
  };
  return r;
}
type FakeRouter = ReturnType<typeof fakeRouter>;

// The manager's side: its table, the registry, the store, settings.json in S3 and the connection.
function world({ now, events = EVENTS }: { now?: () => number; events?: { url: string; audience: string } | null } = {}) {
  const clock = { t: T0 };
  const time = now ?? (() => clock.t);
  const dynamo = fakeDynamo();
  const store = createFleetStore({ dynamo, table: TABLE, now: time });
  const ingest = createIngest({ store, now: time });
  const registry = createRegistry({ dynamo, table: TABLE });
  const routers = new Map<string, FakeRouter>();
  const order: string[] = [];
  let connected = true;
  const request = async (_sa: string, _audience: string, method: string, url: string, body?: unknown) => {
    const r = routers.get(new URL(url).origin)!;
    return method === 'GET' && new URL(url).pathname === '/v1/health' ? r.health() : r.respond(body as Payload);
  };
  const s3 = { etag: null as string | null, text: '', heads: 0, gets: 0 };
  const logs: [string, Payload][] = [];
  const probe = createProbe({
    store, registry, env: 'dev', routerVersion: '0.41.0', now: time, ...(events ? { events } : {}),
    google: { current: async () => (connected ? { connection, google: { request } } : null) },
    settings: {
      etag: async () => (s3.heads++, s3.etag),
      read: async () => (s3.gets++, s3.etag ? { etag: s3.etag, text: s3.text } : null),
    },
    log: { info: (event, data) => logs.push([event, data as Payload]), warn: (event, data) => logs.push([event, data as Payload]) },
  });
  const register = async (r: FakeRouter, over: Partial<InstalledRouter> = {}) => {
    const router: InstalledRouter = {
      name: `dmtr-${r.region}`, account: PROJECT, region: r.region, controller: r.controller, onboarder: '', version: '0.41.0', build: '', installedBy: 'cli', cloud: 'gcp',
      installedAt: iso(T0 - 86_400 * S), ...over,
    };
    await dynamo.send(new PutItemCommand({ TableName: TABLE, Item: routerItem(router) }));
  };
  const add = async (region: string, over: Partial<InstalledRouter> = {}) => {
    const r = fakeRouter(over.account ?? PROJECT, region, order);
    if (over.version) r.version = over.version;
    routers.set(r.controller, r);
    await register(r, over);
    return r;
  };
  // A check the router reported `agoMs` before now, every 5 minutes.
  const reported = (region: string, agoMs: number, project = PROJECT) => ingest(googleEvent({ account: project, region }, 'Router checked', {
    router: { name: `dmtr-${region}`, version: '0.41.0', build: 'b1', checkSchedule: '*/5 * * * *' }, checkedAt: iso(time() - agoMs), durationMs: 800,
    health: { status: 'ok', problems: [] }, pauses: [], counts: {}, chunk: { index: 0, total: 1 }, workloads: [], managerSettings: { etag: null },
  }));
  const probeOf = async (region: string, project = PROJECT) => (await store.routerProbes()).find((p) => p.account === project && p.region === region)?.probe ?? null;
  return { dynamo, store, registry, order, s3, logs, probe, add, register, reported, clock, probeOf, disconnect: () => { connected = false; } };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the watchdog\'s probe of Google Cloud routers', () => {
  it('calls a Google Cloud router with a controller that is silent or never reported, never one that reports, nor an AWS router', async () => {
    const w = world();
    const reporting = await w.add('europe-west2');
    const silent = await w.add('europe-west1');
    const never = await w.add('us-central1');
    await w.reported('europe-west2', 2 * MIN);
    // 3 periods of its */5 schedule: silent after 15 minutes.
    await w.reported('europe-west1', 16 * MIN);
    await w.dynamo.send(new PutItemCommand({
      TableName: TABLE, Item: routerItem({
        name: 'dmtr-dev', account: '121014831971', region: 'eu-west-3', controller: 'arn:aws:lambda:eu-west-3:121014831971:function:dmtr-dev-controller', onboarder: '', version: '0.41.0',
        build: '', installedBy: 'admin@example.com', installedAt: iso(T0),
      }),
    }));
    expect(await w.probe()).toEqual({ routers: 2, probed: 2, left: 0 });
    expect([reporting, silent, never].map((r) => r.healthReads)).toEqual([0, 1, 1]);
    expect(await w.probeOf('europe-west2')).toBeNull();
    expect(await w.probeOf('eu-west-3', '121014831971')).toBeNull();
    // Given where to report, one that never reported has the watchdog's grace of 15 minutes from then; a silent one doesn't.
    expect(await w.probeOf('us-central1')).toEqual({ probedAt: iso(T0), misses: 0, askedAt: iso(T0) });
    expect(await w.probeOf('europe-west1')).toEqual({ probedAt: iso(T0), misses: 0 });
  });

  it('gives a router 0.41.0 where to report, then settings.json whole with its ETag as S3 gives it when the router holds another; S3 read once a run', async () => {
    const w = world();
    const a = await w.add('europe-west2');
    const b = await w.add('us-central1');
    const doc = { workloads: { hibernate: true, joinMinutes: 10, defaults: { idleMinutes: 30 } }, updatedAt: iso(T0 - 3600 * S), updatedBy: 'admin@example.com' };
    w.s3.etag = '"9b2cf535f27731c974343645a3985328"';
    w.s3.text = JSON.stringify(doc);
    b.etag = w.s3.etag;
    await w.probe();
    expect(a.calls).toEqual([
      { action: 'manager-settings', events: EVENTS, refusals: true },
      { action: 'manager-settings', settings: doc, etag: '"9b2cf535f27731c974343645a3985328"', events: EVENTS, refusals: true },
    ]);
    expect(b.calls).toEqual([{ action: 'manager-settings', events: EVENTS, refusals: true }]);
    expect([a.events, b.events, a.etag]).toEqual([EVENTS, EVENTS, w.s3.etag]);
    expect([w.s3.heads, w.s3.gets]).toEqual([1, 1]);
    expect(w.logs).toContainEqual(['ManagerSettingsPushed', { router: 'dmtr-europe-west2', account: PROJECT, region: 'europe-west2', etag: w.s3.etag }]);
    expect(w.logs).toContainEqual(['ReportsAsked', { router: 'dmtr-us-central1', account: PROJECT, region: 'us-central1', version: '0.41.0' }]);
    expect(await w.probeOf('europe-west2')).toEqual({ probedAt: iso(T0), misses: 0, askedAt: iso(T0) });
  });

  it('gives a router where to report alone while settings.json does not exist', async () => {
    const w = world();
    const r = await w.add('europe-west2');
    await w.probe();
    expect(r.calls).toEqual([{ action: 'manager-settings', events: EVENTS, refusals: true }]);
    expect(w.s3.gets).toBe(0);
  });

  it('pushes a settings.json that is not JSON as its text, which the router reads as unset and says unreadable, as an AWS router does', async () => {
    const w = world();
    const r = await w.add('europe-west2');
    w.s3.etag = '"abc"';
    w.s3.text = '{"workloads": {';
    await w.probe();
    expect(r.calls[1]).toEqual({ action: 'manager-settings', settings: '{"workloads": {', etag: '"abc"', events: EVENTS, refusals: true });
  });

  it('without the routers\' reports, pushes settings.json alone', async () => {
    const w = world({ events: null });
    const r = await w.add('europe-west2');
    w.s3.etag = '"abc"';
    w.s3.text = '{}';
    await w.probe();
    expect(r.calls).toEqual([{ action: 'manager-settings', settings: {}, etag: '"abc"', refusals: true }]);
  });

  it('records a push the router refuses (over its 1 MiB body limit) with its reason, the router keeping its own copy, and pushes again at the next run', async () => {
    const w = world();
    const r = await w.add('europe-west2');
    r.etag = '"old"';
    w.s3.etag = '"new"';
    w.s3.text = JSON.stringify({ workloads: { hibernate: false } });
    r.answer = (p) => (p.settings !== undefined ? json(400, { error: 'the body is larger than 1048576 bytes', reason: 'bad-request' }) : undefined);
    await w.probe();
    const error = 'manager-settings: the body is larger than 1048576 bytes';
    expect(await w.probeOf('europe-west2')).toEqual({ probedAt: iso(T0), misses: 0, askedAt: iso(T0), lastError: error });
    expect(w.logs).toContainEqual(['RouterProbeFailed', { router: 'dmtr-europe-west2', account: PROJECT, region: 'europe-west2', step: 'manager-settings', error }]);
    w.clock.t += 5 * MIN;
    r.answer = undefined;
    await w.probe();
    expect(r.calls.map((c) => c.settings === undefined ? 'events' : 'settings')).toEqual(['events', 'settings', 'events', 'settings']);
    // Its grace runs from the first time it was given where to report.
    expect([r.etag, await w.probeOf('europe-west2')]).toEqual(['"new"', { probedAt: iso(T0 + 5 * MIN), misses: 0, askedAt: iso(T0) }]);
  });

  it('unregisters a router whose controller URL answers Google\'s own 404 (not the controller\'s JSON) twice running', async () => {
    const w = world();
    const r = await w.add('europe-west2');
    r.healthAnswer = GOOGLE_404;
    await w.probe();
    expect((await w.registry.list()).map((x) => x.region)).toEqual(['europe-west2']);
    expect(await w.probeOf('europe-west2')).toMatchObject({ misses: 1, lastError: expect.stringMatching(/^health: .*404/) });
    w.clock.t += 5 * MIN;
    await w.probe();
    expect(await w.registry.list()).toEqual([]);
    expect(w.logs).toContainEqual(['RouterUnregistered', {
      router: 'dmtr-europe-west2', account: PROJECT, region: 'europe-west2', reason: 'its controller URL answered Google\'s own 404 twice running: the router is uninstalled',
    }]);
    // Unregistered, it is probed no more.
    await w.probe();
    expect(r.healthReads).toBe(2);
  });

  it('keeps a router whose 404s are not in a row: an answer between them counts them again', async () => {
    const w = world();
    const r = await w.add('europe-west2');
    r.healthAnswer = GOOGLE_404;
    await w.probe();
    r.healthAnswer = undefined;
    await w.probe();
    expect(await w.probeOf('europe-west2')).toMatchObject({ misses: 0 });
    r.healthAnswer = GOOGLE_404;
    await w.probe();
    expect(await w.registry.list()).toHaveLength(1);
    expect(await w.probeOf('europe-west2')).toMatchObject({ misses: 1 });
  });

  it('counts the 404s again for a router registered again after its removal: a first probe without its controller\'s answer (Google\'s 403 while its grant propagates, a token refused, no answer) keeps it', async () => {
    vi.useFakeTimers({ now: T0 });
    const w = world({ now: () => Date.now() });
    const r = await w.add('europe-west2');
    r.healthAnswer = GOOGLE_404;
    await w.probe();
    await w.probe();
    expect(await w.registry.list()).toEqual([]);
    expect(await w.probeOf('europe-west2')).toMatchObject({ misses: 0 });
    // Installed again, discovery registers it again.
    await w.register(r);
    r.healthAnswer = { status: 403, text: '<html><title>403 Forbidden</title><h1>Error: Forbidden</h1></html>' };
    await w.probe();
    r.healthAnswer = undefined;
    r.throws = new GoogleError({ status: 403, reason: 'IAM_PERMISSION_DENIED', message: 'Permission \'iam.serviceAccounts.getOpenIdToken\' denied' });
    await w.probe();
    r.throws = undefined;
    r.delayMs = 11 * S;
    const silent = w.probe();
    await vi.advanceTimersByTimeAsync(15 * S);
    await silent;
    expect(await w.registry.list()).toHaveLength(1);
    expect(await w.probeOf('europe-west2')).toMatchObject({ misses: 0, lastError: 'health: no answer within 10000 ms' });
  });

  it('unregisters a router only at a probe Google answered with its own 404, never on a count kept from before', async () => {
    const w = world();
    const r = await w.add('europe-west2');
    await w.store.putProbe(PROJECT, 'europe-west2', { probedAt: iso(T0 - 5 * MIN), misses: 2 });
    r.throws = new GoogleError({ status: 404, reason: 'NOT_FOUND', message: 'Requested entity was not found.' });
    await w.probe();
    expect(await w.registry.list()).toHaveLength(1);
    expect(w.logs.map(([event]) => event)).not.toContain('RouterUnregistered');
  });

  it('counts Google\'s other answers at the controller URL (a 403: the service is there) as no 404 in a row', async () => {
    const w = world();
    const r = await w.add('europe-west2');
    r.healthAnswer = GOOGLE_404;
    await w.probe();
    r.healthAnswer = GOOGLE_403;
    await w.probe();
    expect(await w.probeOf('europe-west2')).toMatchObject({ misses: 0, lastError: expect.stringMatching(/^health: /) });
    r.healthAnswer = GOOGLE_404;
    await w.probe();
    expect(await w.registry.list()).toHaveLength(1);
  });

  it('removes a router after Google\'s 404 twice only while its registration still holds what the probe read: a controller URL rewritten by connect in between keeps it', async () => {
    const w = world();
    const r = await w.add('europe-west2');
    r.healthAnswer = GOOGLE_404;
    await w.probe();
    w.clock.t += 5 * MIN;
    const rewritten = { ...(await w.registry.list())[0]!, controller: 'https://dmtr-europe-west2-controller-new.europe-west2.run.app' };
    const health = r.health;
    r.health = async () => {
      w.dynamo.items.set(`ROUTER#${PROJECT}#europe-west2`, routerItem(rewritten));
      return health();
    };
    await w.probe();
    expect(await w.registry.list()).toEqual([rewritten]);
    expect(w.logs.map(([event]) => event)).not.toContain('RouterUnregistered');
    expect(w.logs).toContainEqual(['RouterKept', { router: 'dmtr-europe-west2', account: PROJECT, region: 'europe-west2', reason: 'its registration changed since the probe read it' }]);
  });

  // A router 0.40.0 cannot report (design §6.4): too-old, with the command that upgrades it; the advised install clears it at the
  // watchdog's next run, which gives it where to report.
  it('records a router below 0.41.0 too old with the install command, its version read from its health and kept, and pushes it nothing; upgraded, it is given where to report at the next run', async () => {
    const w = world();
    w.s3.etag = '"e1"';
    w.s3.text = '{"workloads":{"hibernate":false}}';
    const r = await w.add('europe-west2', { version: '' });
    r.version = '0.40.0';
    await w.probe();
    expect([r.healthReads, r.calls, w.s3.heads]).toEqual([1, [], 0]);
    expect((await w.registry.list()).map((x) => x.version)).toEqual(['0.40.0']);
    expect(w.logs).toContainEqual(['RouterVersionRead', { router: 'dmtr-europe-west2', account: PROJECT, region: 'europe-west2', from: '', version: '0.40.0' }]);
    expect(await w.probeOf('europe-west2')).toEqual({
      probedAt: iso(T0), misses: 0, tooOld: '0.40.0', lastRefusal: 'router_too_old',
      lastError: 'health: router 0.40.0 can\'t report to the manager: dormeto gcp routers install --project dormeto-dev --region europe-west2 --version 0.41.0',
    });
    // The advised install.
    r.version = '0.41.0';
    w.clock.t += 5 * MIN;
    await w.probe();
    expect(r.calls.map((c) => c.settings === undefined ? 'events' : 'settings')).toEqual(['events', 'settings']);
    expect((await w.registry.list()).map((x) => x.version)).toEqual(['0.41.0']);
    // Its grace runs from now: it could not report before.
    expect(await w.probeOf('europe-west2')).toEqual({ probedAt: iso(T0 + 5 * MIN), misses: 0, askedAt: iso(T0 + 5 * MIN) });
  });

  it('compares a dev router\'s version by major.minor.patch: 0.41.0-dev.1 is given where to report, 0.40.0-dev.3 is too old', async () => {
    const w = world();
    const dev = await w.add('europe-west2', { version: '0.41.0-dev.1' });
    const old = await w.add('us-central1', { version: '0.40.0-dev.3' });
    await w.probe();
    expect([dev.calls.length, old.calls.length]).toEqual([1, 0]);
    expect((await w.probeOf('us-central1'))!.tooOld).toBe('0.40.0-dev.3');
  });

  it('keeps a router\'s registration as it is when its health can\'t be read, and says why', async () => {
    const w = world();
    const r = await w.add('europe-west2', { version: '0.40.0' });
    r.healthAnswer = GOOGLE_403;
    await w.probe();
    expect((await w.registry.list()).map((x) => x.version)).toEqual(['0.40.0']);
    expect(await w.probeOf('europe-west2')).toEqual({
      probedAt: iso(T0), misses: 0, lastRefusal: 'no_access',
      lastError: 'health: the manager\'s accounts can\'t reach the router: dormeto gcp connect --project dormeto-host --profile <profile> --env dev (Google: dmtr-europe-west2-controller-dormeto-dev.europe-west2.run.app 403: 403 Forbidden)',
    });
  });

  it('writes a version it read only while the registration is still there: a disconnect\'s DELETE between the read and the write re-creates nothing', async () => {
    const w = world();
    const r = await w.add('europe-west2', { version: '0.40.0' });
    r.version = '0.41.0';
    const health = r.health;
    r.health = async () => {
      const answer = await health();
      await w.registry.delete(PROJECT, 'europe-west2');
      return answer;
    };
    await w.probe();
    expect(await w.registry.list()).toEqual([]);
    expect(w.logs).toContainEqual(['RouterVersionNotKept', { router: 'dmtr-europe-west2', account: PROJECT, region: 'europe-west2', version: '0.41.0', reason: 'its registration is gone' }]);
    expect(w.logs.map(([event]) => event)).not.toContain('RouterVersionRead');
  });

  it('never counts a broken connection (a token refused at STS or iamcredentials, even with a 404) as a router gone, and probes the other routers', async () => {
    const w = world();
    const broken = await w.add('europe-west2');
    const other = await w.add('us-central1');
    broken.throws = new GoogleError({ host: 'iamcredentials.googleapis.com', status: 404, reason: 'NOT_FOUND', message: 'Requested entity was not found.' });
    for (let i = 0; i < 3; i += 1) {
      await w.probe();
      w.clock.t += 5 * MIN;
    }
    expect((await w.registry.list()).map((x) => x.region).sort()).toEqual(['europe-west2', 'us-central1']);
    expect(await w.probeOf('europe-west2')).toMatchObject({
      misses: 0, lastRefusal: 'no_access',
      lastError: 'health: the manager\'s accounts can\'t reach the router: dormeto gcp connect --project dormeto-host --profile <profile> --env dev (Google: iamcredentials.googleapis.com 404 NOT_FOUND: Requested entity was not found.)',
    });
    expect(other.calls).toHaveLength(3);
  });

  // The watchdog says the refusal, with its command, instead of silent.
  it('keeps the code of the refusal its probe met, and clears it at a probe the router answers', async () => {
    const w = world();
    const r = await w.add('europe-west2');
    r.healthAnswer = GOOGLE_403;
    await w.probe();
    expect(await w.probeOf('europe-west2')).toMatchObject({ lastRefusal: 'no_access' });
    r.healthAnswer = undefined;
    w.clock.t += 5 * MIN;
    await w.probe();
    expect(await w.probeOf('europe-west2')).toEqual({ probedAt: iso(T0 + 5 * MIN), misses: 0, askedAt: iso(T0 + 5 * MIN) });
  });

  it('records router_unknown once for a registered router whose controller discovery hasn\'t found yet, without calling it', async () => {
    const w = world();
    const r = await w.add('europe-west2', { controller: '' });
    await w.probe();
    expect([r.calls.length, r.healthReads]).toEqual([0, 0]);
    expect(await w.probeOf('europe-west2')).toEqual({
      probedAt: iso(T0), misses: 0, lastRefusal: 'router_unknown',
      lastError: 'controller: discovery hasn\'t found this router\'s controller yet: dormeto gcp connect --project dormeto-host --profile <profile> --env dev again',
    });
    w.clock.t += 5 * MIN;
    await w.probe();
    expect((await w.probeOf('europe-west2'))!.probedAt).toBe(iso(T0));
  });

  it('probes nothing without a Google Cloud connection, and says so', async () => {
    const w = world();
    const r = await w.add('europe-west2');
    w.disconnect();
    expect(await w.probe()).toEqual({ routers: 1, probed: 0, left: 1 });
    expect(r.healthReads).toBe(0);
    expect(w.logs).toContainEqual(['RoutersNotProbed', { routers: 1, reason: 'no Google Cloud connection' }]);
  });

  it('gives up on a router silent for 10 s: its 404s in a row as they were', async () => {
    vi.useFakeTimers({ now: T0 });
    const w = world({ now: () => Date.now() });
    const r = await w.add('europe-west2');
    r.healthAnswer = GOOGLE_404;
    await w.probe();
    r.healthAnswer = undefined;
    r.delayMs = 11 * S;
    const run = w.probe();
    await vi.advanceTimersByTimeAsync(15 * S);
    await run;
    expect(await w.probeOf('europe-west2')).toMatchObject({ misses: 1, lastError: 'health: no answer within 10000 ms' });
  });

  it('probes 10 routers at once for at most 40 s a run, the least recently probed first: the routers left go first at the next run', async () => {
    vi.useFakeTimers({ now: T0 });
    const w = world({ now: () => Date.now() });
    const routers: FakeRouter[] = [];
    for (let i = 0; i < 200; i += 1) {
      const r = await w.add('europe-west2', { account: `proj-${String(i).padStart(3, '0')}` });
      r.delayMs = 3 * S;
      routers.push(r);
    }
    // 3 s each, 10 at once: the 14th ten starts at 39 s, the 15th would start after 40 s.
    const first = w.probe();
    await vi.advanceTimersByTimeAsync(60 * S);
    expect(await first).toEqual({ routers: 200, probed: 140, left: 60 });
    const left = routers.filter((r) => r.healthReads === 0).map((r) => r.controller);
    expect(left).toHaveLength(60);
    expect(w.logs).toContainEqual(['RoutersProbed', { routers: 200, probed: 140, left: 60, ms: 42 * S }]);
    const second = w.probe();
    await vi.advanceTimersByTimeAsync(60 * S);
    await second;
    expect(new Set(w.order.slice(140, 200))).toEqual(new Set(left));
  });
});
