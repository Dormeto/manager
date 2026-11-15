// The reports of the Google Cloud routers (router credentials design 2026-11-15 §4; router push design 2026-11-14 §6.2): a
// router puts its events on the manager's bus itself, with the manager's credentials, as `dormeto.router.gcp/<project>/<region>`
// (its session can put no other source), its detail its own. The fleet function reads such an event only from the manager's
// own account and for a router registered, ingests it as an AWS router's (under the source's project and region), and pushes
// the organization's settings when a check says its router holds another ETag than settings.json's.
import { GoogleError, type GoogleConnection } from '@dormeto/google';
import { describe, expect, it } from 'vitest';
import { fakeDynamo } from '../../discovery/test/dynamo-fake.js';
import { bySource, createGoogleReports, createSettingsPush, googleEvent, googleSourceOf } from '../src/google-report.js';
import { createIngest, type RouterEvent } from '../src/ingest.js';
import { createRegistry, type InstalledRouter } from '../src/registry.js';
import { createFleetStore } from '../src/store.js';

const TABLE = 'dmt-dev-manager';
const OWN = '121014831971';
const PROJECT = 'dormeto-dev';
const REGION = 'europe-west2';
const CONTROLLER = 'https://dmtr-europe-west2-controller-abc123-nw.a.run.app';
const EVENTS = { url: 'https://abc123.execute-api.eu-west-1.amazonaws.com/routers/credentials', audience: 'https://abc123.execute-api.eu-west-1.amazonaws.com' };
const T0 = Date.parse('2026-11-14T12:00:00.000Z');
const S = 1000;
const iso = (ms: number) => new Date(ms).toISOString();
type Json = Record<string, any>;

const connection: GoogleConnection = {
  project: 'dormeto-host', projectNumber: '1034397096264', pool: 'dmt-dev', provider: `aws-${OWN}`, scopes: ['projects/dormeto-dev'],
  serviceAccounts: { discovery: 'dmt-dev-discovery@dormeto-host.iam.gserviceaccount.com', command: 'dmt-dev-command@dormeto-host.iam.gserviceaccount.com' },
  routers: [{ project: PROJECT, region: REGION }], googleAdded: [], connectedAt: iso(T0 - 86_400 * S), connectedBy: 'cli', cli: '0.15.0',
};

const row = (workloadId: string, state: string, over: Json = {}) => ({
  workloadId, name: `Name ${workloadId}`, state, source: 'cli', url: `https://${workloadId}.example.com/`, tags: { team: 'payments' }, backends: ['instance'],
  backendService: `projects/${PROJECT}/regions/${REGION}/backendServices/${workloadId}`, ...over,
});
// A Router checked as a Google Cloud router 0.41.0 reports it: AWS's detail plus the ETag it holds.
const checked = (ms: number, workloads: Json[], chunk = { index: 0, total: 1 }, etag: string | null = '"current"', over: Json = {}) => ({
  router: { name: `dmtr-${REGION}`, version: '0.41.0', build: 'b1', checkSchedule: '*/5 * * * *', region: REGION },
  checkedAt: iso(ms), durationMs: 850, health: { status: 'ok', problems: [] }, pauses: [], counts: { AWAKE: workloads.length }, chunk, workloads,
  managerSettings: { etag }, ...over,
});
// What EventBridge hands the queue for a router's entry: the envelope's account is the caller's, the manager's (the role the
// router's session assumes is the manager's).
const SOURCE = googleSourceOf(PROJECT, REGION);
const relayed = (detailType: string, detail: Json, { account = OWN, source = SOURCE } = {}) => ({
  version: '0', id: 'e-1', source, account, region: 'eu-west-1', time: iso(T0), resources: [], 'detail-type': detailType, detail,
});

// `registered`: the router of PROJECT and REGION is in the registry from the start.
function world({ registered = true } = {}) {
  const dynamo = fakeDynamo();
  const store = createFleetStore({ dynamo, table: TABLE, now: () => T0 });
  const ingestOne = createIngest({ store, now: () => T0 });
  const ingested: RouterEvent[] = [];
  const registry = createRegistry({ dynamo, table: TABLE });
  const logs: [string, Json][] = [];
  const log = { info: (event: string, data: object) => logs.push([event, data as Json]), warn: (event: string, data: object) => logs.push([event, data as Json]) };
  const s3 = { etag: '"current"' as string | null, text: '{"workloads":{"hibernate":false}}', heads: 0, gets: 0 };
  const calls: { method: string; url: string; body: Json }[] = [];
  const google = { answer: (_body: Json): Response | Error => new Response(JSON.stringify({ etag: 'stored' }), { status: 200, headers: { 'content-type': 'application/json' } }) };
  const request = async (_sa: string, _audience: string, method: string, url: string, body?: unknown) => {
    calls.push({ method, url, body: body as Json });
    const answer = google.answer(body as Json);
    if (answer instanceof Error) throw answer;
    return { status: answer.status, text: await answer.text() };
  };
  const push = createSettingsPush({
    settings: { etag: async () => (s3.heads++, s3.etag), read: async () => (s3.gets++, s3.etag ? { etag: s3.etag, text: s3.text } : null) },
    registry, google: { current: async () => ({ connection, google: { request } }) }, events: EVENTS, log,
  });
  const reports = createGoogleReports({
    ownAccount: OWN, registry, log, push,
    ingest: async (event) => {
      ingested.push(event);
      await ingestOne(event);
    },
  });
  const register = (over: Partial<InstalledRouter> = {}) => registry.put({
    name: `dmtr-${REGION}`, account: PROJECT, region: REGION, controller: CONTROLLER, onboarder: '', version: '0.41.0', build: '', installedBy: 'cli', cloud: 'gcp',
    installedAt: iso(T0 - 86_400 * S), ...over,
  });
  const ready = registered ? register() : Promise.resolve();
  const report = async (event: Parameters<typeof reports>[0]) => {
    await ready;
    return reports(event);
  };
  return { store, ingestOne, ingested, logs, s3, calls, google, report, register, registry };
}

describe('a Google Cloud router\'s events, put on the manager\'s bus by the router', () => {
  it('ingests a Workload state changed under the source\'s project and region and the router as registered, never what the detail says', async () => {
    const w = world();
    await w.report(relayed('Workload state changed', {
      at: iso(T0 - 60 * S), workloadId: 'web', from: 'NAPPING', to: 'ASLEEP', cause: 'idle', tags: {}, hibernated: ['web-1'],
      region: 'us-central1', project: 'someone-else', router: 'dmtr-us-central1',
    }));
    expect(w.ingested.map((e) => [e.account, e.region, e['detail-type'], e.detail.router, e.detail.region, e.detail.to])).toEqual([
      [PROJECT, REGION, 'Workload state changed', `dmtr-${REGION}`, REGION, 'ASLEEP'],
    ]);
    expect(await w.store.getWorkload(PROJECT, REGION, 'web')).toMatchObject({ router: `dmtr-${REGION}`, state: 'ASLEEP', stateAt: iso(T0 - 60 * S), hibernated: true });
    expect(await w.store.getWorkload(PROJECT, 'us-central1', 'web')).toBeNull();
  });

  it('ingests a Router checked as an AWS router\'s: its rows with their backend services and source cli, under the source\'s project and region', async () => {
    const w = world();
    await w.report(relayed('Router checked', checked(T0 - 10 * S, [row('web', 'AWAKE'), row('shop', 'ASLEEP')], undefined, undefined, {
      router: { name: 'dmtr-elsewhere', version: '0.41.0', build: 'b1', checkSchedule: '*/5 * * * *', region: 'us-central1' },
    })));
    expect(w.ingested.map((e) => [e.account, e.region, e.detail.router.name, e.detail.router.region])).toEqual([[PROJECT, REGION, `dmtr-${REGION}`, REGION]]);
    expect(await w.store.getRouter(PROJECT, REGION)).toMatchObject({ summary: { name: `dmtr-${REGION}`, version: '0.41.0', checkedAt: iso(T0 - 10 * S) } });
    expect(await w.store.getWorkload(PROJECT, REGION, 'web')).toMatchObject({
      router: `dmtr-${REGION}`, state: 'AWAKE', source: 'cli', backendService: `projects/${PROJECT}/regions/${REGION}/backendServices/web`,
    });
    expect(await w.store.getWorkload(PROJECT, 'us-central1', 'web')).toBeNull();
  });

  it('maps a router\'s detail to an AWS router\'s: the journal entry without its id, the router\'s block named and placed by its registration', () => {
    expect(googleEvent({ account: PROJECT, region: REGION, name: `dmtr-${REGION}` }, 'Workload state changed', { id: '1794225240000-web-ASLEEP', workloadId: 'web', to: 'ASLEEP', region: 'x' })).toEqual({
      account: PROJECT, region: REGION, 'detail-type': 'Workload state changed', detail: { workloadId: 'web', to: 'ASLEEP', router: `dmtr-${REGION}`, region: REGION },
    });
    expect(googleEvent({ account: PROJECT, region: REGION }, 'Router checked', { router: { name: 'other', version: '0.41.0' }, chunk: { index: 0, total: 1 } })).toEqual({
      account: PROJECT, region: REGION, 'detail-type': 'Router checked', detail: { router: { name: `dmtr-${REGION}`, version: '0.41.0', region: REGION }, chunk: { index: 0, total: 1 } },
    });
  });

  it('sends the queue\'s records by their source: a Google Cloud router\'s (or anything named like one) to its reading, an AWS router\'s to the ingest as before', async () => {
    const seen: string[] = [];
    const route = bySource({ ingest: async (e) => { seen.push(`ingest ${e.account}`); }, reports: async (e) => { seen.push(`reports ${e.account}`); } });
    await route({ source: 'dormeto.router', account: '038606077307', region: 'eu-west-3', 'detail-type': 'Router checked', detail: {} });
    await route({ source: SOURCE, account: '038606077307', region: 'eu-west-1', 'detail-type': 'Router checked', detail: {} });
    await route({ source: 'dormeto.router.gcp', account: '038606077307', region: 'eu-west-1', 'detail-type': 'Router checked', detail: {} });
    await route({ account: '038606077307', region: 'eu-west-3', 'detail-type': 'Router checked', detail: {} });
    expect(seen).toEqual(['ingest 038606077307', 'reports 038606077307', 'reports 038606077307', 'ingest 038606077307']);
  });

  it('drops a dormeto.router.gcp/ event from another account, logged and not retried: no other account speaks for a project', async () => {
    const w = world();
    await expect(w.report(relayed('Workload state changed', { at: iso(T0), workloadId: 'web', from: 'AWAKE', to: 'NAPPING' }, { account: '038606077307' }))).resolves.toBeUndefined();
    expect(w.ingested).toEqual([]);
    expect(await w.store.getWorkload(PROJECT, REGION, 'web')).toBeNull();
    expect(w.logs).toEqual([['RouterEventRefused', { account: '038606077307', source: SOURCE, detailType: 'Workload state changed', reason: 'a Google Cloud router\'s events come from the manager\'s own account only' }]]);
  });

  it('drops every dormeto.router.gcp/ event while the manager\'s own account is unknown (MANAGER_ACCOUNT unset): fail closed', async () => {
    const ingested: RouterEvent[] = [];
    const registry = { get: async () => { throw new Error('the registry is not read'); } };
    for (const ownAccount of [undefined, '']) {
      const report = createGoogleReports({ ownAccount, registry, ingest: async (e) => { ingested.push(e); }, push: async () => {} });
      await report(relayed('Workload state changed', { at: iso(T0), workloadId: 'web', from: 'AWAKE', to: 'NAPPING' }));
      await report(relayed('Workload state changed', { at: iso(T0), workloadId: 'web', from: 'AWAKE', to: 'NAPPING' }, { account: '' }));
    }
    expect(ingested).toEqual([]);
  });

  it('drops an event whose source is not exactly dormeto.router.gcp/<project>/<region>, a detail type a router does not send, or a detail that is not an object', async () => {
    const w = world();
    const change = { at: iso(T0), workloadId: 'web', from: 'AWAKE', to: 'NAPPING' };
    const malformed = [
      'dormeto.router.gcp', 'dormeto.router.gcp/', `dormeto.router.gcp/${PROJECT}`, `dormeto.router.gcp/${PROJECT}/`, `dormeto.router.gcp//${REGION}`,
      `dormeto.router.gcp/${PROJECT}/${REGION}/extra`, `dormeto.router.gcp/038606077307/${REGION}`, `dormeto.router.gcp/${PROJECT}/eu-west-1`,
      `dormeto.router.gcp/${PROJECT.toUpperCase()}/${REGION}`, `dormeto.router.gcpx/${PROJECT}/${REGION}`,
    ];
    for (const source of malformed) await w.report(relayed('Workload state changed', change, { source }));
    await w.report(relayed('Workload listed', { at: iso(T0), workload: row('web', 'AWAKE') }));
    await w.report({ ...relayed('Workload state changed', change), detail: [change] });
    expect(w.ingested).toEqual([]);
    expect(w.logs.map(([event, data]) => [event, data.source, data.reason])).toEqual([
      ...malformed.map((source) => ['RouterEventRefused', source, 'the source is not dormeto.router.gcp/<project>/<region>']),
      ['RouterEventRefused', SOURCE, 'not a detail type a router sends'],
      ['RouterEventRefused', SOURCE, 'not a detail type a router sends'],
    ]);
  });

  it('drops the event of a router that is not registered, or registered as an AWS router: a removed router\'s credentials last up to an hour', async () => {
    const w = world({ registered: false });
    await w.report(relayed('Workload state changed', { at: iso(T0), workloadId: 'web', from: 'AWAKE', to: 'NAPPING' }));
    await w.report(relayed('Router checked', checked(T0 - 10 * S, [row('web', 'AWAKE')], undefined, '"stale"')));
    await w.register({ cloud: undefined });
    await w.report(relayed('Workload state changed', { at: iso(T0), workloadId: 'web', from: 'AWAKE', to: 'NAPPING' }));
    expect(w.ingested).toEqual([]);
    expect(await w.store.getWorkload(PROJECT, REGION, 'web')).toBeNull();
    expect(w.calls).toEqual([]);
    expect(w.logs).toEqual(Array.from({ length: 3 }, (_, i) => ['RouterEventRefused', {
      account: OWN, source: SOURCE, detailType: i === 1 ? 'Router checked' : 'Workload state changed', reason: `router ${PROJECT}/${REGION} is not registered with this manager`,
    }]));
  });

  it('pushes manager-settings, with where to report, once a check when the router holds another ETag: on its first chunk only', async () => {
    const w = world();
    await w.report(relayed('Router checked', checked(T0 - 10 * S, [row('web', 'AWAKE')], { index: 0, total: 2 }, '"stale"')));
    await w.report(relayed('Router checked', checked(T0 - 10 * S, [row('shop', 'AWAKE')], { index: 1, total: 2 }, '"stale"')));
    expect(w.calls).toEqual([{
      method: 'POST', url: `${CONTROLLER}/v1/actions`,
      body: { action: 'manager-settings', settings: { workloads: { hibernate: false } }, etag: '"current"', events: EVENTS, refusals: true },
    }]);
    expect(w.logs).toContainEqual(['ManagerSettingsPushed', { router: `dmtr-${REGION}`, account: PROJECT, region: REGION, etag: '"current"' }]);
    // The router holds settings.json's ETag: nothing more; settings.json never written: nothing either.
    await w.report(relayed('Router checked', checked(T0, [row('web', 'AWAKE')], undefined, '"current"')));
    w.s3.etag = null;
    await w.report(relayed('Router checked', checked(T0 + S, [row('web', 'AWAKE')], undefined, '"stale"')));
    expect(w.calls).toHaveLength(1);
    expect(w.s3.gets).toBe(1);
  });

  it('logs a push that fails, and keeps the check ingested: the next check pushes again', async () => {
    const w = world();
    w.google.answer = () => new GoogleError({ host: 'sts.googleapis.com', status: 503, reason: '', message: 'unavailable' });
    await expect(w.report(relayed('Router checked', checked(T0 - 10 * S, [row('web', 'AWAKE')], undefined, '"stale"')))).resolves.toBeUndefined();
    expect(await w.store.getWorkload(PROJECT, REGION, 'web')).toMatchObject({ state: 'AWAKE' });
    expect(w.logs.map(([event]) => event)).toEqual(['ManagerSettingsNotPushed']);
  });

  it('pushes nothing to a router no longer registered, and says so', async () => {
    const w = world();
    const push = createSettingsPush({
      settings: { etag: async () => '"current"', read: async () => ({ etag: '"current"', text: '{}' }) }, registry: w.registry,
      google: { current: async () => { throw new Error('Google is not called'); } }, events: EVENTS, log: { info: () => {}, warn: (event, data) => w.logs.push([event, data as Json]) },
    });
    await push(PROJECT, 'us-central1', '"stale"');
    expect(w.calls).toEqual([]);
    expect(w.logs).toEqual([['ManagerSettingsNotPushed', { account: PROJECT, region: 'us-central1', error: 'the router is not registered' }]]);
  });
});

// A router sends from its cursor, moved only on the API's 200 (router push design §4.3): an answer lost sends the same events
// again, and the waker's and the controller's commits can arrive out of order; a check comes in chunks under 64 KB, in any
// order. Nothing is lost or doubled.
describe('a router\'s reports sent again or out of order', () => {
  it('keeps one history entry for a transition the router sends again', async () => {
    const w = world();
    const change = { at: iso(T0 - 60 * S), workloadId: 'web', from: 'AWAKE', to: 'NAPPING', cause: 'idle', tags: {} };
    await w.report(relayed('Workload state changed', change));
    await w.report(relayed('Workload state changed', change));
    const history = await w.store.listHistory(PROJECT, REGION, 'web', iso(T0 - 86_400 * S), iso(T0 + 86_400 * S));
    expect(history.entries.map((e) => [e.from, e.to, e.at])).toEqual([['AWAKE', 'NAPPING', iso(T0 - 60 * S)]]);
  });

  it('files a transition reported after a later one in the history, and leaves the summary at the later one', async () => {
    const w = world();
    await w.report(relayed('Workload state changed', { at: iso(T0 - 60 * S), workloadId: 'web', from: 'NAPPING', to: 'ASLEEP', cause: 'idle', tags: {} }));
    await w.report(relayed('Workload state changed', { at: iso(T0 - 120 * S), workloadId: 'web', from: 'AWAKE', to: 'NAPPING', cause: 'idle', tags: {} }));
    expect(await w.store.getWorkload(PROJECT, REGION, 'web')).toMatchObject({ state: 'ASLEEP', stateAt: iso(T0 - 60 * S) });
    const history = await w.store.listHistory(PROJECT, REGION, 'web', iso(T0 - 86_400 * S), iso(T0 + 86_400 * S));
    expect(history.entries.map((e) => [e.from, e.to, e.at])).toEqual([['AWAKE', 'NAPPING', iso(T0 - 120 * S)], ['NAPPING', 'ASLEEP', iso(T0 - 60 * S)]]);
  });

  it('keeps every row a check lists, whatever the order of its chunks, and removes the row it no longer lists', async () => {
    const w = world();
    const at = T0 - 10 * S;
    const rows = ['a', 'b', 'c'].map((id) => row(id, 'AWAKE'));
    await w.report(relayed('Router checked', checked(at - 300 * S, [...rows, row('gone', 'AWAKE')])));
    // Each order at a check of its own, a second after the one before.
    const orders = [[0, 1, 2], [2, 0, 1], [1, 2, 0]] as const;
    for (const [i, order] of orders.entries()) {
      const t = at + i * S;
      for (const index of order) await w.report(relayed('Router checked', checked(t, [rows[index]!], { index, total: 3 })));
      expect(await w.store.getWorkload(PROJECT, REGION, 'gone')).toBeNull();
      for (const id of ['a', 'b', 'c']) expect(await w.store.getWorkload(PROJECT, REGION, id)).toMatchObject({ state: 'AWAKE', checkedAt: iso(t) });
    }
  });
});
