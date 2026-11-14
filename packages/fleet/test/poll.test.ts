// The poll of the Google Cloud routers (Google Cloud manager design §6.3): every minute the fleet function calls each Google
// Cloud router (they push nothing), ingests its journal, its check and its rows as an AWS router's events, pushes the
// organization's settings, and unregisters a router uninstalled. The routers answer as R6's /v1/actions does (router
// 830e45f); the calls go through the real callRouter, with Google's token requests stubbed.
import { PutItemCommand } from '@aws-sdk/client-dynamodb';
import { GoogleError, type GoogleConnection } from '@dormeto/google';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeDynamo } from '../../discovery/test/dynamo-fake.js';
import { createIngest, type RouterEvent } from '../src/ingest.js';
import { createPoll } from '../src/poll.js';
import { createRegistry, routerItem, type InstalledRouter } from '../src/registry.js';
import { createFleetStore } from '../src/store.js';

const TABLE = 'dmt-dev-manager';
const PROJECT = 'dormeto-dev';
const T0 = Date.parse('2026-11-09T12:00:00.000Z');
const S = 1000;
const iso = (ms: number) => new Date(ms).toISOString();

const connection: GoogleConnection = {
  project: 'dormeto-host', projectNumber: '1034397096264', pool: 'dmt-dev', provider: 'aws', scopes: ['projects/dormeto-dev'],
  serviceAccounts: { discovery: 'dmt-dev-discovery@dormeto-host.iam.gserviceaccount.com', command: 'dmt-dev-command@dormeto-host.iam.gserviceaccount.com' },
  routers: [{ project: PROJECT, region: 'europe-west2' }], googleAdded: [], connectedAt: iso(T0 - 86_400 * S), connectedBy: 'admin@example.com', cli: '0.14.0',
};

type Payload = Record<string, any>;
type Answer = { status: number; text: string };
const json = (status: number, body: unknown): Answer => ({ status, text: JSON.stringify(body) });
// Google's own page for a Cloud Run URL it knows no service at: HTML, not the controller's JSON.
const GOOGLE_404: Answer = { status: 404, text: '<!DOCTYPE html>\n<html lang=en><meta charset=utf-8><title>Error 404 (Not Found)!!1</title><p><b>404.</b> <ins>That’s an error.</ins></html>' };
// A controller older than 0.40.0: its own JSON for a route it doesn't have.
const OWN_404 = json(404, { error: 'no route for POST /v1/actions', reason: 'not-found' });
// The router's check of `after` (actions.mjs).
const EVENT_ID = /^\d{13}-[a-z0-9-]+-[A-Z]+$/;

const check = (ms: number, over: Payload = {}) => ({
  checkedAt: iso(ms), durationMs: 850, checkSchedule: '*/5 * * * *', lastScheduledCheckAt: iso(ms), health: { status: 'ok', problems: [] }, pauses: [], counts: { AWAKE: 1 }, ...over,
});
const row = (workloadId: string, state: string, over: Payload = {}) => ({
  workloadId, name: `Name ${workloadId}`, state, source: 'cli', url: `https://${workloadId}.example.com/`, tags: { team: 'payments' }, backends: ['instance'],
  backendService: `projects/${PROJECT}/regions/europe-west2/backendServices/${workloadId}`, ...over,
});

// A Google Cloud router as its /v1/actions answers: its journal, its last check, its rows and the ETag of the organization's
// settings it holds; `answer` in place of any of them, `throws` before the call (Google's token refused), `delayMs` before
// it answers. Its GET /v1/health answers the version it runs (`version`), each read counted apart (`healthReads`).
function fakeRouter(project: string, region: string, order: string[]) {
  const r = {
    region,
    controller: `https://dmtr-${region}-controller-${project}.${region}.run.app`,
    journal: [] as Payload[],
    check: null as Payload | null,
    workloads: [] as Payload[],
    etag: null as string | null,
    settings: undefined as unknown,
    calls: [] as Payload[],
    answer: undefined as ((payload: Payload) => Answer | undefined) | undefined,
    throws: undefined as Error | undefined,
    delayMs: 0,
    version: '0.40.0',
    healthReads: 0,
    healthAnswer: undefined as Answer | undefined,
    // A transition as the journal holds it: its id, then AWS's Workload state changed detail.
    event(workloadId: string, from: string, to: string, ms: number, over: Payload = {}) {
      r.journal.push({ id: `${String(ms).padStart(13, '0')}-${workloadId}-${to}`, at: iso(ms), workloadId, from, to, router: `dmtr-${region}`, region, project, cause: 'idle', tags: {}, ...over });
    },
    async health(): Promise<Answer> {
      r.healthReads += 1;
      if (r.throws) throw r.throws;
      return r.healthAnswer ?? json(200, { version: r.version, project, region });
    },
    async respond(payload: Payload): Promise<Answer> {
      order.push(r.controller);
      r.calls.push(payload);
      if (r.delayMs) await new Promise((done) => setTimeout(done, r.delayMs));
      if (r.throws) throw r.throws;
      const own = r.answer?.(payload);
      if (own) return own;
      if (payload.action === 'events') {
        if ((payload.after !== null && !EVENT_ID.test(payload.after)) || !Number.isInteger(payload.limit) || payload.limit < 1 || payload.limit > 500) {
          return json(200, { refused: { code: 'invalid', message: 'after must be the id of an event, or null' } });
        }
        const page = [...r.journal].sort((a, b) => (a.id < b.id ? -1 : 1)).filter((e) => payload.after === null || e.id > payload.after).slice(0, payload.limit);
        return json(200, { events: page, next: page.length === payload.limit ? page.at(-1)!.id : null, check: r.check, managerSettings: { etag: r.etag } });
      }
      if (payload.action === 'list') {
        return json(200, { router: { name: `dmtr-${region}`, version: '0.40.0', build: 'b1', checkSchedule: '*/5 * * * *', lastScheduledCheckAt: r.check?.checkedAt ?? null, pauses: [] }, workloads: r.workloads });
      }
      if (payload.action === 'manager-settings') {
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

// The manager's side: its table, the registry, the real ingest and store, settings.json in S3 and the connection.
function world({ now, events }: { now?: () => number; events?: { url: string; audience: string } } = {}) {
  const clock = { t: T0 };
  const time = now ?? (() => clock.t);
  const dynamo = fakeDynamo();
  const store = createFleetStore({ dynamo, table: TABLE, now: time });
  const ingestOne = createIngest({ store, now: time });
  const ingested: RouterEvent[] = [];
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
  const poll = createPoll({
    store, registry, env: 'dev', routerVersion: '0.40.0', now: time, events,
    ingest: async (event) => {
      ingested.push(event);
      await ingestOne(event);
    },
    google: { current: async () => (connected ? { connection, google: { request } } : null) },
    settings: {
      etag: async () => (s3.heads++, s3.etag),
      read: async () => (s3.gets++, s3.etag ? { etag: s3.etag, text: s3.text } : null),
    },
    log: { info: (event, data) => logs.push([event, data as Payload]), warn: (event, data) => logs.push([event, data as Payload]) },
  });
  const register = async (r: FakeRouter, over: Partial<InstalledRouter> = {}) => {
    const router: InstalledRouter = {
      name: `dmtr-${r.region}`, account: PROJECT, region: r.region, controller: r.controller, onboarder: '', version: '0.40.0', build: '', installedBy: 'cli', cloud: 'gcp',
      installedAt: iso(T0 - 86_400 * S), ...over,
    };
    await dynamo.send(new PutItemCommand({ TableName: TABLE, Item: routerItem(router) }));
  };
  const add = async (region: string, over: Partial<InstalledRouter> = {}) => {
    const r = fakeRouter(over.account ?? PROJECT, region, order);
    routers.set(r.controller, r);
    await register(r, over);
    return r;
  };
  const pollOf = async (region: string, project = PROJECT) => (await store.routerPolls()).find((p) => p.account === project && p.region === region)?.poll ?? null;
  const history = async (region: string, id: string) => (await store.listHistory(PROJECT, region, id, iso(T0 - 86_400 * S), iso(T0 + 86_400 * S))).entries.map((e) => [e.from, e.to, e.at]);
  return { dynamo, store, registry, ingested, order, s3, logs, poll, add, register, clock, pollOf, history, disconnect: () => { connected = false; } };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the poll of Google Cloud routers', () => {
  it('ingests each event of a router\'s journal as Workload state changed under the router it called, its project and region, never the payload\'s', async () => {
    const w = world();
    const r = await w.add('europe-west2');
    r.event('web', 'AWAKE', 'NAPPING', T0 - 120 * S);
    r.event('web', 'NAPPING', 'ASLEEP', T0 - 60 * S, { region: 'us-central1', project: 'someone-else', router: 'dmtr-us-central1', hibernated: ['web-1'] });
    await w.poll();
    expect(r.calls).toEqual([{ action: 'events', after: null, limit: 500, refusals: true }]);
    expect(w.ingested.map((e) => [e.account, e.region, e['detail-type'], e.detail.router, e.detail.region, e.detail.to])).toEqual([
      [PROJECT, 'europe-west2', 'Workload state changed', 'dmtr-europe-west2', 'europe-west2', 'NAPPING'],
      [PROJECT, 'europe-west2', 'Workload state changed', 'dmtr-europe-west2', 'europe-west2', 'ASLEEP'],
    ]);
    expect(await w.store.getWorkload(PROJECT, 'europe-west2', 'web')).toMatchObject({ router: 'dmtr-europe-west2', state: 'ASLEEP', stateAt: iso(T0 - 60 * S), hibernated: true });
    expect(await w.store.getWorkload(PROJECT, 'us-central1', 'web')).toBeNull();
    expect(await w.history('europe-west2', 'web')).toEqual([['AWAKE', 'NAPPING', iso(T0 - 120 * S)], ['NAPPING', 'ASLEEP', iso(T0 - 60 * S)]]);
    expect(await w.pollOf('europe-west2')).toEqual({ newestAt: iso(T0 - 60 * S), misses: 0, polledAt: iso(T0) });
  });

  it('reads again from 5 minutes before the newest at it read: an event read twice is one history entry', async () => {
    const w = world();
    const r = await w.add('europe-west2');
    r.event('web', 'AWAKE', 'NAPPING', T0 - 60 * S);
    await w.poll();
    w.clock.t += 60 * S;
    r.event('web', 'NAPPING', 'ASLEEP', T0);
    await w.poll();
    // (T0 − 60 s) − 5 minutes in milliseconds, padded to 13 digits, then `-0-A`: an event id before every one of that millisecond.
    expect(r.calls[1]).toEqual({ action: 'events', after: '1794225240000-0-A', limit: 500, refusals: true });
    expect(w.ingested.filter((e) => e.detail.to === 'NAPPING')).toHaveLength(2);
    expect(await w.history('europe-west2', 'web')).toEqual([['AWAKE', 'NAPPING', iso(T0 - 60 * S)], ['NAPPING', 'ASLEEP', iso(T0)]]);
    expect(await w.pollOf('europe-west2')).toMatchObject({ newestAt: iso(T0), polledAt: iso(T0 + 60 * S) });
  });

  it('finds an event committed after a later one at the next poll: in the history, the summary not set back', async () => {
    const w = world();
    const r = await w.add('europe-west2');
    const t = T0 - 30 * S;
    r.event('web', 'NAPPING', 'ASLEEP', t + 1 * S);
    await w.poll();
    w.clock.t += 60 * S;
    // Its time was taken before the later one's, its transaction committed after it.
    r.event('web', 'AWAKE', 'NAPPING', t);
    await w.poll();
    expect(await w.history('europe-west2', 'web')).toEqual([['AWAKE', 'NAPPING', iso(t)], ['NAPPING', 'ASLEEP', iso(t + 1 * S)]]);
    expect(await w.store.getWorkload(PROJECT, 'europe-west2', 'web')).toMatchObject({ state: 'ASLEEP', stateAt: iso(t + 1 * S) });
  });

  it('leaves a summary as it is for an event older than its stateAt, and keeps the event in the history', async () => {
    const w = world();
    const r = await w.add('europe-west2');
    r.check = check(T0 - 30 * S);
    r.workloads = [row('web', 'AWAKE', { stateAt: iso(T0 - 40 * S) })];
    await w.poll();
    w.clock.t += 60 * S;
    r.event('web', 'AWAKE', 'NAPPING', T0 - 50 * S);
    await w.poll();
    expect(await w.store.getWorkload(PROJECT, 'europe-west2', 'web')).toMatchObject({ state: 'AWAKE', stateAt: iso(T0 - 40 * S) });
    expect(await w.history('europe-west2', 'web')).toContainEqual(['AWAKE', 'NAPPING', iso(T0 - 50 * S)]);
  });

  it('reads the journal page after page while the router says there is more', async () => {
    const w = world();
    const r = await w.add('europe-west2');
    for (let i = 0; i < 501; i += 1) r.event(`w${i}`, 'AWAKE', 'NAPPING', T0 - 600 * S + i);
    await w.poll();
    expect(r.calls.map((c) => c.after)).toEqual([null, `${T0 - 600 * S + 499}-w499-NAPPING`]);
    expect(w.ingested).toHaveLength(501);
    expect((await w.pollOf('europe-west2'))!.newestAt).toBe(iso(T0 - 600 * S + 500));
  });

  it('lists the router when its check is newer than its summary: its summary and its rows, in chunks of 1000; the same check is not listed again', async () => {
    const w = world();
    const r = await w.add('europe-west2');
    r.check = check(T0 - 30 * S, { counts: { AWAKE: 1001 } });
    r.workloads = Array.from({ length: 1001 }, (_, i) => row(`w${i}`, 'AWAKE'));
    await w.poll();
    expect(r.calls.map((c) => c.action)).toEqual(['events', 'list']);
    const chunks = w.ingested.filter((e) => e['detail-type'] === 'Router checked');
    expect(chunks.map((e) => [e.account, e.region, e.detail.router.region, e.detail.chunk, e.detail.workloads.length])).toEqual([
      [PROJECT, 'europe-west2', 'europe-west2', { index: 0, total: 2 }, 1000], [PROJECT, 'europe-west2', 'europe-west2', { index: 1, total: 2 }, 1],
    ]);
    expect((await w.store.getRouter(PROJECT, 'europe-west2'))!.summary).toMatchObject({
      account: PROJECT, region: 'europe-west2', name: 'dmtr-europe-west2', version: '0.40.0', build: 'b1', checkSchedule: '*/5 * * * *', checkedAt: iso(T0 - 30 * S),
      durationMs: 850, health: { status: 'ok', problems: [] }, counts: { AWAKE: 1001 }, check: { checkedAt: iso(T0 - 30 * S), total: 2, received: [0, 1] },
    });
    expect(await w.store.routerWorkloads(PROJECT, 'europe-west2')).toHaveLength(1001);
    expect(await w.store.getWorkload(PROJECT, 'europe-west2', 'w0')).toMatchObject({ source: 'cli', tags: { team: 'payments' }, backendService: row('w0', 'AWAKE').backendService, checkedAt: iso(T0 - 30 * S) });
    w.clock.t += 60 * S;
    await w.poll();
    expect(r.calls.map((c) => c.action)).toEqual(['events', 'list', 'events']);
    // A newer check: listed again, and the rows it no longer has removed.
    r.check = check(T0 + 90 * S);
    r.workloads = [row('w0', 'ASLEEP')];
    w.clock.t += 60 * S;
    await w.poll();
    expect(r.calls.map((c) => c.action)).toEqual(['events', 'list', 'events', 'events', 'list']);
    expect((await w.store.routerWorkloads(PROJECT, 'europe-west2')).map((x) => [x.workloadId, x.state])).toEqual([['w0', 'ASLEEP']]);
  });

  it('pushes settings.json whole, with its ETag as S3 gives it (quotes included), to a router holding another; S3 read once a run', async () => {
    const w = world();
    const a = await w.add('europe-west2');
    const b = await w.add('us-central1');
    // The largest organization document the API writes: custom types, a 256 KiB custom page and a 64 KiB icon.
    const types = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`batch-${i}`, { idleMinutes: 60, waitSeconds: 30 }]));
    const page = { html: `<html>${'x'.repeat(256 * 1024 - 13)}</html>`, icon: `data:image/png;base64,${Buffer.alloc(64 * 1024).toString('base64')}` };
    const doc = { workloads: { hibernate: true, joinMinutes: 10, defaults: { idleMinutes: 30 }, types }, waitingPage: page, updatedAt: iso(T0 - 3600 * S), updatedBy: 'admin@example.com' };
    w.s3.etag = '"9b2cf535f27731c974343645a3985328"';
    w.s3.text = JSON.stringify(doc);
    b.etag = w.s3.etag;
    await w.poll();
    expect(a.calls.map((c) => c.action)).toEqual(['events', 'manager-settings']);
    expect(a.calls[1]).toEqual({ action: 'manager-settings', settings: doc, etag: '"9b2cf535f27731c974343645a3985328"', refusals: true });
    expect(Buffer.byteLength(JSON.stringify(a.calls[1]))).toBeLessThan(1024 * 1024);
    expect(b.calls.map((c) => c.action)).toEqual(['events']);
    expect([w.s3.heads, w.s3.gets]).toEqual([1, 1]);
    expect([(await w.pollOf('europe-west2'))!.etag, (await w.pollOf('us-central1'))!.etag]).toEqual([w.s3.etag, w.s3.etag]);
    expect(w.logs).toContainEqual(['ManagerSettingsPushed', { router: 'dmtr-europe-west2', account: PROJECT, region: 'europe-west2', etag: w.s3.etag }]);
    w.clock.t += 60 * S;
    await w.poll();
    expect(a.calls.map((c) => c.action)).toEqual(['events', 'manager-settings', 'events']);
    expect([w.s3.heads, w.s3.gets]).toEqual([2, 1]);
  });

  it('pushes a settings.json that is not JSON as its text, which the router reads as unset and says unreadable, as an AWS router does', async () => {
    const w = world();
    const r = await w.add('europe-west2');
    w.s3.etag = '"abc"';
    w.s3.text = '{"workloads": {';
    await w.poll();
    expect(r.calls[1]).toEqual({ action: 'manager-settings', settings: '{"workloads": {', etag: '"abc"', refusals: true });
  });

  // Until the poll ends (M39), what it pushes says where a router 0.41.0 reports (router push design §4.1).
  it('pushes with the settings where to report, when the manager has the relay', async () => {
    const events = { url: 'https://abc123.execute-api.eu-west-1.amazonaws.com/routers/events', audience: 'https://abc123.execute-api.eu-west-1.amazonaws.com' };
    const w = world({ events });
    const r = await w.add('europe-west2');
    w.s3.etag = '"abc"';
    w.s3.text = '{}';
    await w.poll();
    expect(r.calls[1]).toEqual({ action: 'manager-settings', settings: {}, etag: '"abc"', events, refusals: true });
  });

  it('records a push the router refuses (over its 1 MiB body limit) with its reason, the router keeping its own copy, and tries again at the next poll', async () => {
    const w = world();
    const r = await w.add('europe-west2');
    r.etag = '"old"';
    w.s3.etag = '"new"';
    w.s3.text = JSON.stringify({ workloads: { hibernate: false } });
    r.answer = (p) => (p.action === 'manager-settings' ? json(400, { error: 'the body is larger than 1048576 bytes', reason: 'bad-request' }) : undefined);
    await w.poll();
    const error = 'manager-settings: the body is larger than 1048576 bytes';
    expect(await w.pollOf('europe-west2')).toEqual({ newestAt: null, misses: 0, polledAt: iso(T0), etag: '"old"', lastError: error });
    expect(w.logs).toContainEqual(['RouterPollFailed', { router: 'dmtr-europe-west2', account: PROJECT, region: 'europe-west2', step: 'manager-settings', error }]);
    w.clock.t += 60 * S;
    r.answer = undefined;
    await w.poll();
    expect(r.calls.map((c) => c.action)).toEqual(['events', 'manager-settings', 'events', 'manager-settings']);
    expect(await w.pollOf('europe-west2')).toEqual({ newestAt: null, misses: 0, polledAt: iso(T0 + 60 * S), etag: '"new"' });
  });

  it('unregisters a router whose controller URL answers Google\'s own 404 (not the controller\'s JSON) twice in a row', async () => {
    const w = world();
    const r = await w.add('europe-west2');
    r.answer = () => GOOGLE_404;
    await w.poll();
    expect((await w.registry.list()).map((x) => x.region)).toEqual(['europe-west2']);
    expect(await w.pollOf('europe-west2')).toMatchObject({ misses: 1, lastError: expect.stringMatching(/^events: .*404/) });
    w.clock.t += 60 * S;
    await w.poll();
    expect(await w.registry.list()).toEqual([]);
    expect(w.logs).toContainEqual(['RouterUnregistered', {
      router: 'dmtr-europe-west2', account: PROJECT, region: 'europe-west2', reason: 'its controller URL answered Google\'s own 404 twice in a row: the router is uninstalled',
    }]);
    // Unregistered, it is polled no more.
    await w.poll();
    expect(r.calls).toHaveLength(2);
  });

  it('keeps a router whose 404s are not in a row: an answer between them counts them again', async () => {
    const w = world();
    const r = await w.add('europe-west2');
    r.answer = () => GOOGLE_404;
    await w.poll();
    r.answer = undefined;
    await w.poll();
    expect(await w.pollOf('europe-west2')).toMatchObject({ misses: 0 });
    r.answer = () => GOOGLE_404;
    await w.poll();
    expect(await w.registry.list()).toHaveLength(1);
    expect(await w.pollOf('europe-west2')).toMatchObject({ misses: 1 });
  });

  it('counts the 404s again for a router registered again after its removal: a first poll without its controller\'s answer (Google\'s 403 while its grant propagates, a token refused, no answer) keeps it', async () => {
    vi.useFakeTimers({ now: T0 });
    const w = world({ now: () => Date.now() });
    const r = await w.add('europe-west2');
    r.answer = () => GOOGLE_404;
    await w.poll();
    await w.poll();
    expect(await w.registry.list()).toEqual([]);
    expect(await w.pollOf('europe-west2')).toMatchObject({ misses: 0 });
    // Installed again, discovery registers it again.
    await w.register(r);
    r.answer = () => ({ status: 403, text: '<html><title>403 Forbidden</title><h1>Error: Forbidden</h1></html>' });
    await w.poll();
    r.answer = undefined;
    r.throws = new GoogleError({ status: 403, reason: 'IAM_PERMISSION_DENIED', message: 'Permission \'iam.serviceAccounts.getOpenIdToken\' denied' });
    await w.poll();
    r.throws = undefined;
    r.delayMs = 11 * S;
    const silent = w.poll();
    await vi.advanceTimersByTimeAsync(15 * S);
    await silent;
    expect(await w.registry.list()).toHaveLength(1);
    expect(await w.pollOf('europe-west2')).toMatchObject({ misses: 0, lastError: 'events: no answer within 10000 ms' });
  });

  it('unregisters a router only at a poll Google answered with its own 404, never on a count kept from before', async () => {
    const w = world();
    const r = await w.add('europe-west2');
    await w.store.putPoll(PROJECT, 'europe-west2', { newestAt: null, misses: 2, polledAt: iso(T0 - 60 * S) });
    r.throws = new GoogleError({ status: 404, reason: 'NOT_FOUND', message: 'Requested entity was not found.' });
    await w.poll();
    expect(await w.registry.list()).toHaveLength(1);
    expect(w.logs.map(([event]) => event)).not.toContain('RouterUnregistered');
  });

  it('counts Google\'s other answers at the controller URL (a 403: the service is there) as no 404 in a row', async () => {
    const w = world();
    const r = await w.add('europe-west2');
    r.answer = () => GOOGLE_404;
    await w.poll();
    r.answer = () => ({ status: 403, text: '<html><title>403 Forbidden</title></html>' });
    await w.poll();
    expect(await w.pollOf('europe-west2')).toMatchObject({ misses: 0, lastError: expect.stringMatching(/^events: /) });
    r.answer = () => GOOGLE_404;
    await w.poll();
    expect(await w.registry.list()).toHaveLength(1);
  });

  it('writes a version it read only while the registration is still there: a disconnect\'s DELETE between the read and the write re-creates nothing', async () => {
    const w = world();
    const r = await w.add('europe-west2', { version: '0.39.0' });
    r.version = '0.39.0';
    const health = r.health;
    r.version = '0.40.0';
    r.health = async () => {
      const answer = await health();
      await w.registry.delete(PROJECT, 'europe-west2');
      return answer;
    };
    await w.poll();
    expect(await w.registry.list()).toEqual([]);
    expect(w.logs).toContainEqual(['RouterVersionNotKept', { router: 'dmtr-europe-west2', account: PROJECT, region: 'europe-west2', version: '0.40.0', reason: 'its registration is gone' }]);
    expect(w.logs.map(([event]) => event)).not.toContain('RouterVersionRead');
  });

  it('removes a router after Google\'s 404 twice only while its registration still holds what the poll read: a controller URL rewritten by connect in between keeps it', async () => {
    const w = world();
    const r = await w.add('europe-west2');
    r.answer = () => GOOGLE_404;
    await w.poll();
    w.clock.t += 60 * S;
    const rewritten = { ...(await w.registry.list())[0]!, controller: 'https://dmtr-europe-west2-controller-new.europe-west2.run.app' };
    r.answer = () => {
      w.dynamo.items.set(`ROUTER#${PROJECT}#europe-west2`, routerItem(rewritten));
      return GOOGLE_404;
    };
    await w.poll();
    expect(await w.registry.list()).toEqual([rewritten]);
    expect(w.logs.map(([event]) => event)).not.toContain('RouterUnregistered');
    expect(w.logs).toContainEqual(['RouterKept', { router: 'dmtr-europe-west2', account: PROJECT, region: 'europe-west2', reason: 'its registration changed since the poll read it' }]);
  });

  it('keeps a router whose controller answers its own JSON 404 (older than 0.40.0), and calls it again only once its version changes', async () => {
    const w = world();
    const r = await w.add('europe-west2', { version: '' });
    r.answer = () => OWN_404;
    r.version = '0.39.0';
    await w.poll();
    expect(await w.pollOf('europe-west2')).toEqual({
      newestAt: null, misses: 0, polledAt: iso(T0), tooOld: '', lastRefusal: 'router_too_old',
      lastError: 'events: router older than 0.40.0 can\'t report to the manager: dormeto gcp routers install --project dormeto-dev --region europe-west2 --version 0.40.0',
    });
    // Not called again: its version is read from its health instead, and kept in the registry.
    w.clock.t += 60 * S;
    await w.poll();
    expect([r.calls.length, r.healthReads]).toEqual([1, 1]);
    expect((await w.registry.list()).map((x) => x.version)).toEqual(['0.39.0']);
    expect(await w.pollOf('europe-west2')).toEqual({
      newestAt: null, misses: 0, polledAt: iso(T0), tooOld: '', versionAt: iso(T0 + 60 * S), lastRefusal: 'router_too_old',
      lastError: 'version: router 0.39.0 can\'t report to the manager: dormeto gcp routers install --project dormeto-dev --region europe-west2 --version 0.40.0',
    });
    // Upgraded: discovery reads its new version.
    r.answer = undefined;
    await w.register(r, { version: '0.40.0' });
    await w.poll();
    expect(r.calls).toHaveLength(2);
    expect(await w.pollOf('europe-west2')).toEqual({ newestAt: null, misses: 0, polledAt: iso(T0 + 60 * S) });
  });

  // The advised `dormeto gcp routers install` clears too-old within 10 minutes: the registry learnt versions only from discovery
  // (every 24 hours) and connect.
  it('reads a too-old router\'s version from its health at most every 10 minutes, keeps it in the registry, and polls it at the next run once it is 0.40.0 or later', async () => {
    const w = world();
    const r = await w.add('europe-west2', { version: '0.39.0' });
    r.version = '0.39.0';
    await w.poll();
    expect([r.healthReads, r.calls.length]).toEqual([1, 0]);
    expect(await w.pollOf('europe-west2')).toMatchObject({ versionAt: iso(T0), lastError: 'version: router 0.39.0 can\'t report to the manager: dormeto gcp routers install --project dormeto-dev --region europe-west2 --version 0.40.0' });
    // The advised install: the router runs 0.40.0, the registry still says 0.39.0.
    r.version = '0.40.0';
    for (let minute = 1; minute < 10; minute += 1) {
      w.clock.t = T0 + minute * 60 * S;
      await w.poll();
    }
    expect([r.healthReads, r.calls.length]).toEqual([1, 0]);
    w.clock.t = T0 + 10 * 60 * S;
    await w.poll();
    expect([r.healthReads, r.calls.length]).toEqual([2, 0]);
    expect((await w.registry.list()).map((x) => x.version)).toEqual(['0.40.0']);
    expect(w.logs).toContainEqual(['RouterVersionRead', { router: 'dmtr-europe-west2', account: PROJECT, region: 'europe-west2', from: '0.39.0', version: '0.40.0' }]);
    w.clock.t += 60 * S;
    r.check = check(w.clock.t - 30 * S);
    r.workloads = [row('web', 'AWAKE')];
    await w.poll();
    expect(r.calls.map((c) => c.action)).toEqual(['events', 'list']);
    expect(r.healthReads).toBe(2);
    expect(await w.pollOf('europe-west2')).toEqual({ newestAt: null, misses: 0, polledAt: iso(w.clock.t) });
    expect(await w.store.getWorkload(PROJECT, 'europe-west2', 'web')).toMatchObject({ state: 'AWAKE' });
  });

  it('pushes settings.json to no router too old to poll: it only reads its version', async () => {
    const w = world();
    w.s3.etag = '"e1"';
    w.s3.text = '{"workloads":{"hibernate":false}}';
    const r = await w.add('europe-west2', { version: '0.39.0' });
    r.version = '0.39.0';
    await w.poll();
    expect([r.calls, r.settings, w.s3.heads, w.s3.gets, r.healthReads]).toEqual([[], undefined, 0, 0, 1]);
  });

  it('keeps a too-old router\'s registration as it is when its health can\'t be read, says why, and reads it again 10 minutes later', async () => {
    const w = world();
    const r = await w.add('europe-west2', { version: '0.39.0' });
    r.healthAnswer = { status: 403, text: '<html><title>403 Forbidden</title></html>' };
    await w.poll();
    expect((await w.registry.list()).map((x) => x.version)).toEqual(['0.39.0']);
    expect(await w.pollOf('europe-west2')).toMatchObject({
      versionAt: iso(T0), lastError: 'version: the manager\'s accounts can\'t reach the router: dormeto gcp connect --project dormeto-host --profile <profile> --env dev (Google: dmtr-europe-west2-controller-dormeto-dev.europe-west2.run.app 403: 403 Forbidden)',
    });
    w.clock.t += 9 * 60 * S;
    await w.poll();
    expect(r.healthReads).toBe(1);
    w.clock.t += 60 * S;
    await w.poll();
    expect(r.healthReads).toBe(2);
  });

  it('never counts a broken connection (a token refused at STS or iamcredentials, even with a 404) as a router gone, and polls the other routers', async () => {
    const w = world();
    const broken = await w.add('europe-west2');
    const other = await w.add('us-central1');
    broken.throws = new GoogleError({ host: 'iamcredentials.googleapis.com', status: 404, reason: 'NOT_FOUND', message: 'Requested entity was not found.' });
    other.event('web', 'AWAKE', 'NAPPING', T0 - 60 * S);
    for (let i = 0; i < 3; i += 1) {
      await w.poll();
      w.clock.t += 60 * S;
    }
    expect((await w.registry.list()).map((x) => x.region).sort()).toEqual(['europe-west2', 'us-central1']);
    expect(await w.pollOf('europe-west2')).toMatchObject({
      misses: 0, lastError: 'events: the manager\'s accounts can\'t reach the router: dormeto gcp connect --project dormeto-host --profile <profile> --env dev (Google: iamcredentials.googleapis.com 404 NOT_FOUND: Requested entity was not found.)',
    });
    expect(await w.store.getWorkload(PROJECT, 'us-central1', 'web')).toMatchObject({ state: 'NAPPING' });
  });

  it('polls a dev router of 0.40.0 (0.40.0-dev.1), and only reads the version of one of 0.39.0 (0.39.0-dev.3)', async () => {
    const w = world();
    const dev = await w.add('europe-west2', { version: '0.40.0-dev.1' });
    const old = await w.add('us-central1', { version: '0.39.0-dev.3' });
    old.version = '0.39.0-dev.3';
    await w.poll();
    expect([dev.calls.length, dev.healthReads, old.calls.length, old.healthReads]).toEqual([1, 0, 0, 1]);
    expect((await w.registry.list()).map((r) => r.version).sort()).toEqual(['0.39.0-dev.3', '0.40.0-dev.1']);
  });

  it('polls only the Google Cloud routers with a controller, at 0.40.0 or later or an unknown version', async () => {
    const w = world();
    const current = await w.add('europe-west2');
    const unknown = await w.add('europe-west1', { version: '' });
    const old = await w.add('us-central1', { version: '0.39.0' });
    const undiscovered = await w.add('us-east1', { controller: '' });
    await w.dynamo.send(new PutItemCommand({
      TableName: TABLE, Item: routerItem({
        name: 'dmtr-dev', account: '121014831971', region: 'eu-west-3', controller: 'arn:aws:lambda:eu-west-3:121014831971:function:dmtr-dev-controller', onboarder: '', version: '0.40.0',
        build: '', installedBy: 'admin@example.com', installedAt: iso(T0),
      }),
    }));
    await w.poll();
    expect([current, unknown, old, undiscovered].map((r) => r.calls.length)).toEqual([1, 1, 0, 0]);
    expect(await w.pollOf('eu-west-3', '121014831971')).toBeNull();
  });

  // The watchdog says the refusal, with its command, instead of silent.
  it('keeps the code of the refusal its poll met, and clears it at a poll the router answers', async () => {
    const w = world();
    const r = await w.add('europe-west2');
    r.answer = () => ({ status: 403, text: '<html><title>403 Forbidden</title></html>' });
    await w.poll();
    expect(await w.pollOf('europe-west2')).toEqual({
      newestAt: null, misses: 0, polledAt: iso(T0), lastRefusal: 'no_access',
      lastError: 'events: the manager\'s accounts can\'t reach the router: dormeto gcp connect --project dormeto-host --profile <profile> --env dev (Google: dmtr-europe-west2-controller-dormeto-dev.europe-west2.run.app 403: 403 Forbidden)',
    });
    r.answer = undefined;
    w.clock.t += 60 * S;
    await w.poll();
    expect(await w.pollOf('europe-west2')).toEqual({ newestAt: null, misses: 0, polledAt: iso(T0 + 60 * S) });
  });

  // A poll written by an earlier build holds the refusal in its old spelling.
  it('reads a stored refusal in its old spelling as the new one, and does not poll again a router whose controller is unknown', async () => {
    const w = world();
    const r = await w.add('europe-west2', { controller: '' });
    const old = { newestAt: null, misses: 0, polledAt: iso(T0), lastRefusal: 'router-unknown', lastError: 'controller: x' };
    await w.store.putPoll(PROJECT, 'europe-west2', old as never);
    expect((await w.pollOf('europe-west2'))!.lastRefusal).toBe('router_unknown');
    await w.store.putPoll(PROJECT, 'europe-west2', { ...old, lastRefusal: 'manager-access-missing' } as never);
    expect((await w.pollOf('europe-west2'))!.lastRefusal).toBe('no_access');
    await w.store.putPoll(PROJECT, 'europe-west2', { ...old, lastRefusal: 'router-too-old' } as never);
    expect((await w.pollOf('europe-west2'))!.lastRefusal).toBe('router_too_old');
    await w.store.putPoll(PROJECT, 'europe-west2', old as never);
    await w.poll();
    expect([r.calls.length, (await w.pollOf('europe-west2'))!.polledAt]).toEqual([0, iso(T0)]);
  });

  it('records router_unknown once for a registered router whose controller discovery hasn\'t found yet, without calling it', async () => {
    const w = world();
    const r = await w.add('europe-west2', { controller: '' });
    await w.poll();
    expect([r.calls.length, r.healthReads]).toEqual([0, 0]);
    expect(await w.pollOf('europe-west2')).toEqual({
      newestAt: null, misses: 0, polledAt: iso(T0), lastRefusal: 'router_unknown',
      lastError: 'controller: discovery hasn\'t found this router\'s controller yet: dormeto gcp connect --project dormeto-host --profile <profile> --env dev again',
    });
    w.clock.t += 60 * S;
    await w.poll();
    expect((await w.pollOf('europe-west2'))!.polledAt).toBe(iso(T0));
  });

  it('polls nothing without a Google Cloud connection, and says so', async () => {
    const w = world();
    const r = await w.add('europe-west2');
    w.disconnect();
    expect(await w.poll()).toEqual({ routers: 1, polled: 0, left: 1 });
    expect(r.calls).toEqual([]);
    expect(w.logs).toContainEqual(['RoutersNotPolled', { routers: 1, reason: 'no Google Cloud connection' }]);
  });

  it('gives up on a router silent for 10 s: its 404s in a row as they were', async () => {
    vi.useFakeTimers({ now: T0 });
    const w = world({ now: () => Date.now() });
    const r = await w.add('europe-west2');
    r.answer = () => GOOGLE_404;
    await w.poll();
    r.answer = undefined;
    r.delayMs = 11 * S;
    const run = w.poll();
    await vi.advanceTimersByTimeAsync(15 * S);
    await run;
    expect(await w.pollOf('europe-west2')).toMatchObject({ misses: 1, lastError: 'events: no answer within 10000 ms' });
  });

  it('polls 10 routers at once for at most 50 s a run, the least recently polled first: the routers left go first at the next run', async () => {
    vi.useFakeTimers({ now: T0 });
    const w = world({ now: () => Date.now() });
    const routers: FakeRouter[] = [];
    for (let i = 0; i < 200; i += 1) {
      const r = await w.add('europe-west2', { account: `proj-${String(i).padStart(3, '0')}` });
      r.delayMs = 3 * S;
      routers.push(r);
    }
    // 3 s each, 10 at once: the 17th ten starts at 48 s, the 18th would start after 50 s.
    const first = w.poll();
    await vi.advanceTimersByTimeAsync(60 * S);
    expect(await first).toEqual({ routers: 200, polled: 170, left: 30 });
    const left = routers.filter((r) => r.calls.length === 0).map((r) => r.controller);
    expect(left).toHaveLength(30);
    expect(w.logs).toContainEqual(['RoutersPolled', { routers: 200, polled: 170, left: 30, ms: 51 * S }]);
    const second = w.poll();
    await vi.advanceTimersByTimeAsync(60 * S);
    await second;
    expect(new Set(w.order.slice(170, 200))).toEqual(new Set(left));
  });
});
