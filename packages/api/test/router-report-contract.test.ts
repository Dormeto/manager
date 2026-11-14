// The Google Cloud router's reports, end to end across the two repositories (router push design 2026-11-14 §3, §4): the
// router's own reporter (router/gcp/src/report.mjs), its journal entries as its store writes them (rows.mjs's eventOf) and its
// `list` answer as the router's stored answers hold it, sent through this API's relay, put on the bus, and read by the fleet
// function's ingest. No shared fixture holds the report's body: this test is the contract. Run when the router's checkout is
// beside the manager's (as scripts/parity reaches ../router), skipped when it is absent.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { InstalledRouter } from '@dormeto/operations';
import { createFleetStore, createIngest } from '@dormeto/fleet';
import { createGoogleReports, RELAY_SOURCE } from '@dormeto/fleet/google-report';
import { fakeDynamo } from '../../discovery/test/dynamo-fake.js';
import { createApi, type ApiEvent, type BusEntry } from '../src/api.js';
import { GOOGLE_RECORD } from './google-connection.js';

const ROUTER = resolve(import.meta.dirname, '../../../../router');
const REPORT = resolve(ROUTER, 'gcp/src/report.mjs');
const ROWS = resolve(ROUTER, 'gcp/src/rows.mjs');
const ANSWERS = resolve(ROUTER, 'gcp/test/fixtures/manager-actions-answers.json');
const present = existsSync(REPORT) && existsSync(ROWS) && existsSync(ANSWERS);

type Json = Record<string, any>;
interface RouterReport {
  createReporter(deps: Json): { transitioned(): Promise<void>; checked(summary: Json | null): Promise<void> };
}
interface RouterRows { eventOf(change: Json): Json }
const report = (present ? await import(/* @vite-ignore */ REPORT) : null) as RouterReport | null;
const rows = (present ? await import(/* @vite-ignore */ ROWS) : null) as RouterRows | null;

const OWN = '121014831971';
const PROJECT = 'dormeto-dev';
const REGION = 'europe-west1';
const ENDPOINT = 'https://abc123.execute-api.eu-west-1.amazonaws.com';
const EVENTS = { url: `${ENDPOINT}/routers/events`, audience: ENDPOINT };
const ETAG = '"e1"';
// After the times of the router's stored `list` answer (2023-11-14T22:13:20Z).
const NOW = Date.parse('2023-11-14T22:30:00.000Z');

describe.skipIf(!present)('a Google Cloud router\'s report, from the router\'s reporter to the manager\'s summaries', () => {
  it('the body the router sends is the one the relay takes and the ingest files under the token\'s project and region', async () => {
    const answers = JSON.parse(readFileSync(ANSWERS, 'utf8')) as Record<string, { status: number; body: Json }>;
    const list = answers['list, paused']!.body;
    const routerOf = { name: `dmtr-${REGION}`, region: REGION, project: PROJECT };

    // The router's journal: a wake, its two state changes as the transition commits them.
    const journal = [[NOW - 120_000, 'ASLEEP', 'WAKING', 'request'], [NOW - 90_000, 'WAKING', 'AWAKE', 'healthy']].map(([at, from, to, cause]) => ({
      id: `${String(at).padStart(13, '0')}-demo-${to}`,
      ...rows!.eventOf({ workloadId: 'demo', from, to, stateAt: at, cause, event: to === 'AWAKE' ? { wakeId: 'w1', durationMs: 30_000 } : { wakeId: 'w1' }, router: routerOf, tags: { team: 'a' } }),
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

    // The manager's API with the relay, the router registered, behind the JWT authorizer's claims of the router's token.
    const bus: BusEntry[] = [];
    const registered: InstalledRouter = {
      name: `dmtr-${REGION}`, account: PROJECT, region: REGION, controller: `https://dmtr-${REGION}-controller-abc123-ew.a.run.app`, onboarder: '', version: '0.41.0',
      build: '', installedBy: 'cli', cloud: 'gcp', installedAt: '2023-11-01T00:00:00.000Z',
    };
    const api = createApi({
      routers: [], version: '0.25.0', now: () => NOW, managerAccount: OWN,
      invoke: async () => { throw new Error('the relay calls no router'); },
      audit: { write: async () => {}, list: async () => [] },
      google: {
        get: async () => GOOGLE_RECORD, put: async () => {}, delete: async () => {},
        routers: { list: async () => [registered], put: async () => {}, delete: async () => {} },
      },
      globalSettings: { read: async () => ({}), write: async () => ETAG, etag: async () => ETAG },
      relay: { events: EVENTS, put: async (entries) => { bus.push(...entries); return 0; } },
    });
    const audiences: string[] = [];
    const sent: Json[] = [];
    const fetch = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
      expect([url, init.method, init.headers.authorization]).toEqual([EVENTS.url, 'POST', 'Bearer google-id-token']);
      sent.push(JSON.parse(init.body));
      const event: ApiEvent = {
        rawPath: new URL(url).pathname,
        requestContext: {
          http: { method: init.method },
          authorizer: { jwt: { claims: { iss: 'https://accounts.google.com', aud: ENDPOINT, sub: '1048', email: `dmtr-${REGION}@${PROJECT}.iam.gserviceaccount.com`, email_verified: 'true' } } },
        },
        body: init.body,
      };
      const res = await api(event);
      return new Response(res.body ?? null, { status: res.statusCode });
    };
    const warnings: [string, Json][] = [];
    const reporter = report!.createReporter({
      store, fetch, region: REGION, now: () => NOW,
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
    // The router's cursor moved to its last entry: every request answered 200.
    expect(cursor!.sentThrough).toBe(journal.at(-1)!.id);
    expect(sent.flatMap((b) => b.events.map((e: Json) => e.detailType))).toEqual(['Workload state changed', 'Workload state changed', 'Router checked']);

    // The bus's entries, as EventBridge hands them to the fleet function's queue (the envelope's account: the API's, the manager's).
    expect(bus.map((e) => [e.Source, JSON.parse(e.Detail).account, JSON.parse(e.Detail).region])).toEqual(Array(3).fill([RELAY_SOURCE, PROJECT, REGION]));
    const dynamo = fakeDynamo();
    const summaries = createFleetStore({ dynamo, table: 't', now: () => NOW });
    const pushed: [string, string, string | null][] = [];
    const refused: Json[] = [];
    const reports = createGoogleReports({
      ownAccount: OWN, ingest: createIngest({ store: summaries, now: () => NOW, log: { warn: (_e, data) => refused.push(data) } }),
      push: async (account, region, held) => { pushed.push([account, region, held]); },
      log: { info: () => {}, warn: (_e, data) => refused.push(data) },
    });
    for (const e of bus) {
      await reports({ source: e.Source, account: OWN, region: 'eu-west-1', 'detail-type': e.DetailType, detail: JSON.parse(e.Detail) });
    }
    expect(refused).toEqual([]);

    const router = (await summaries.getRouter(PROJECT, REGION))!.summary;
    expect([router.name, router.checkedAt, router.check]).toEqual([`dmtr-${REGION}`, new Date(NOW - 60_000).toISOString(), { checkedAt: new Date(NOW - 60_000).toISOString(), total: 1, received: [0] }]);
    const workload = (await summaries.getWorkload(PROJECT, REGION, 'demo'))!;
    expect([workload.state, workload.stateAt, workload.router, workload.backendService]).toEqual(['AWAKE', new Date(NOW - 90_000).toISOString(), `dmtr-${REGION}`, list.workloads[0].backendService]);
    const history = await summaries.listHistory(PROJECT, REGION, 'demo', '2023-11-01T00:00:00.000Z', '2023-11-15T00:00:00.000Z');
    expect(history.entries.map((h) => [h.from, h.to, h.at])).toEqual([
      ['ASLEEP', 'WAKING', new Date(NOW - 120_000).toISOString()],
      ['WAKING', 'AWAKE', new Date(NOW - 90_000).toISOString()],
    ]);
    // The ETag the router holds came with its check: the same as settings.json's, so the push finds nothing to do.
    expect(pushed).toEqual([[PROJECT, REGION, ETAG]]);
  });
});
