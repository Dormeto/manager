// The credentials of the Google Cloud routers (router credentials design 2026-11-15 §2, §3): POST /routers/credentials,
// behind API Gateway's JWT authorizer for Google's tokens (issuer accounts.google.com, audience the API's endpoint; its
// Terraform test holds it). The function proves the router from the token's claims alone: a verified email
// dmtr-<region>@<project>.iam.gserviceaccount.com, a Google Cloud connection and that router registered. It assumes the
// role of the routers' reports for an hour, with a session policy that allows PutEvents on the manager's bus for that
// router's source alone, and answers the credentials, the bus, the source and settings.json's ETag. No body is read. The
// route is not a user's: no identity, role or audit; its answer is never logged.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstalledRouter } from '@dormeto/operations';
import { createApi, type ApiEvent, type AssumeRoleInput, type AuditEntry } from '../src/api.js';
import { GOOGLE_RECORD } from './google-connection.js';

const NOW = Date.UTC(2026, 10, 15, 12, 0);
const ENDPOINT = 'https://abc123.execute-api.eu-west-1.amazonaws.com';
const EVENTS = { url: `${ENDPOINT}/routers/credentials`, audience: ENDPOINT };
const ROLE = 'arn:aws:iam::121014831971:role/dmt-dev-manager-router-report';
const BUS = { name: 'dmt-dev-manager', arn: 'arn:aws:events:eu-west-1:121014831971:event-bus/dmt-dev-manager', region: 'eu-west-1' };
const PROJECT = 'dormeto-dev';
const REGION = 'europe-west2';
const EMAIL = `dmtr-${REGION}@${PROJECT}.iam.gserviceaccount.com`;
const ETAG = '"5d41402abc4b2a76b9719d911017c592"';
const EXPIRATION = new Date(NOW + 3_600_000);
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const SESSION_TOKEN = 'IQoJb3JpZ2luX2VjEXAMPLESESSIONTOKEN';

const registered = (over: Partial<InstalledRouter> = {}): InstalledRouter => ({
  name: `dmtr-${REGION}`, account: PROJECT, region: REGION, controller: `https://dmtr-${REGION}-controller-abc123-nw.a.run.app`, onboarder: '', version: '0.41.0', build: '',
  installedBy: 'cli', cloud: 'gcp', installedAt: '2026-11-09T10:00:00.000Z', ...over,
});

// The claims API Gateway's JWT authorizer hands over for a Google identity token (booleans flattened to strings).
const googleClaims = (over: Record<string, string> = {}) => ({
  iss: 'https://accounts.google.com', aud: ENDPOINT, azp: '104857839202938475610', sub: '104857839202938475610', email: EMAIL, email_verified: 'true', ...over,
});
function post(claims: Record<string, string> | null = googleClaims(), { path = '/routers/credentials', method = 'POST', body }: { path?: string; method?: string; body?: string } = {}): ApiEvent {
  return {
    rawPath: path,
    requestContext: { http: { method }, ...(claims ? { authorizer: { jwt: { claims } } } : {}) },
    ...(body === undefined ? {} : { body }),
  };
}
const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');

function manager({ routers = [registered()], connected = true, etag = ETAG as string | null, assume }: {
  routers?: InstalledRouter[]; connected?: boolean; etag?: string | null; assume?: (input: AssumeRoleInput) => Promise<unknown>;
} = {}) {
  const sessions: AssumeRoleInput[] = [];
  const audit: AuditEntry[] = [];
  const api = createApi({
    routers: [], version: '0.25.0', now: () => NOW, managerAccount: '121014831971',
    invoke: async () => { throw new Error('the route calls no router'); },
    audit: { write: async (e) => { audit.push(e); }, list: async () => audit },
    google: {
      get: async () => (connected ? GOOGLE_RECORD : null), put: async () => {}, delete: async () => {},
      routers: { list: async () => routers, put: async () => {}, delete: async () => {} },
    },
    globalSettings: { read: async () => ({}), write: async () => ETAG, etag: async () => etag },
    routerReports: {
      events: EVENTS, roleArn: ROLE, bus: BUS,
      assume: async (input) => {
        sessions.push(input);
        if (assume) return assume(input) as never;
        return { AccessKeyId: 'ASIAEXAMPLEROUTER', SecretAccessKey: SECRET, SessionToken: SESSION_TOKEN, Expiration: EXPIRATION };
      },
    },
  });
  return { api, sessions, audit };
}

// The session policy the role's session is cut to: PutEvents on the manager's bus, for that router's source alone.
const policyOf = (project: string, region: string) => ({
  Version: '2012-10-17',
  Statement: [{
    Effect: 'Allow', Action: 'events:PutEvents', Resource: BUS.arn,
    Condition: { StringEquals: { 'events:source': `dormeto.router.gcp/${project}/${region}` } },
  }],
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /routers/credentials: a Google Cloud router\'s credentials for the manager\'s bus', () => {
  it('answers an hour\'s credentials, the bus, the router\'s source and settings.json\'s ETag, from a session cut to that router\'s source', async () => {
    const m = manager();
    const res = await m.api(post());
    expect([res.statusCode, json(res)]).toEqual([200, {
      credentials: { accessKeyId: 'ASIAEXAMPLEROUTER', secretAccessKey: SECRET, sessionToken: SESSION_TOKEN, expiration: EXPIRATION.toISOString() },
      bus: { name: BUS.name, region: BUS.region },
      source: `dormeto.router.gcp/${PROJECT}/${REGION}`,
      managerSettings: { etag: ETAG },
    }]);
    expect(m.sessions).toHaveLength(1);
    const [session] = m.sessions;
    expect([session!.RoleArn, session!.RoleSessionName, session!.DurationSeconds]).toEqual([ROLE, `${PROJECT}.${REGION}`, 3600]);
    expect(JSON.parse(session!.Policy)).toEqual(policyOf(PROJECT, REGION));
    expect(m.audit).toEqual([]);
  });

  it('names each router\'s own source in its session, whatever the body says, and reads no body', async () => {
    const other = 'dmtr-us-central1@another-project.iam.gserviceaccount.com';
    const m = manager({ routers: [registered(), registered({ account: 'another-project', region: 'us-central1', name: 'dmtr-us-central1' })] });
    const forged = JSON.stringify({ project: 'someone-else', region: 'asia-east1', source: 'dormeto.router' });
    expect((await m.api(post(googleClaims(), { body: forged }))).statusCode).toBe(200);
    expect((await m.api(post(googleClaims({ email: other }), { body: 'not json' }))).statusCode).toBe(200);
    expect(m.sessions.map((s) => [s.RoleSessionName, JSON.parse(s.Policy)])).toEqual([
      [`${PROJECT}.${REGION}`, policyOf(PROJECT, REGION)],
      ['another-project.us-central1', policyOf('another-project', 'us-central1')],
    ]);
  });

  it('names the session <project>.<region> within the characters and the 64 STS allows, for the longest project and region', async () => {
    const project = `p${'a'.repeat(28)}z`;
    const region = 'northamerica-northeast2';
    const m = manager({ routers: [registered({ account: project, region })] });
    expect((await m.api(post(googleClaims({ email: `dmtr-${region}@${project}.iam.gserviceaccount.com` })))).statusCode).toBe(200);
    expect(m.sessions[0]!.RoleSessionName).toBe(`${project}.${region}`);
    expect(m.sessions[0]!.RoleSessionName).toMatch(/^[\w+=,.@-]{2,64}$/);
  });

  it('answers a null ETag while settings.json was never written', async () => {
    const res = await manager({ etag: null }).api(post());
    expect([res.statusCode, json(res).managerSettings]).toEqual([200, { etag: null }]);
  });

  it('refuses with 403 router_unknown, asking STS for nothing, a token that is not a registered router\'s', async () => {
    const cases: [string, ReturnType<typeof manager>, ApiEvent][] = [
      ['an unverified email', manager(), post(googleClaims({ email_verified: 'false' }))],
      ['no email', manager(), post(googleClaims({ email: '' }))],
      ['another service account of the project', manager(), post(googleClaims({ email: `dmt-dev-command@${PROJECT}.iam.gserviceaccount.com` }))],
      ['a user\'s account', manager(), post(googleClaims({ email: 'dmtr-europe-west2@gmail.com' }))],
      ['a domain after the service account\'s', manager(), post(googleClaims({ email: `${EMAIL}.example.com` }))],
      ['a region that is not Google Cloud\'s', manager(), post(googleClaims({ email: `dmtr-eu-west-1@${PROJECT}.iam.gserviceaccount.com` }))],
      ['a 12-digit project', manager(), post(googleClaims({ email: `dmtr-${REGION}@123456789012.iam.gserviceaccount.com` }))],
      ['a router of another region', manager(), post(googleClaims({ email: `dmtr-us-central1@${PROJECT}.iam.gserviceaccount.com` }))],
      ['a router of another project', manager(), post(googleClaims({ email: `dmtr-${REGION}@another-project.iam.gserviceaccount.com` }))],
      ['a router not registered', manager({ routers: [] }), post()],
      ['an AWS registration of that name', manager({ routers: [registered({ cloud: undefined })] }), post()],
      ['no Google Cloud connection', manager({ connected: false }), post()],
      ['no claims', manager(), post(null)],
      ['a dashboard user\'s claims', manager(), post({ sub: 'u-1', email: 'ops@example.com', 'cognito:groups': '[dmt-admin]' })],
    ];
    for (const [what, m, request] of cases) {
      const res = await m.api(request);
      expect([res.statusCode, json(res).error], what).toEqual([403, 'router_unknown']);
      expect(m.sessions, what).toEqual([]);
    }
  });

  it('answers 502 no_credentials when STS fails or answers no credentials, with a warning that carries none', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const assume of [
      async () => { throw Object.assign(new Error('User: arn:aws:sts::121014831971:assumed-role/dmt-dev-manager-api is not authorized to perform: sts:AssumeRole'), { name: 'AccessDenied' }); },
      async () => ({ AccessKeyId: 'ASIAEXAMPLEROUTER', SecretAccessKey: SECRET }),
    ]) {
      const res = await manager({ assume }).api(post());
      expect([res.statusCode, json(res).error]).toEqual([502, 'no_credentials']);
      expect(res.body).not.toContain(SECRET);
    }
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.map((l) => [JSON.parse(l).event, JSON.parse(l).project, JSON.parse(l).region])).toEqual(Array(2).fill(['RouterCredentialsNotIssued', PROJECT, REGION]));
    for (const line of lines) expect(line).not.toContain(SECRET);
  });

  it('never logs the credentials it answers', async () => {
    const said: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { said.push(args.map(String).join(' ')); });
    expect((await manager().api(post())).statusCode).toBe(200);
    for (const line of said) expect([line.includes(SECRET), line.includes(SESSION_TOKEN)]).toEqual([false, false]);
  });

  it('is the route only at POST /routers/credentials: the same path under /api or /iam is a user\'s, and another method is not found', async () => {
    for (const request of [post(googleClaims(), { path: '/api/routers/credentials' }), post(googleClaims(), { path: '/iam/routers/credentials' }), post(googleClaims(), { method: 'GET' })]) {
      const m = manager();
      const res = await m.api(request);
      expect(res.statusCode, request.rawPath).not.toBe(200);
      expect(m.sessions).toEqual([]);
    }
    expect((await manager().api(post(googleClaims(), { method: 'GET' }))).statusCode).toBe(404);
  });

  it('never takes a Google token for a user: a router\'s token that reaches another path (a trailing slash, the relay\'s old path, any route) is refused as unsigned', async () => {
    for (const path of ['/routers/credentials/', '/routers/events', '/api/me', '/me']) {
      const m = manager();
      const res = await m.api(post(googleClaims(), { path, method: path.startsWith('/routers/') ? 'POST' : 'GET' }));
      expect([res.statusCode, json(res).error], path).toEqual([401, 'unauthorized']);
      expect(m.sessions).toEqual([]);
    }
  });

  it('is the route on its route key, whatever path API Gateway matched it on', async () => {
    const m = manager();
    const res = await m.api({ ...post(googleClaims(), { path: '/routers/credentials/' }), routeKey: 'POST /routers/credentials' });
    expect([res.statusCode, json(res).source]).toEqual([200, `dormeto.router.gcp/${PROJECT}/${REGION}`]);
  });

  it('answers 404 while the manager has no role for the routers\' reports', async () => {
    const api = createApi({ routers: [], version: '0.25.0', invoke: async () => ({}), audit: { write: async () => {}, list: async () => [] } });
    expect((await api(post())).statusCode).toBe(404);
  });
});
