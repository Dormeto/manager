// The manager's calls to a Google Cloud router (Google Cloud manager design §5.1, §6.2): the AWS controller's payload
// POSTed to the controller's /v1/actions with the command account's ID token for the controller's origin, the whole call
// bounded; Google's refusal of the token is the refusal manager-access-missing, a router without /v1/actions is too old.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accessMissingText, actOnRouter, callRouter, createGoogle, RouterCallError, routerHealth, routerTooOld, tooOldText, type GoogleConnection } from '../src/index.js';

const T0 = Date.parse('2026-11-09T12:00:00Z');
const COMMAND = 'dmt-dev-command@dormeto-host.iam.gserviceaccount.com';
const CONTROLLER = 'https://dmtr-europe-west2-controller-abc123-nw.a.run.app';
const ACTIONS = `${CONTROLLER}/v1/actions`;
const ROUTER = { controller: CONTROLLER };

const connection: GoogleConnection = {
  project: 'dormeto-host', projectNumber: '1034397096264', pool: 'dmt-dev', provider: 'aws-121014831971', scopes: ['projects/dormeto-host'],
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

  // What Google answered is kept, with its host, status, reason and message (cut to 200 characters), so the refusal's cause
  // can be seen: the stage (STS, iamcredentials or the controller) and Google's words, never a token or a signature.
  it('keeps what iamcredentials answered: its host, status, reason and message', async () => {
    const err = await tokenRefusal(':generateIdToken', json(403, {
      error: { code: 403, message: 'Permission \'iam.serviceAccounts.getOpenIdToken\' denied on resource.', status: 'PERMISSION_DENIED', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'IAM_PERMISSION_DENIED' }] },
    }));
    expect(err.said).toBe('Google: iamcredentials.googleapis.com 403 IAM_PERMISSION_DENIED: Permission \'iam.serviceAccounts.getOpenIdToken\' denied on resource.');
    expect(accessMissingText('dormeto-host', 'dev', err.said)).toBe(`${accessMissingText('dormeto-host', 'dev')} (${err.said})`);
  });

  it('keeps what STS answered: its host, status, reason and message', async () => {
    const err = await tokenRefusal('https://sts.googleapis.com/v1/token', json(400, { error: 'invalid_grant', error_description: 'The audience in ID Token does not match the expected audience.' }));
    expect(err.said).toBe('Google: sts.googleapis.com 400 invalid_grant: The audience in ID Token does not match the expected audience.');
  });

  it('keeps what Google answered in front of the controller: its host, status and page, cut to 200 characters', async () => {
    const page = await failure(callRouter(fakeGoogle(() => html(403, 'Forbidden')).google, ROUTER, { action: 'list' }, { timeoutMs: 10_000 }));
    expect(page.said).toBe('Google: dmtr-europe-west2-controller-abc123-nw.a.run.app 403: 403 Forbidden');
    const long = await failure(callRouter(fakeGoogle(() => json(403, { error: { code: 403, message: 'x'.repeat(500), status: 'PERMISSION_DENIED' } })).google, ROUTER, { action: 'list' }, { timeoutMs: 10_000 }));
    expect(long.said).toBe(`Google: dmtr-europe-west2-controller-abc123-nw.a.run.app 403 PERMISSION_DENIED: ${'x'.repeat(200)}`);
    const empty = await failure(callRouter(fakeGoogle(() => new Response('', { status: 401 })).google, ROUTER, { action: 'list' }, { timeoutMs: 10_000 }));
    expect(empty.said).toBe('Google: dmtr-europe-west2-controller-abc123-nw.a.run.app 401: HTTP 401');
  });

  it('says Google\'s HTML page as its readable words, not its markup', async () => {
    const page = '<!DOCTYPE html><html lang=en><meta charset=utf-8><meta name=viewport content="initial-scale=1"><title>Error 403 (Forbidden)!!1</title><style>*{margin:0}body{color:#222}</style><a href=//www.google.com/><span id=logo></span></a><p><b>403.</b> <ins>That\u2019s an error.</ins><p>Your client does not have permission to get URL <code>/v1/actions</code> from this server.';
    const err = await failure(callRouter(fakeGoogle(() => new Response(page, { status: 403, headers: { 'content-type': 'text/html' } })).google, ROUTER, { action: 'list' }, { timeoutMs: 10_000 }));
    expect(err.said).toBe('Google: dmtr-europe-west2-controller-abc123-nw.a.run.app 403: Error 403 (Forbidden)!!1');
    const untitled = await failure(callRouter(fakeGoogle(() => new Response('<html><style>p{x:y}</style><body><p>Your client &amp; you <code>/v1/actions</code> &lt;none&gt;</p></body></html>', { status: 403 })).google, ROUTER, { action: 'list' }, { timeoutMs: 10_000 }));
    expect(untitled.said).toBe('Google: dmtr-europe-west2-controller-abc123-nw.a.run.app 403: Your client & you /v1/actions <none>');
  });

  it('says nothing of a credential Google\'s answer echoes', async () => {
    const secrets = ['eyJhbGciOi.eyJhdWQiOiJ4In0.c2lnbmF0dXJl', 'ya29.a0AfH6SMB-x_y.z', 'Bearer abc123def', 'x-amz-security-token=FwoGZXIvYXdz', 'X-Amz-Signature=0123abcd', 'Signature=ab%2Fc+d=', 'AKIAIOSFODNN7EXAMPLE', 'ASIAIOSFODNN7EXAMPLE'];
    for (const secret of secrets) {
      const json403 = await failure(callRouter(fakeGoogle(() => json(403, { error: { code: 403, message: `bad ${secret} here`, status: 'PERMISSION_DENIED' } })).google, ROUTER, { action: 'list' }, { timeoutMs: 10_000 }));
      expect(json403.said, secret).toBe('Google: dmtr-europe-west2-controller-abc123-nw.a.run.app 403 PERMISSION_DENIED: bad [redacted] here');
      const text = await failure(callRouter(fakeGoogle(() => new Response(`denied ${secret}`, { status: 403 })).google, ROUTER, { action: 'list' }, { timeoutMs: 10_000 }));
      expect(text.said, secret).toBe('Google: dmtr-europe-west2-controller-abc123-nw.a.run.app 403: denied [redacted]');
    }
  });

  it('redacts the credentials a failure\'s own message echoes: the controller\'s 503 JSON, a token stage\'s 5xx', async () => {
    const echo = 'bad eyJhbGciOi.eyJhdWQiOiJ4In0.c2ln and signature=ab%2Fc here';
    const own = await failure(callRouter(fakeGoogle(() => json(503, { error: 'unavailable', message: echo })).google, ROUTER, { action: 'list' }, { timeoutMs: 10_000 }));
    expect(own.message).toBe('bad [redacted] and [redacted] here');
    const token = await tokenRefusal(':generateIdToken', json(503, { error: { code: 503, message: echo, status: 'UNAVAILABLE' } }));
    expect([token.message, token.said]).toEqual(['bad [redacted] and [redacted] here', 'Google: iamcredentials.googleapis.com 503 UNAVAILABLE: bad [redacted] and [redacted] here']);
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

// A router too old to poll has no /v1/actions, but every router answers its health: the poll reads its version there.
describe('routerHealth', () => {
  const HEALTH = `${CONTROLLER}/v1/health`;

  it('GETs the controller\'s /v1/health with the command account\'s ID token for the controller\'s origin, and answers its version', async () => {
    const g = fakeGoogle((req) => (req.url === HEALTH ? json(200, { version: '0.40.0-dev.1', project: 'dormeto-dev', region: 'europe-west2' }) : json(404, { error: 'no route' })));
    expect(await routerHealth(g.google, { controller: `${CONTROLLER}/` }, { timeoutMs: 10_000 })).toEqual({ version: '0.40.0-dev.1', project: 'dormeto-dev', region: 'europe-west2' });
    const [call, ...more] = g.to(HEALTH);
    expect(more).toEqual([]);
    expect([call!.method, call!.body, call!.headers['content-type']]).toEqual(['GET', '', undefined]);
    const token = call!.headers['authorization']!.replace(/^Bearer /, '');
    expect(JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString())).toMatchObject({ aud: CONTROLLER });
  });

  it('reads Google\'s answers as callRouter does: its 403 manager-access-missing, its own 404 Google\'s, a token refused the token\'s', async () => {
    const denied = await failure(routerHealth(fakeGoogle(() => html(403, 'Forbidden')).google, ROUTER, { timeoutMs: 10_000 }));
    expect([denied.refusal, denied.status, denied.google]).toEqual(['manager-access-missing', 403, true]);
    const gone = await failure(routerHealth(fakeGoogle(() => html(404, 'Page not found')).google, ROUTER, { timeoutMs: 10_000 }));
    expect([gone.refusal, gone.status, gone.google, gone.message]).toEqual([undefined, 404, true, 'dmtr-europe-west2-controller-abc123-nw.a.run.app answered HTTP 404']);
    const token = await failure(routerHealth(fakeGoogle(() => json(200, {}), (req) => (req.url.endsWith(':generateIdToken') ? json(403, { error: { code: 403, message: 'denied', status: 'PERMISSION_DENIED' } }) : undefined)).google, ROUTER, { timeoutMs: 10_000 }));
    expect([token.refusal, token.token]).toEqual(['manager-access-missing', true]);
  });

  it('answers a health without a version, or not JSON, as a failure that says so', async () => {
    const none = await failure(routerHealth(fakeGoogle(() => json(200, { status: 'ok' })).google, ROUTER, { timeoutMs: 10_000 }));
    expect([none.refusal, none.status, none.message]).toEqual([undefined, 200, 'dmtr-europe-west2-controller-abc123-nw.a.run.app answered its health without a version']);
    const page = await failure(routerHealth(fakeGoogle(() => new Response('<html>sign in</html>', { status: 200 })).google, ROUTER, { timeoutMs: 10_000 }));
    expect([page.status, page.message]).toEqual([200, 'dmtr-europe-west2-controller-abc123-nw.a.run.app answered something other than JSON']);
  });
});

describe('routerTooOld', () => {
  it('is a known version below 0.40.0; an unknown version is called', () => {
    expect(['0.39.0', '0.9.12', '0.39.9-rc.1'].map(routerTooOld)).toEqual([true, true, true]);
    expect(['0.40.0', '0.40.0-rc.1', '1.0.0', '', 'dev'].map(routerTooOld)).toEqual([false, false, false, false, false]);
  });

  it('compares major.minor.patch only: a dev router of 0.40.0 meets the minimum, one of 0.39.0 doesn\'t', () => {
    expect(['0.40.0-dev.1', '0.41.0-dev.2', '0.39.0-dev.3', '0.39.12-dev.1'].map(routerTooOld)).toEqual([false, false, true, true]);
  });
});

describe('the refusals\' texts', () => {
  it('name the command that fixes each, as the API answers them and the poll records them', () => {
    expect(accessMissingText('dormeto-host', 'dev')).toBe('the manager\'s accounts can\'t reach the router: dormeto gcp connect --project dormeto-host --profile <profile> --env dev');
    expect(tooOldText('0.39.0', 'dormeto-dev', 'europe-west2', '0.40.0')).toBe('router 0.39.0 can\'t report to the manager: dormeto gcp install --project dormeto-dev --region europe-west2 --version 0.40.0');
    expect(tooOldText('', 'dormeto-dev', 'europe-west2', undefined)).toBe('router older than 0.40.0 can\'t report to the manager: dormeto gcp install --project dormeto-dev --region europe-west2');
  });
});

describe('actOnRouter', () => {
  const router = { controller: CONTROLLER, account: 'dormeto-dev', region: 'europe-west2', version: '0.40.0' };
  const opts = { timeoutMs: 10_000, env: 'dev', routerVersion: '0.40.0' };
  const failing = (promise: Promise<unknown>) => promise.then(() => { throw new Error('answered'); }, (e: unknown) => e as RouterCallError);

  it('sends the payload with refusals asked and answers the body, a refusal as it is', async () => {
    const g = fakeGoogle(() => json(200, { refused: { code: 'not_found', message: 'workload not configured: w' } }));
    expect(await actOnRouter({ connection, google: g.google }, router, { action: 'status', workloadId: 'w' }, opts)).toEqual({ refused: { code: 'not_found', message: 'workload not configured: w' } });
    expect(JSON.parse(g.to(ACTIONS)[0]!.body)).toEqual({ action: 'status', workloadId: 'w', refusals: true });
  });

  it('refuses a router before 0.40.0 without calling it', async () => {
    const g = fakeGoogle(() => json(200, {}));
    const err = await failing(actOnRouter({ connection, google: g.google }, { ...router, version: '0.39.0' }, { action: 'status' }, opts));
    expect([err.refusal, err.message]).toEqual(['router-too-old', tooOldText('0.39.0', 'dormeto-dev', 'europe-west2', '0.40.0')]);
    expect(g.seen).toEqual([]);
  });

  it('refuses a router without a controller as unknown and a missing connection as no access', async () => {
    const g = fakeGoogle(() => json(200, {}));
    const { controller: _, ...unplaced } = router;
    expect((await failing(actOnRouter({ connection, google: g.google }, unplaced, { action: 'status' }, opts))).refusal).toBe('router-unknown');
    const err = await failing(actOnRouter(null, router, { action: 'status' }, opts));
    expect([err.refusal, err.message]).toEqual(['manager-access-missing', accessMissingText('<host>', 'dev')]);
  });

  it('turns Google refusing the token into manager-access-missing with its words, and a router without /v1/actions into too old', async () => {
    const denied = await failing(actOnRouter({ connection, google: fakeGoogle(() => html(403, 'Forbidden')).google }, router, { action: 'status' }, opts));
    expect(denied.refusal).toBe('manager-access-missing');
    expect(denied.message).toMatch(/^the manager's accounts can't reach the router: dormeto gcp connect --project dormeto-host .* \(Google: /);
    const old = await failing(actOnRouter({ connection, google: fakeGoogle(() => json(404, { error: 'not-found' })).google }, router, { action: 'status' }, opts));
    expect([old.refusal, old.message]).toEqual(['router-too-old', tooOldText('', 'dormeto-dev', 'europe-west2', '0.40.0')]);
  });

  it('throws any other failure as it is, without a refusal', async () => {
    const err = await failing(actOnRouter({ connection, google: fakeGoogle(() => json(500, { error: 'boom' })).google }, router, { action: 'status' }, opts));
    expect([err.message, err.refusal]).toEqual(['boom', undefined]);
  });
});
