// The manager's calls to a Google Cloud router (Google Cloud manager design §5.1, §6.2): the AWS controller's payload
// POSTed to the controller's /v1/actions with the command account's ID token for the controller's origin, the whole call
// bounded; Google's refusal of the token is the refusal no_access, a router without /v1/actions is too old.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accessMissingText, brokenConnection, callRouter, GoogleError, RouterCallError, routerHealth } from '../src/index.js';
import { ACTIONS, COMMAND, CONTROLLER, fakeGoogle, html, json, jwt, silent, T0 } from './fake-google.js';

const ROUTER = { controller: CONTROLLER };

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

  it('answers Google\'s 403 in front of the controller (an HTML page) as the refusal no_access', async () => {
    const err = await failure(callRouter(fakeGoogle(() => html(403, 'Forbidden')).google, ROUTER, { action: 'list' }, { timeoutMs: 10_000 }));
    expect(err).toBeInstanceOf(RouterCallError);
    expect([err.refusal, err.status, err.google, err.token]).toEqual(['no_access', 403, true, false]);
  });

  it('answers Google\'s 401 (its JSON) as no_access once a new token was refused too', async () => {
    const g = fakeGoogle(() => json(401, { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } }));
    const err = await failure(callRouter(g.google, ROUTER, { action: 'list' }, { timeoutMs: 10_000 }));
    expect([err.refusal, err.status, err.google, err.message]).toEqual(['no_access', 401, true, 'Request had invalid authentication credentials.']);
    expect(g.to(ACTIONS)).toHaveLength(2);
  });

  // A broken connection fails before the controller is called: the token's failure is marked apart from Google's answer
  // to the controller URL (never a router gone), and is no_access.
  const tokenRefusal = async (url: string, refusal: Response) => {
    const g = fakeGoogle(() => json(200, {}), (req) => (req.url === url || req.url.endsWith(url) ? refusal : undefined));
    const err = await failure(callRouter(g.google, ROUTER, { action: 'list' }, { timeoutMs: 10_000 }));
    expect(g.to(ACTIONS)).toHaveLength(0);
    return err;
  };

  it('answers iamcredentials\' refusal of the ID token (the impersonation grant revoked) as no_access, marked as the token\'s', async () => {
    const err = await tokenRefusal(':generateIdToken', json(403, {
      error: { code: 403, message: 'Permission \'iam.serviceAccounts.getOpenIdToken\' denied on resource (or it may not exist).', status: 'PERMISSION_DENIED' },
    }));
    expect([err.refusal, err.status, err.google, err.token]).toEqual(['no_access', 403, false, true]);
  });

  it('answers iamcredentials\' 404 (the command account deleted) as no_access, never as Google\'s 404 for the router', async () => {
    const err = await tokenRefusal(':generateIdToken', json(404, { error: { code: 404, message: 'Not found; Gaia id not found for email dmt-dev-command@dormeto-host.iam.gserviceaccount.com', status: 'NOT_FOUND' } }));
    expect([err.refusal, err.status, err.google, err.token]).toEqual(['no_access', 404, false, true]);
  });

  it('answers STS\'s invalid_target (the pool or provider gone) and invalid_grant (the provider refuses the role) as no_access', async () => {
    const target = await tokenRefusal('https://sts.googleapis.com/v1/token', json(400, { error: 'invalid_target', error_description: 'The target service indicated by the "audience" parameters is invalid.' }));
    expect([target.refusal, target.status, target.google, target.token]).toEqual(['no_access', 400, false, true]);
    const grant = await tokenRefusal('https://sts.googleapis.com/v1/token', json(400, { error: 'invalid_grant', error_description: 'The audience in ID Token does not match the expected audience.' }));
    expect([grant.refusal, grant.status, grant.google, grant.token]).toEqual(['no_access', 400, false, true]);
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

  it('answers the controller\'s JSON 404 (a router older than 0.40.0 has no /v1/actions) as the refusal router_too_old', async () => {
    const err = await failure(callRouter(fakeGoogle(() => json(404, { error: 'no route for POST /v1/actions', reason: 'not-found' })).google, ROUTER, { action: 'router' }, { timeoutMs: 10_000 }));
    expect([err.refusal, err.status, err.google]).toEqual(['router_too_old', 404, false]);
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

  it('reads an empty 401 or 403 as Google\'s refusal of the manager\'s token: no_access', async () => {
    for (const status of [401, 403]) {
      const err = await failure(callRouter(fakeGoogle(() => new Response('', { status })).google, ROUTER, { action: 'list' }, { timeoutMs: 10_000 }));
      expect([err.refusal, err.status, err.google], String(status)).toEqual(['no_access', status, true]);
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

  // The controller sends nothing until its answer is complete (router gcp/src/server.mjs), and an onboarding waits for
  // Compute Engine's operations: the router's call is silent up to its own bound, Google's token requests 10 s at most.
  it('lets a controller silent for 20 s answer under a 300 s bound', async () => {
    vi.useFakeTimers();
    const g = fakeGoogle(() => new Promise<Response>((resolve) => { setTimeout(() => resolve(json(200, { steps: [{ name: 'url map', status: 'done' }] })), 20_000); }));
    const call = callRouter(g.google, ROUTER, { action: 'onboard' }, { timeoutMs: 300_000 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await call).toEqual({ steps: [{ name: 'url map', status: 'done' }] });
  });

  it('aborts a controller still silent at the bound, never sooner, as a lost answer: no refusal', async () => {
    vi.useFakeTimers();
    const g = fakeGoogle(silent);
    let settled: unknown = 'pending';
    const call = failure(callRouter(g.google, ROUTER, { action: 'onboard' }, { timeoutMs: 300_000 }));
    void call.then((v) => { settled = v; });
    await vi.advanceTimersByTimeAsync(299_999);
    expect(settled).toBe('pending');
    const [sent] = g.to(ACTIONS);
    expect(sent!.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const err = await call;
    expect([err.message, err.status, err.refusal, err.google, err.token]).toEqual(['no answer within 300000 ms', 0, undefined, false, false]);
    expect(sent!.signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps Google\'s 10 s of silence for the ID token\'s requests under a 300 s bound', async () => {
    vi.useFakeTimers();
    const g = fakeGoogle(() => json(200, {}), (req) => (req.url.endsWith(':generateIdToken') ? silent(req) : undefined));
    const call = failure(callRouter(g.google, ROUTER, { action: 'onboard' }, { timeoutMs: 300_000 }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await call).message).toBe('no answer from iamcredentials.googleapis.com in 10 s');
    expect(g.to(ACTIONS)).toHaveLength(0);
  });

  it('sends nothing to the controller once the bound is past: an ID token that comes later is not used', async () => {
    vi.useFakeTimers();
    const later = (ms: number) => new Promise<Response>((resolve) => { setTimeout(() => resolve(json(200, { token: jwt({ exp: Math.floor(T0 / 1000) + 3600 }) })), ms); });
    const g = fakeGoogle(() => json(200, {}), (req) => (req.url.endsWith(':generateIdToken') ? later(9_000) : undefined));
    const call = failure(callRouter(g.google, ROUTER, { action: 'list' }, { timeoutMs: 8_000 }));
    await vi.advanceTimersByTimeAsync(8_000);
    expect((await call).message).toBe('no answer within 8000 ms');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(g.to(ACTIONS)).toHaveLength(0);
  });
});

// Every router answers its health, whatever its version: the watchdog's probe reads its version there.
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

  it('reads Google\'s answers as callRouter does: its 403 no_access, its own 404 Google\'s, a token refused the token\'s', async () => {
    const denied = await failure(routerHealth(fakeGoogle(() => html(403, 'Forbidden')).google, ROUTER, { timeoutMs: 10_000 }));
    expect([denied.refusal, denied.status, denied.google]).toEqual(['no_access', 403, true]);
    const gone = await failure(routerHealth(fakeGoogle(() => html(404, 'Page not found')).google, ROUTER, { timeoutMs: 10_000 }));
    expect([gone.refusal, gone.status, gone.google, gone.message]).toEqual([undefined, 404, true, 'dmtr-europe-west2-controller-abc123-nw.a.run.app answered HTTP 404']);
    const token = await failure(routerHealth(fakeGoogle(() => json(200, {}), (req) => (req.url.endsWith(':generateIdToken') ? json(403, { error: { code: 403, message: 'denied', status: 'PERMISSION_DENIED' } }) : undefined)).google, ROUTER, { timeoutMs: 10_000 }));
    expect([token.refusal, token.token]).toEqual(['no_access', true]);
  });

  it('answers a health without a version, or not JSON, as a failure that says so', async () => {
    const none = await failure(routerHealth(fakeGoogle(() => json(200, { status: 'ok' })).google, ROUTER, { timeoutMs: 10_000 }));
    expect([none.refusal, none.status, none.message]).toEqual([undefined, 200, 'dmtr-europe-west2-controller-abc123-nw.a.run.app answered its health without a version']);
    const page = await failure(routerHealth(fakeGoogle(() => new Response('<html>sign in</html>', { status: 200 })).google, ROUTER, { timeoutMs: 10_000 }));
    expect([page.status, page.message]).toEqual([200, 'dmtr-europe-west2-controller-abc123-nw.a.run.app answered something other than JSON']);
  });
});

// One rule for a broken connection (the review's M4): the router calls, the access check and the discovery scan read the
// token's refusal alike, so a revoked federation is a missing access everywhere, never a failure with no verdict.
describe('brokenConnection', () => {
  const STS = 'sts.googleapis.com';
  const IAM = 'iamcredentials.googleapis.com';
  const error = (host: string, status: number, reason = '') => new GoogleError({ status, reason, message: 'refused', host });

  it('is the token refused: 401, 403 or 404 at STS or iamcredentials, STS\'s 400 invalid_grant, invalid_target or unauthorized_client', () => {
    expect([error(IAM, 403, 'IAM_PERMISSION_DENIED'), error(IAM, 404, 'NOT_FOUND'), error(IAM, 401), error(STS, 403, 'PERMISSION_DENIED'), error(STS, 404)].map(brokenConnection)).toEqual([true, true, true, true, true]);
    expect(['invalid_grant', 'invalid_target', 'unauthorized_client'].map((reason) => brokenConnection(error(STS, 400, reason)))).toEqual([true, true, true]);
  });

  it('is nothing else: another 400 of STS, a failure at the token, a refusal of another host, no answer, an error that is not Google\'s', () => {
    expect([error(STS, 400, 'invalid_request'), error(STS, 503), error(IAM, 500), error(IAM, 429)].map(brokenConnection)).toEqual([false, false, false, false]);
    // A refusal of a Google API itself is a permission the account lacks, not the connection.
    expect([error('compute.googleapis.com', 403, 'IAM_PERMISSION_DENIED'), error('cloudresourcemanager.googleapis.com', 404), error('', 403)].map(brokenConnection)).toEqual([false, false, false]);
    expect([error(STS, 0), new Error('timed out'), null, { status: 403, host: IAM }].map(brokenConnection)).toEqual([false, false, false, false]);
  });
});

// The connect command, as the API answers a missing access and the probe records it; the router caller's refusals and the
// texts of a router too old are the fleet's (packages/fleet/test/router-call.test.ts, clouds.test.ts).
describe('the refusals\' texts', () => {
  it('names the connect command that fixes a missing access, as the API answers it and the probe records it', () => {
    expect(accessMissingText('dormeto-host', 'dev')).toBe('the manager\'s accounts can\'t reach the router: dormeto gcp connect --project dormeto-host --profile <profile> --env dev');
  });
});
