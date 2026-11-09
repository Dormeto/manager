// The manager's calls to a Google Cloud router (Google Cloud manager design §5.1, §6.2): the AWS controller's payload
// POSTed to the controller's /v1/actions with the command account's ID token for the controller's origin, the whole call
// bounded; Google's refusal of the token is the refusal manager-access-missing, a router without /v1/actions is too old.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accessMissingText, callRouter, createGoogle, RouterCallError, routerTooOld, tooOldText, type GoogleConnection } from '../src/index.js';

const T0 = Date.parse('2026-11-09T12:00:00Z');
const COMMAND = 'dmt-dev-command@dormeto-host.iam.gserviceaccount.com';
const CONTROLLER = 'https://dmtr-europe-west2-controller-abc123-nw.a.run.app';
const ACTIONS = `${CONTROLLER}/v1/actions`;
const ROUTER = { controller: CONTROLLER };

const connection: GoogleConnection = {
  project: 'dormeto-host', projectNumber: '1034397096264', pool: 'dmt-dev', provider: 'aws', scopes: ['projects/dormeto-host'],
  serviceAccounts: { discovery: 'dmt-dev-discovery@dormeto-host.iam.gserviceaccount.com', command: COMMAND },
  routers: [{ project: 'dormeto-dev', region: 'europe-west2' }], googleAdded: [], connectedAt: '2026-11-09T10:00:00.000Z', connectedBy: 'admin@example.com', cli: '0.14.0',
};
const credentials = { accessKeyId: 'ASIAEXAMPLE', secretAccessKey: 'secret', sessionToken: 'the-session-token' };

type Seen = { url: string; method: string; headers: Record<string, string>; body: string };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const html = (status: number, title: string) => new Response(`<html><head><title>${status} ${title}</title></head><body><h1>Error: ${title}</h1></body></html>`, { status, headers: { 'content-type': 'text/html' } });
const jwt = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;

// Google's token endpoints, then the controller as `controller` answers it.
function fakeGoogle(controller: (req: Seen) => Response | Promise<Response>, tokens?: (req: Seen) => Response | Promise<Response> | undefined) {
  let n = 0;
  const seen: Seen[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const req: Seen = { url: String(input), method: init?.method ?? 'GET', headers: { ...(init?.headers as Record<string, string>) }, body: String(init?.body ?? '') };
    seen.push(req);
    const own = tokens?.(req);
    if (own) return own;
    if (req.url === 'https://sts.googleapis.com/v1/token') return json(200, { access_token: `federated-${++n}`, expires_in: 3600 });
    if (req.url.endsWith(':generateIdToken')) return json(200, { token: jwt({ aud: (JSON.parse(req.body) as { audience: string }).audience, exp: Math.floor(T0 / 1000) + 3600, n: ++n }) });
    return controller(req);
  });
  const google = createGoogle({ connection, credentials, fetch: fetch as typeof globalThis.fetch, now: () => T0 });
  return { google, seen, to: (url: string) => seen.filter((s) => s.url === url) };
}

const failure = (promise: Promise<unknown>) => promise.then(() => { throw new Error('answered'); }, (e: unknown) => e as RouterCallError);

afterEach(() => {
  vi.useRealTimers();
});

describe('callRouter', () => {
  it('POSTs the payload as JSON to /v1/actions with the command account\'s ID token for the controller\'s origin, and answers its JSON', async () => {
    const g = fakeGoogle(() => json(200, { requested: true }));
    expect(await callRouter(g.google, ROUTER, { action: 'request-nap', workloadId: 'demo', refusals: true }, { timeoutMs: 10_000 })).toEqual({ requested: true });
    const [ask] = g.to(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${COMMAND}:generateIdToken`);
    expect(JSON.parse(ask!.body)).toEqual({ audience: CONTROLLER, includeEmail: true });
    const [call] = g.to(ACTIONS);
    expect(call).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' } });
    expect(JSON.parse(call!.body)).toEqual({ action: 'request-nap', workloadId: 'demo', refusals: true });
    const token = call!.headers['authorization']!.replace(/^Bearer /, '');
    expect(JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString())).toMatchObject({ aud: CONTROLLER });
  });

  it('calls the origin of a controller URL written with a trailing slash', async () => {
    const g = fakeGoogle(() => json(200, {}));
    await callRouter(g.google, { controller: `${CONTROLLER}/` }, { action: 'router' }, { timeoutMs: 10_000 });
    expect(g.to(ACTIONS)).toHaveLength(1);
  });

  it('gives back a refusal the controller answers, as the AWS controller answers it, for the caller to read', async () => {
    const refused = { refused: { code: 'not_found', message: 'workload not configured: gone' } };
    expect(await callRouter(fakeGoogle(() => json(200, refused)).google, ROUTER, { action: 'status' }, { timeoutMs: 10_000 })).toEqual(refused);
    expect(await callRouter(fakeGoogle(() => json(404, refused)).google, ROUTER, { action: 'status' }, { timeoutMs: 10_000 })).toEqual(refused);
  });

  it('answers Google\'s 403 in front of the controller (an HTML page) as the refusal manager-access-missing', async () => {
    const err = await failure(callRouter(fakeGoogle(() => html(403, 'Forbidden')).google, ROUTER, { action: 'list' }, { timeoutMs: 10_000 }));
    expect(err).toBeInstanceOf(RouterCallError);
    expect([err.refusal, err.status, err.google, err.token]).toEqual(['manager-access-missing', 403, true, false]);
  });

  it('answers Google\'s 401 (its JSON) as manager-access-missing once a new token was refused too', async () => {
    const g = fakeGoogle(() => json(401, { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } }));
    const err = await failure(callRouter(g.google, ROUTER, { action: 'list' }, { timeoutMs: 10_000 }));
    expect([err.refusal, err.status, err.google, err.message]).toEqual(['manager-access-missing', 401, true, 'Request had invalid authentication credentials.']);
    expect(g.to(ACTIONS)).toHaveLength(2);
  });

  // A broken connection fails before the controller is called: the token's failure is marked apart from Google's answer
  // to the controller URL (never a router gone), and is manager-access-missing.
  const tokenRefusal = async (url: string, refusal: Response) => {
    const g = fakeGoogle(() => json(200, {}), (req) => (req.url === url || req.url.endsWith(url) ? refusal : undefined));
    const err = await failure(callRouter(g.google, ROUTER, { action: 'list' }, { timeoutMs: 10_000 }));
    expect(g.to(ACTIONS)).toHaveLength(0);
    return err;
  };

  it('answers iamcredentials\' refusal of the ID token (the impersonation grant revoked) as manager-access-missing, marked as the token\'s', async () => {
    const err = await tokenRefusal(':generateIdToken', json(403, {
      error: { code: 403, message: 'Permission \'iam.serviceAccounts.getOpenIdToken\' denied on resource (or it may not exist).', status: 'PERMISSION_DENIED' },
    }));
    expect([err.refusal, err.status, err.google, err.token]).toEqual(['manager-access-missing', 403, false, true]);
  });

  it('answers iamcredentials\' 404 (the command account deleted) as manager-access-missing, never as Google\'s 404 for the router', async () => {
    const err = await tokenRefusal(':generateIdToken', json(404, { error: { code: 404, message: 'Not found; Gaia id not found for email dmt-dev-command@dormeto-host.iam.gserviceaccount.com', status: 'NOT_FOUND' } }));
    expect([err.refusal, err.status, err.google, err.token]).toEqual(['manager-access-missing', 404, false, true]);
  });

  it('answers STS\'s invalid_target (the pool or provider gone) and invalid_grant (the provider refuses the role) as manager-access-missing', async () => {
    const target = await tokenRefusal('https://sts.googleapis.com/v1/token', json(400, { error: 'invalid_target', error_description: 'The target service indicated by the "audience" parameters is invalid.' }));
    expect([target.refusal, target.status, target.google, target.token]).toEqual(['manager-access-missing', 400, false, true]);
    const grant = await tokenRefusal('https://sts.googleapis.com/v1/token', json(400, { error: 'invalid_grant', error_description: 'The audience in ID Token does not match the expected audience.' }));
    expect([grant.refusal, grant.status, grant.google, grant.token]).toEqual(['manager-access-missing', 400, false, true]);
  });

  it('keeps STS\'s 5xx a failure of the call, not the manager\'s access', async () => {
    const err = await tokenRefusal('https://sts.googleapis.com/v1/token', new Response('<html>Service Unavailable</html>', { status: 503 }));
    expect([err.refusal, err.status, err.google, err.token]).toEqual([undefined, 503, false, true]);
  });

  it('reads a 403 in the controller\'s own JSON as its failure, not as the manager\'s access', async () => {
    const err = await failure(callRouter(fakeGoogle(() => json(403, { error: 'custom pages are off on this router' })).google, ROUTER, { action: 'waiting-page' }, { timeoutMs: 10_000 }));
    expect([err.refusal, err.status, err.google, err.message]).toEqual([undefined, 403, false, 'custom pages are off on this router']);
  });

  it('answers the controller\'s JSON 404 (a router older than 0.40.0 has no /v1/actions) as the refusal router-too-old', async () => {
    const err = await failure(callRouter(fakeGoogle(() => json(404, { error: 'no route for POST /v1/actions', reason: 'not-found' })).google, ROUTER, { action: 'router' }, { timeoutMs: 10_000 }));
    expect([err.refusal, err.status, err.google]).toEqual(['router-too-old', 404, false]);
  });

  it('keeps Google\'s own 404 (an HTML page: no such service) apart, as Google\'s', async () => {
    const err = await failure(callRouter(fakeGoogle(() => html(404, 'Page not found')).google, ROUTER, { action: 'router' }, { timeoutMs: 10_000 }));
    expect([err.refusal, err.status, err.google, err.token, err.message]).toEqual([undefined, 404, true, false, 'dmtr-europe-west2-controller-abc123-nw.a.run.app answered HTTP 404']);
  });

  // The controller always answers JSON: an empty body in front of it is Google's.
  it('reads an empty 404 as Google\'s own (no such service), never as a router too old', async () => {
    const err = await failure(callRouter(fakeGoogle(() => new Response('', { status: 404 })).google, ROUTER, { action: 'router' }, { timeoutMs: 10_000 }));
    expect([err.refusal, err.status, err.google, err.token, err.message]).toEqual([undefined, 404, true, false, 'dmtr-europe-west2-controller-abc123-nw.a.run.app answered HTTP 404']);
  });

  it('reads an empty 401 or 403 as Google\'s refusal of the manager\'s token: manager-access-missing', async () => {
    for (const status of [401, 403]) {
      const err = await failure(callRouter(fakeGoogle(() => new Response('', { status })).google, ROUTER, { action: 'list' }, { timeoutMs: 10_000 }));
      expect([err.refusal, err.status, err.google], String(status)).toEqual(['manager-access-missing', status, true]);
    }
  });

  it('says an action the router does not know in the AWS controller\'s words', async () => {
    const err = await failure(callRouter(fakeGoogle(() => json(400, { error: 'unknown-action' })).google, ROUTER, { action: 'exclude' }, { timeoutMs: 10_000 }));
    expect([err.status, err.message]).toEqual([400, 'unknown action: exclude']);
  });

  it('reads the controller\'s failure from its JSON message or error', async () => {
    expect((await failure(callRouter(fakeGoogle(() => json(500, { error: 'internal', message: 'Firestore unavailable' })).google, ROUTER, { action: 'list' }, { timeoutMs: 10_000 }))).message).toBe('Firestore unavailable');
    expect((await failure(callRouter(fakeGoogle(() => json(500, { error: 'boom' })).google, ROUTER, { action: 'list' }, { timeoutMs: 10_000 }))).message).toBe('boom');
  });

  it('answers a 2xx that is not JSON as a failure', async () => {
    const err = await failure(callRouter(fakeGoogle(() => new Response('<html>sign in</html>', { status: 200 })).google, ROUTER, { action: 'list' }, { timeoutMs: 10_000 }));
    expect([err.refusal, err.status, err.message]).toEqual([undefined, 200, 'dmtr-europe-west2-controller-abc123-nw.a.run.app answered something other than JSON']);
  });

  it('gives up on the whole call after timeoutMs, the token\'s requests included', async () => {
    vi.useFakeTimers();
    const later = (ms: number) => new Promise<Response>((resolve) => { setTimeout(() => resolve(json(200, { token: jwt({ exp: Math.floor(T0 / 1000) + 3600 }) })), ms); });
    // 5 s for the ID token, then 5 s for the controller: each within the 10 s of silence, the whole past 8 s.
    const g = fakeGoogle(() => later(5_000), (req) => (req.url.endsWith(':generateIdToken') ? later(5_000) : undefined));
    let settled: unknown = 'pending';
    const call = failure(callRouter(g.google, ROUTER, { action: 'list' }, { timeoutMs: 8_000 }));
    void call.then((v) => { settled = v; });
    await vi.advanceTimersByTimeAsync(7_999);
    expect(settled).toBe('pending');
    expect(g.to(ACTIONS)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await call).toMatchObject({ message: 'no answer within 8000 ms', status: 0 });
    await vi.advanceTimersByTimeAsync(5_000);
  });
});

describe('routerTooOld', () => {
  it('is a known version below 0.40.0; an unknown version is called', () => {
    expect(['0.39.0', '0.9.12', '0.39.9-rc.1'].map(routerTooOld)).toEqual([true, true, true]);
    expect(['0.40.0', '0.40.0-rc.1', '1.0.0', '', 'dev'].map(routerTooOld)).toEqual([false, false, false, false, false]);
  });
});

describe('the refusals\' texts', () => {
  it('name the command that fixes each, as the API answers them and the poll records them', () => {
    expect(accessMissingText('dormeto-host', 'dev')).toBe('the manager\'s accounts can\'t reach the router: dormeto gcp connect --project dormeto-host --profile <profile> --env dev');
    expect(tooOldText('0.39.0', 'dormeto-dev', 'europe-west2', '0.40.0')).toBe('router 0.39.0 can\'t report to the manager: dormeto gcp install --project dormeto-dev --region europe-west2 --version 0.40.0');
    expect(tooOldText('', 'dormeto-dev', 'europe-west2', undefined)).toBe('router older than 0.40.0 can\'t report to the manager: dormeto gcp install --project dormeto-dev --region europe-west2');
  });
});
