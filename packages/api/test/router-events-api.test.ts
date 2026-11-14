// The relay of the Google Cloud routers' events (router push design 2026-11-14 §3.1): POST /routers/events, behind API
// Gateway's JWT authorizer for Google's tokens (issuer accounts.google.com, audience the API's endpoint; its Terraform test
// holds it). The function proves the router from the token's claims alone: a verified email
// dmtr-<region>@<project>.iam.gserviceaccount.com, a Google Cloud connection and that router registered. It puts each
// entry on the manager's bus as `dormeto.router.gcp`, wrapped with the token's project and region, and answers the ETag of
// settings.json. The route is not a user's: no identity, role or audit.
import { describe, expect, it } from 'vitest';
import type { InstalledRouter } from '@dormeto/operations';
import { createApi, type ApiEvent, type AuditEntry, type BusEntry } from '../src/api.js';
import { GOOGLE_RECORD } from './google-connection.js';

const NOW = Date.UTC(2026, 10, 14, 12, 0);
const ENDPOINT = 'https://abc123.execute-api.eu-west-1.amazonaws.com';
const EVENTS = { url: `${ENDPOINT}/routers/events`, audience: ENDPOINT };
const PROJECT = 'dormeto-dev';
const REGION = 'europe-west2';
const EMAIL = `dmtr-${REGION}@${PROJECT}.iam.gserviceaccount.com`;
const ETAG = '"5d41402abc4b2a76b9719d911017c592"';

const registered = (over: Partial<InstalledRouter> = {}): InstalledRouter => ({
  name: `dmtr-${REGION}`, account: PROJECT, region: REGION, controller: `https://dmtr-${REGION}-controller-abc123-nw.a.run.app`, onboarder: '', version: '0.41.0', build: '',
  installedBy: 'cli', cloud: 'gcp', installedAt: '2026-11-09T10:00:00.000Z', ...over,
});

// The claims API Gateway's JWT authorizer hands over for a Google identity token (booleans flattened to strings).
const googleClaims = (over: Record<string, string> = {}) => ({
  iss: 'https://accounts.google.com', aud: ENDPOINT, azp: '104857839202938475610', sub: '104857839202938475610', email: EMAIL, email_verified: 'true', ...over,
});
function post(body: unknown, claims: Record<string, string> | null = googleClaims(), { path = '/routers/events', method = 'POST' } = {}): ApiEvent {
  return {
    rawPath: path,
    requestContext: { http: { method }, ...(claims ? { authorizer: { jwt: { claims } } } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}
const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');
const stateChanged = (over: Record<string, unknown> = {}) => ({
  detailType: 'Workload state changed', detail: { at: '2026-11-14T11:59:00.000Z', workloadId: 'web', from: 'AWAKE', to: 'NAPPING', cause: 'idle', tags: {}, ...over },
});
const checked = (index = 0, total = 1, workloads: unknown[] = []) => ({
  detailType: 'Router checked', detail: {
    router: { name: `dmtr-${REGION}`, version: '0.41.0' }, checkedAt: '2026-11-14T11:58:00.000Z', durationMs: 900, health: { status: 'ok' }, pauses: [], counts: {},
    chunk: { index, total }, workloads, managerSettings: { etag: ETAG },
  },
});

function relay({ routers = [registered()], connected = true, etag = ETAG as string | null, put }: {
  routers?: InstalledRouter[]; connected?: boolean; etag?: string | null; put?: (entries: BusEntry[]) => Promise<number>;
} = {}) {
  const batches: BusEntry[][] = [];
  const audit: AuditEntry[] = [];
  const reads = { routers: 0 };
  const api = createApi({
    routers: [], version: '0.25.0', now: () => NOW, managerAccount: '121014831971',
    invoke: async () => { throw new Error('the relay calls no router'); },
    audit: { write: async (e) => { audit.push(e); }, list: async () => audit },
    google: {
      get: async () => (connected ? GOOGLE_RECORD : null), put: async () => {}, delete: async () => {},
      routers: { list: async () => (reads.routers++, routers), put: async () => {}, delete: async () => {} },
    },
    globalSettings: { read: async () => ({}), write: async () => ETAG, etag: async () => etag },
    relay: {
      events: EVENTS,
      put: async (entries) => {
        batches.push(entries);
        return put ? put(entries) : 0;
      },
    },
  });
  const entries = () => batches.flat();
  return { api, batches, entries, audit, reads };
}

describe('POST /routers/events: the relay of a Google Cloud router\'s events', () => {
  it('puts each entry on the bus as dormeto.router.gcp, wrapped with the token\'s project and region, and answers settings.json\'s ETag', async () => {
    const r = relay();
    const res = await r.api(post({ events: [stateChanged(), checked()] }));
    expect([res.statusCode, json(res)]).toEqual([200, { accepted: 2, managerSettings: { etag: ETAG } }]);
    expect(r.entries()).toEqual([
      { Source: 'dormeto.router.gcp', DetailType: 'Workload state changed', Detail: JSON.stringify({ account: PROJECT, region: REGION, detail: stateChanged().detail }) },
      { Source: 'dormeto.router.gcp', DetailType: 'Router checked', Detail: JSON.stringify({ account: PROJECT, region: REGION, detail: checked().detail }) },
    ]);
    expect(r.audit).toEqual([]);
  });

  it('ignores a project, a region or a router the body names: the token\'s are the wrapper\'s', async () => {
    const r = relay();
    const forged = { project: 'someone-else', account: '038606077307', region: 'us-central1', router: 'dmtr-us-central1' };
    const res = await r.api(post({ ...forged, events: [stateChanged(forged)] }));
    expect(res.statusCode).toBe(200);
    expect(r.entries().map((e) => JSON.parse(e.Detail))).toEqual([{ account: PROJECT, region: REGION, detail: stateChanged(forged).detail }]);
  });

  it('answers a null ETag while settings.json was never written, and accepts an empty list', async () => {
    const r = relay({ etag: null });
    const res = await r.api(post({ events: [] }));
    expect([res.statusCode, json(res)]).toEqual([200, { accepted: 0, managerSettings: { etag: null } }]);
    expect(r.batches).toEqual([]);
  });

  it('refuses with 403 router_unknown, putting nothing, a token that is not a registered router\'s', async () => {
    const cases: [string, ReturnType<typeof relay>, ApiEvent][] = [
      ['an unverified email', relay(), post({ events: [stateChanged()] }, googleClaims({ email_verified: 'false' }))],
      ['no email', relay(), post({ events: [stateChanged()] }, googleClaims({ email: '' }))],
      ['another service account of the project', relay(), post({ events: [stateChanged()] }, googleClaims({ email: `dmt-dev-command@${PROJECT}.iam.gserviceaccount.com` }))],
      ['a user\'s account', relay(), post({ events: [stateChanged()] }, googleClaims({ email: 'dmtr-europe-west2@gmail.com' }))],
      ['a domain after the service account\'s', relay(), post({ events: [stateChanged()] }, googleClaims({ email: `${EMAIL}.example.com` }))],
      ['a region that is not Google Cloud\'s', relay(), post({ events: [stateChanged()] }, googleClaims({ email: `dmtr-eu-west-1@${PROJECT}.iam.gserviceaccount.com` }))],
      ['a 12-digit project', relay(), post({ events: [stateChanged()] }, googleClaims({ email: `dmtr-${REGION}@123456789012.iam.gserviceaccount.com` }))],
      ['a router of another region', relay(), post({ events: [stateChanged()] }, googleClaims({ email: `dmtr-us-central1@${PROJECT}.iam.gserviceaccount.com` }))],
      ['a router of another project', relay(), post({ events: [stateChanged()] }, googleClaims({ email: `dmtr-${REGION}@another-project.iam.gserviceaccount.com` }))],
      ['a router not registered', relay({ routers: [] }), post({ events: [stateChanged()] })],
      ['an AWS registration of that name', relay({ routers: [registered({ cloud: undefined })] }), post({ events: [stateChanged()] })],
      ['no Google Cloud connection', relay({ connected: false }), post({ events: [stateChanged()] })],
      ['no claims', relay(), post({ events: [stateChanged()] }, null)],
      ['a dashboard user\'s claims', relay(), post({ events: [stateChanged()] }, { sub: 'u-1', email: 'ops@example.com', 'cognito:groups': '[dmt-admin]' })],
    ];
    for (const [what, r, request] of cases) {
      const res = await r.api(request);
      expect([res.statusCode, json(res).error], what).toEqual([403, 'router_unknown']);
      expect(r.batches, what).toEqual([]);
    }
  });

  it('refuses a body of the wrong shape with 400 bad_request, putting nothing, once the router is known', async () => {
    const big = 'x'.repeat(1024 * 1024);
    for (const body of [
      'not json', {}, { events: {} }, { events: [stateChanged(), 'x'] }, { events: [{ detailType: 'Workload listed', detail: {} }] },
      { events: [{ detailType: 'Router checked', detail: [] }] }, { events: [{ detailType: 'Router checked' }] },
      { events: Array.from({ length: 101 }, () => stateChanged()) },
      { events: [stateChanged({ note: big })] },
      // One entry over the bus's 256 KB.
      { events: [stateChanged({ note: 'x'.repeat(256 * 1024) })] },
    ]) {
      const r = relay();
      const res = await r.api(post(body));
      expect([res.statusCode, json(res).error], JSON.stringify(body).slice(0, 80)).toEqual([400, 'bad_request']);
      expect(r.batches).toEqual([]);
    }
    // An unknown router's bad body is a 403: the body is read only for a router known.
    expect((await relay({ routers: [] }).api(post('not json'))).statusCode).toBe(403);
  });

  it('puts 10 entries at most a call, and 256 KB at most', async () => {
    const r = relay();
    expect((await r.api(post({ events: Array.from({ length: 25 }, (_, i) => stateChanged({ workloadId: `w${i}` })) }))).statusCode).toBe(200);
    expect(r.batches.map((b) => b.length)).toEqual([10, 10, 5]);
    const s = relay();
    const rows = Array.from({ length: 300 }, (_, i) => ({ workloadId: `w${i}`, name: 'x'.repeat(180) }));
    expect((await s.api(post({ events: [0, 1, 2, 3, 4].map((i) => checked(i, 5, rows)) }))).statusCode).toBe(200);
    const size = (e: BusEntry) => Buffer.byteLength(e.Source) + Buffer.byteLength(e.DetailType) + Buffer.byteLength(e.Detail);
    expect(s.batches.length).toBeGreaterThan(1);
    for (const b of s.batches) expect(b.reduce((n, e) => n + size(e), 0)).toBeLessThanOrEqual(256 * 1024);
    expect(s.entries()).toHaveLength(5);
  });

  it('answers 502 not_published with the count of entries the bus did not take: the router sends them again', async () => {
    const failing = relay({ put: async (entries) => (entries.length === 10 ? 2 : 0) });
    const res = await failing.api(post({ events: Array.from({ length: 12 }, (_, i) => stateChanged({ workloadId: `w${i}` })) }));
    expect([res.statusCode, json(res)]).toEqual([502, { error: 'not_published', failed: 2 }]);
    const thrown = relay({ put: async (entries) => { if (entries.length === 10) throw new Error('throttled'); return 0; } });
    const again = await thrown.api(post({ events: Array.from({ length: 12 }, (_, i) => stateChanged({ workloadId: `w${i}` })) }));
    expect([again.statusCode, json(again)]).toEqual([502, { error: 'not_published', failed: 10 }]);
    expect(thrown.entries()).toHaveLength(12);
  });

  it('is the relay only at POST /routers/events: the same path under /api or /iam is a user\'s, and another method is not found', async () => {
    for (const request of [
      post({ events: [stateChanged()] }, googleClaims(), { path: '/api/routers/events' }),
      post({ events: [stateChanged()] }, googleClaims(), { method: 'GET' }),
    ]) {
      const r = relay();
      const res = await r.api(request);
      expect(res.statusCode).not.toBe(200);
      expect(r.batches).toEqual([]);
    }
    const r = relay();
    expect((await r.api(post({ events: [] }, googleClaims(), { method: 'GET' }))).statusCode).toBe(404);
  });

  it('answers 404 while the manager has no relay', async () => {
    const api = createApi({ routers: [], version: '0.25.0', invoke: async () => ({}), audit: { write: async () => {}, list: async () => [] } });
    expect((await api(post({ events: [] }))).statusCode).toBe(404);
  });
});
