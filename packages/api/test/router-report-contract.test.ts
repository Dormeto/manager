// The Google Cloud router's reports, across the two repositories (router credentials design 2026-11-15 §2 to §5): the router
// asks this API's POST /routers/credentials for credentials with its identity token, then puts its entries on the manager's
// bus itself (EventBridge PutEvents), and the fleet function's ingest reads them. No shared fixture holds the answer or the
// entries: this test is the contract.
// - The route's answer: `{credentials: {accessKeyId, secretAccessKey, sessionToken, expiration}, bus: {name, region}, source,
//   managerSettings: {etag}}`, nothing else.
// - The entries: `{EventBusName: bus.name, Source: source, DetailType: 'Workload state changed' | 'Router checked', Detail:
//   JSON of the router's own detail}`, EventBridge's envelope then carrying the manager's account.
// The first test holds the manager's half; the second drives the router's own reporter (router/gcp/src/report.mjs) when the
// router's checkout is beside the manager's (as scripts/parity reaches ../router) and its reporter puts on the bus itself.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { InstalledRouter } from '@dormeto/operations';
import { createFleetStore, createIngest } from '@dormeto/fleet';
import { createGoogleReports, googleSourceOf } from '@dormeto/fleet/google-report';
import { createRegistry } from '@dormeto/fleet/registry';
import { fakeDynamo } from '../../discovery/test/dynamo-fake.js';
import { createApi, type ApiEvent, type AssumeRoleInput } from '../src/api.js';
import { GOOGLE_RECORD } from './google-connection.js';

const ROUTER = resolve(import.meta.dirname, '../../../../router');
const REPORT = resolve(ROUTER, 'gcp/src/report.mjs');
const ROWS = resolve(ROUTER, 'gcp/src/rows.mjs');
const ANSWERS = resolve(ROUTER, 'gcp/test/fixtures/manager-actions-answers.json');
// The router's reporter that puts on the bus itself (router credentials design §5), not the relay's.
const putsItself = existsSync(REPORT) && existsSync(ROWS) && existsSync(ANSWERS) && readFileSync(REPORT, 'utf8').includes('AWSEvents.PutEvents');

type Json = Record<string, any>;
interface RouterReport {
  createReporter(deps: Json): { transitioned(): Promise<void>; checked(summary: Json | null): Promise<void> };
}
interface RouterRows { eventOf(change: Json): Json }

const OWN = '121014831971';
const PROJECT = 'dormeto-dev';
const REGION = 'europe-west1';
const ENDPOINT = 'https://abc123.execute-api.eu-west-1.amazonaws.com';
const EVENTS = { url: `${ENDPOINT}/routers/credentials`, audience: ENDPOINT };
const BUS = { name: 'dmt-dev-manager', arn: `arn:aws:events:eu-west-1:${OWN}:event-bus/dmt-dev-manager`, region: 'eu-west-1' };
const ETAG = '"e1"';
// After the times of the router's stored `list` answer (2023-11-14T22:13:20Z).
const NOW = Date.parse('2023-11-14T22:30:00.000Z');

// The entry a router puts (PutEvents' Entries[]), and the event EventBridge hands the fleet function's queue for it.
interface PutEntry { EventBusName: string; Source: string; DetailType: string; Detail: string }
const envelopeOf = (e: PutEntry) => ({ version: '0', id: 'e', source: e.Source, account: OWN, region: BUS.region, time: new Date(NOW).toISOString(), resources: [], 'detail-type': e.DetailType, detail: JSON.parse(e.Detail) });

// The manager: its API with the routers' reports and the router registered, the fleet's ingest over one table.
function manager() {
  const registered: InstalledRouter = {
    name: `dmtr-${REGION}`, account: PROJECT, region: REGION, controller: `https://dmtr-${REGION}-controller-abc123-ew.a.run.app`, onboarder: '', version: '0.41.0',
    build: '', installedBy: 'cli', cloud: 'gcp', installedAt: '2023-11-01T00:00:00.000Z',
  };
  const sessions: AssumeRoleInput[] = [];
  const api = createApi({
    routers: [], version: '0.25.0', now: () => NOW, managerAccount: OWN,
    invoke: async () => { throw new Error('the route calls no router'); },
    audit: { write: async () => {}, list: async () => [] },
    google: {
      get: async () => GOOGLE_RECORD, put: async () => {}, delete: async () => {},
      routers: { list: async () => [registered], put: async () => {}, delete: async () => {} },
    },
    globalSettings: { read: async () => ({}), write: async () => ETAG, etag: async () => ETAG },
    routerReports: {
      events: EVENTS, roleArn: `arn:aws:iam::${OWN}:role/dmt-dev-manager-router-report`, bus: BUS,
      assume: async (input) => {
        sessions.push(input);
        return { AccessKeyId: 'ASIAROUTER', SecretAccessKey: 'router-secret', SessionToken: 'router-session', Expiration: new Date(NOW + 3_600_000) };
      },
    },
  });
  const dynamo = fakeDynamo();
  const summaries = createFleetStore({ dynamo, table: 't', now: () => NOW });
  const registry = createRegistry({ dynamo, table: 't' });
  const pushed: [string, string, string | null][] = [];
  const refused: Json[] = [];
  const reports = createGoogleReports({
    ownAccount: OWN, registry, ingest: createIngest({ store: summaries, now: () => NOW, log: { warn: (_e, data) => refused.push(data) } }),
    push: async (account, region, held) => { pushed.push([account, region, held]); },
    log: { info: () => {}, warn: (_e, data) => refused.push(data) },
  });
  const ready = registry.put(registered);
  const ingest = async (entries: PutEntry[]) => {
    await ready;
    for (const e of entries) await reports(envelopeOf(e));
  };
  // The router's request as API Gateway hands it over, behind the JWT authorizer's claims of the router's token.
  const credentials = (path = new URL(EVENTS.url).pathname, method = 'POST'): ApiEvent => ({
    rawPath: path,
    requestContext: {
      http: { method },
      authorizer: { jwt: { claims: { iss: 'https://accounts.google.com', aud: ENDPOINT, sub: '1048', email: `dmtr-${REGION}@${PROJECT}.iam.gserviceaccount.com`, email_verified: 'true' } } },
    },
  });
  return { api, sessions, summaries, pushed, refused, ingest, credentials };
}

describe('a Google Cloud router\'s report: the credentials route\'s answer and the entries the router puts, through to the summaries', () => {
  it('answers what the router reads, and the ingest files the entries put under the answer\'s source by that project and region', async () => {
    const m = manager();
    const res = await m.api(m.credentials());
    expect(res.statusCode).toBe(200);
    const answer = JSON.parse(res.body!) as Json;
    // The answer's shape, every key: the router reads these and no other.
    expect(Object.keys(answer).sort()).toEqual(['bus', 'credentials', 'managerSettings', 'source']);
    expect(Object.keys(answer.credentials).sort()).toEqual(['accessKeyId', 'expiration', 'secretAccessKey', 'sessionToken']);
    expect(Object.values(answer.credentials).every((v) => typeof v === 'string' && v !== '')).toBe(true);
    expect(new Date(answer.credentials.expiration).toISOString()).toBe(answer.credentials.expiration);
    expect(answer.bus).toEqual({ name: BUS.name, region: BUS.region });
    expect(answer.source).toBe(`dormeto.router.gcp/${PROJECT}/${REGION}`);
    expect(answer.source).toBe(googleSourceOf(PROJECT, REGION));
    expect(answer.managerSettings).toEqual({ etag: ETAG });
    // The session can put that source alone.
    expect(JSON.parse(m.sessions[0]!.Policy).Statement[0].Condition).toEqual({ StringEquals: { 'events:source': answer.source } });

    // The entries the router puts: a wake's two state changes from its journal (the entry's id is the journal's), then its check.
    const changes = [
      { id: `${NOW - 120_000}-demo-WAKING`, workloadId: 'demo', from: 'ASLEEP', to: 'WAKING', at: new Date(NOW - 120_000).toISOString(), cause: 'request', wakeId: 'w1', tags: { team: 'a' }, router: `dmtr-${REGION}`, region: REGION, project: PROJECT },
      { id: `${NOW - 90_000}-demo-AWAKE`, workloadId: 'demo', from: 'WAKING', to: 'AWAKE', at: new Date(NOW - 90_000).toISOString(), cause: 'healthy', wakeId: 'w1', durationMs: 30_000, tags: { team: 'a' }, router: `dmtr-${REGION}`, region: REGION, project: PROJECT },
    ];
    const checked = {
      router: { name: `dmtr-${REGION}`, version: '0.41.0', build: 'b7', checkSchedule: '*/5 * * * *', region: REGION },
      checkedAt: new Date(NOW - 60_000).toISOString(), durationMs: 900, health: { status: 'ok', problems: [] }, pauses: [], counts: { AWAKE: 1 },
      chunk: { index: 0, total: 1 }, managerSettings: { etag: ETAG },
      workloads: [{ workloadId: 'demo', name: 'Shop', state: 'AWAKE', stateAt: new Date(NOW - 90_000).toISOString(), source: 'cli', tags: { team: 'a' }, backends: ['instance'], backendService: 'app' }],
    };
    const entries: PutEntry[] = [
      ...changes.map((detail) => ({ EventBusName: answer.bus.name, Source: answer.source, DetailType: 'Workload state changed', Detail: JSON.stringify(detail) })),
      { EventBusName: answer.bus.name, Source: answer.source, DetailType: 'Router checked', Detail: JSON.stringify(checked) },
    ];
    await m.ingest(entries);
    expect(m.refused).toEqual([]);

    const router = (await m.summaries.getRouter(PROJECT, REGION))!.summary;
    expect([router.name, router.checkedAt, router.check]).toEqual([`dmtr-${REGION}`, new Date(NOW - 60_000).toISOString(), { checkedAt: new Date(NOW - 60_000).toISOString(), total: 1, received: [0] }]);
    const workload = (await m.summaries.getWorkload(PROJECT, REGION, 'demo'))!;
    expect([workload.state, workload.stateAt, workload.router, workload.backendService]).toEqual(['AWAKE', new Date(NOW - 90_000).toISOString(), `dmtr-${REGION}`, 'app']);
    const history = await m.summaries.listHistory(PROJECT, REGION, 'demo', '2023-11-01T00:00:00.000Z', '2023-11-15T00:00:00.000Z');
    expect(history.entries.map((h) => [h.from, h.to, h.at])).toEqual([
      ['ASLEEP', 'WAKING', new Date(NOW - 120_000).toISOString()],
      ['WAKING', 'AWAKE', new Date(NOW - 90_000).toISOString()],
    ]);
    // The ETag the router holds came with its check: the same as settings.json's, so the push finds nothing to do.
    expect(m.pushed).toEqual([[PROJECT, REGION, ETAG]]);

    // Another router's source, or the relay's wrapper, files nothing.
    await m.ingest([
      { ...entries[0]!, Source: googleSourceOf(PROJECT, 'us-central1') },
      { ...entries[0]!, Source: 'dormeto.router.gcp', Detail: JSON.stringify({ account: PROJECT, region: REGION, detail: changes[0] }) },
    ]);
    expect(m.refused.map((r) => r.reason)).toEqual([`router ${PROJECT}/us-central1 is not registered with this manager`, 'the source is not dormeto.router.gcp/<project>/<region>']);
  });

  it.skipIf(!putsItself)('the router\'s own reporter asks for credentials, puts its journal and its check on the bus, and the ingest files them', async () => {
    const report = (await import(/* @vite-ignore */ REPORT)) as RouterReport;
    const rows = (await import(/* @vite-ignore */ ROWS)) as RouterRows;
    const answers = JSON.parse(readFileSync(ANSWERS, 'utf8')) as Record<string, { status: number; body: Json }>;
    const list = answers['list, paused']!.body;
    const routerOf = { name: `dmtr-${REGION}`, region: REGION, project: PROJECT };
    const m = manager();

    // The router's journal: a wake, its two state changes as the transition commits them.
    const journal = [[NOW - 120_000, 'ASLEEP', 'WAKING', 'request'], [NOW - 90_000, 'WAKING', 'AWAKE', 'healthy']].map(([at, from, to, cause]) => ({
      id: `${String(at).padStart(13, '0')}-demo-${to}`,
      ...rows.eventOf({ workloadId: 'demo', from, to, stateAt: at, cause, event: to === 'AWAKE' ? { wakeId: 'w1', durationMs: 30_000 } : { wakeId: 'w1' }, router: routerOf, tags: { team: 'a' } }),
    }));
    let cursor: Json | null = null;
    const store = {
      getManagerSettings: async () => ({ settings: {}, etag: ETAG, at: 1, events: EVENTS }),
      getReport: async () => cursor,
      updateReport: async (change: (was: Json | null) => Json | Promise<Json>) => (cursor = await change(cursor)),
      listEvents: async ({ after, limit }: { after: string | null; limit: number }) => {
        const events = journal.filter((e) => after === null || e.id > after).slice(0, limit);
        return { events: structuredClone(events), next: events.length === limit ? events.at(-1)!.id : null };
      },
    };

    const audiences: string[] = [];
    const put: PutEntry[] = [];
    let asked = 0;
    const fetch = async (input: string | URL | Request, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
      const url = String(input);
      const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      if (url === EVENTS.url) {
        asked += 1;
        expect([init.method, headers.authorization]).toEqual(['POST', 'Bearer google-id-token']);
        const res = await m.api(m.credentials(new URL(url).pathname, init.method));
        return new Response(res.body ?? null, { status: res.statusCode });
      }
      // The PutEvents call (plan's Interfaces): signed with the session's credentials, for the events service in the bus's region.
      expect(url).toBe(`https://events.${BUS.region}.amazonaws.com/`);
      expect([init.method, headers['content-type'], headers['x-amz-target'], headers['x-amz-security-token']]).toEqual(['POST', 'application/x-amz-json-1.1', 'AWSEvents.PutEvents', 'router-session']);
      expect(headers.authorization).toMatch(new RegExp(`^AWS4-HMAC-SHA256 Credential=ASIAROUTER/\\d{8}/${BUS.region}/events/aws4_request, SignedHeaders=[^,]+, Signature=[0-9a-f]{64}$`));
      const { Entries } = JSON.parse(init.body!) as { Entries: PutEntry[] };
      put.push(...Entries);
      return new Response(JSON.stringify({ FailedEntryCount: 0, Entries: Entries.map((_, i) => ({ EventId: `e-${put.length + i}` })) }), { status: 200, headers: { 'content-type': 'application/x-amz-json-1.1' } });
    };
    const warnings: [string, Json][] = [];
    const reporter = report.createReporter({
      store, fetch, region: REGION, project: PROJECT, now: () => NOW,
      tokens: { token: async (audience: string) => (audiences.push(audience), 'google-id-token') },
      rows: async () => structuredClone(list),
      log: { info: () => {}, warn: (event: string, data: Json) => warnings.push([event, data]) },
    });

    await reporter.transitioned();
    await reporter.checked({
      checkedAt: NOW - 60_000, durationMs: 900, checkSchedule: '*/5 * * * *', lastScheduledCheckAt: NOW - 60_000,
      health: { status: 'ok', problems: [] }, pauses: [], counts: { AWAKE: 1 },
    });
    expect(warnings).toEqual([]);
    expect(new Set(audiences)).toEqual(new Set([ENDPOINT]));
    // The credentials asked once, kept for the hour.
    expect(asked).toBe(1);
    expect(cursor!.sentThrough).toBe(journal.at(-1)!.id);
    expect(put.map((e) => [e.EventBusName, e.Source, e.DetailType])).toEqual([
      [BUS.name, googleSourceOf(PROJECT, REGION), 'Workload state changed'],
      [BUS.name, googleSourceOf(PROJECT, REGION), 'Workload state changed'],
      [BUS.name, googleSourceOf(PROJECT, REGION), 'Router checked'],
    ]);

    await m.ingest(put);
    expect(m.refused).toEqual([]);
    const router = (await m.summaries.getRouter(PROJECT, REGION))!.summary;
    expect([router.name, router.checkedAt]).toEqual([`dmtr-${REGION}`, new Date(NOW - 60_000).toISOString()]);
    const workload = (await m.summaries.getWorkload(PROJECT, REGION, 'demo'))!;
    expect([workload.state, workload.stateAt, workload.router, workload.backendService]).toEqual(['AWAKE', new Date(NOW - 90_000).toISOString(), `dmtr-${REGION}`, list.workloads[0].backendService]);
    const history = await m.summaries.listHistory(PROJECT, REGION, 'demo', '2023-11-01T00:00:00.000Z', '2023-11-15T00:00:00.000Z');
    expect(history.entries.map((h) => [h.from, h.to, h.at])).toEqual([
      ['ASLEEP', 'WAKING', new Date(NOW - 120_000).toISOString()],
      ['WAKING', 'AWAKE', new Date(NOW - 90_000).toISOString()],
    ]);
    expect(m.pushed).toEqual([[PROJECT, REGION, ETAG]]);
  });
});
