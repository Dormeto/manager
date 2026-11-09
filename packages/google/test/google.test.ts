// The manager's Google identity (Google Cloud manager design §4.1): a signed GetCallerIdentity request exchanged at
// Google's STS for a federated token, which asks iamcredentials for the service accounts' access and ID tokens; tokens
// kept until 5 minutes before they expire; every call bounded.
import { createHash, createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGoogle, GoogleError, serviceAccountEmails, type GoogleConnection } from '../src/index.js';

const T0 = Date.parse('2026-11-09T12:00:00Z');
const STS = 'https://sts.googleapis.com/v1/token';
const IAM = 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/';
const DISCOVERY = 'dmt-dev-discovery@dormeto-dev.iam.gserviceaccount.com';
const COMMAND = 'dmt-dev-command@dormeto-dev.iam.gserviceaccount.com';
const PROVIDER = '//iam.googleapis.com/projects/1034397096264/locations/global/workloadIdentityPools/dmt-dev/providers/aws';

const connection: GoogleConnection = {
  project: 'dormeto-dev',
  projectNumber: '1034397096264',
  pool: 'dmt-dev',
  provider: 'aws',
  scopes: ['projects/dormeto-dev'],
  serviceAccounts: { discovery: DISCOVERY, command: COMMAND },
  routers: [{ project: 'dormeto-dev', region: 'europe-west2' }],
  googleAdded: [],
  connectedAt: '2026-11-09T10:00:00.000Z',
  connectedBy: 'admin@example.com',
  cli: '0.14.0',
};
const credentials = { accessKeyId: 'ASIAEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', sessionToken: 'the-session-token' };

type Seen = { url: string; method: string; headers: Record<string, string>; body: string };
type Route = (req: Seen) => Response | Promise<Response>;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const jwt = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;

// A Google that answers every token request, its tokens numbered, at the clock's time; `route` answers first when it
// returns a Response.
function fakeGoogle(route?: (req: Seen) => Response | undefined) {
  let clock = T0;
  let n = 0;
  const seen: Seen[] = [];
  const answer: Route = (req) => {
    const own = route?.(req);
    if (own) return own;
    if (req.url === STS) return json(200, { access_token: `federated-${++n}`, issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600 });
    if (req.url.endsWith(':generateAccessToken')) return json(200, { accessToken: `access-${++n}`, expireTime: new Date(clock + 30 * 60_000).toISOString() });
    if (req.url.endsWith(':generateIdToken')) {
      const { audience } = JSON.parse(req.body) as { audience: string };
      return json(200, { token: jwt({ aud: audience, exp: Math.floor(clock / 1000) + 3600, n: ++n }) });
    }
    return json(200, { ok: true });
  };
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const req: Seen = { url: String(input), method: init?.method ?? 'GET', headers: { ...(init?.headers as Record<string, string>) }, body: String(init?.body ?? '') };
    seen.push(req);
    return answer(req);
  });
  const google = createGoogle({ connection, credentials, fetch: fetch as typeof globalThis.fetch, now: () => clock });
  return {
    google,
    seen,
    to: (url: string) => seen.filter((s) => s.url === url),
    set: (ms: number) => { clock = ms; },
  };
}

// The SigV4 signature of the subject token's request, computed here from AWS's documented algorithm.
function signature(secret: string, date: string, headers: [string, string][]): string {
  const hash = (s: string) => createHash('sha256').update(s).digest('hex');
  const hmac = (key: string | Buffer, s: string) => createHmac('sha256', key).update(s).digest();
  const canonical = ['POST', '/', 'Action=GetCallerIdentity&Version=2011-06-15', ...headers.map(([k, v]) => `${k}:${v}`), '', headers.map(([k]) => k).join(';'), hash('')].join('\n');
  const scope = `${date.slice(0, 8)}/us-east-1/sts/aws4_request`;
  const key = ['us-east-1', 'sts', 'aws4_request'].reduce((k, s) => hmac(k, s), hmac(`AWS4${secret}`, date.slice(0, 8)));
  return createHmac('sha256', key).update(['AWS4-HMAC-SHA256', date, scope, hash(canonical)].join('\n')).digest('hex');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('serviceAccountEmails', () => {
  it('names the two service accounts of an environment in the host project', () => {
    expect(serviceAccountEmails('dev', 'dormeto-dev')).toEqual({ discovery: DISCOVERY, command: COMMAND });
  });
});

describe('createGoogle', () => {
  it('signs a GetCallerIdentity request as the subject token: its url, POST, and the signed headers, x-goog-cloud-target-resource among them', async () => {
    const g = fakeGoogle();
    await g.google.accessToken('discovery');
    const form = new URLSearchParams(g.to(STS)[0]!.body);
    const token = JSON.parse(decodeURIComponent(form.get('subject_token')!)) as { url: string; method: string; headers: { key: string; value: string }[] };
    expect(token.url).toBe('https://sts.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15');
    expect(token.method).toBe('POST');
    expect(token.headers.map((h) => h.key)).toEqual(['Authorization', 'host', 'x-amz-date', 'x-goog-cloud-target-resource', 'x-amz-security-token']);
    const header = Object.fromEntries(token.headers.map((h) => [h.key, h.value]));
    expect(header).toMatchObject({ host: 'sts.amazonaws.com', 'x-amz-date': '20261109T120000Z', 'x-goog-cloud-target-resource': PROVIDER, 'x-amz-security-token': 'the-session-token' });
    const signed = [['host', 'sts.amazonaws.com'], ['x-amz-date', '20261109T120000Z'], ['x-amz-security-token', 'the-session-token'], ['x-goog-cloud-target-resource', PROVIDER]] as [string, string][];
    expect(header['Authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=ASIAEXAMPLE/20261109/us-east-1/sts/aws4_request, ' +
      'SignedHeaders=host;x-amz-date;x-amz-security-token;x-goog-cloud-target-resource, ' +
      `Signature=${signature(credentials.secretAccessKey, '20261109T120000Z', signed)}`,
    );
  });

  it('exchanges it at Google\'s STS with the documented form fields, then asks iamcredentials with the federated token', async () => {
    const g = fakeGoogle();
    expect(await g.google.accessToken('discovery')).toBe('access-2');
    const [exchange] = g.to(STS);
    expect(exchange).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    const form = Object.fromEntries(new URLSearchParams(exchange!.body));
    expect(Object.keys(form)).toEqual(['audience', 'grant_type', 'requested_token_type', 'scope', 'subject_token_type', 'subject_token']);
    expect(form).toMatchObject({
      audience: PROVIDER,
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      subject_token_type: 'urn:ietf:params:aws:token-type:aws4_request',
    });
    const [ask] = g.to(`${IAM}${DISCOVERY}:generateAccessToken`);
    expect(ask).toMatchObject({ method: 'POST', headers: { authorization: 'Bearer federated-1', 'content-type': 'application/json' } });
    expect(JSON.parse(ask!.body)).toEqual({ scope: ['https://www.googleapis.com/auth/cloud-platform'] });
  });

  it('reuses the access token until 5 minutes before it expires, then asks again with the federated token it kept', async () => {
    const g = fakeGoogle();
    expect(await g.google.accessToken('discovery')).toBe('access-2');
    g.set(T0 + 25 * 60_000 - 1);
    expect(await g.google.accessToken('discovery')).toBe('access-2');
    g.set(T0 + 25 * 60_000);
    expect(await g.google.accessToken('discovery')).toBe('access-3');
    expect(g.to(STS)).toHaveLength(1);
    expect(g.to(`${IAM}${DISCOVERY}:generateAccessToken`).map((s) => s.headers['authorization'])).toEqual(['Bearer federated-1', 'Bearer federated-1']);
    g.set(T0 + 55 * 60_000);
    expect(await g.google.accessToken('discovery')).toBe('access-5');
    expect(g.to(STS)).toHaveLength(2);
  });

  it('asks one token for concurrent callers', async () => {
    const g = fakeGoogle();
    const tokens = await Promise.all([g.google.accessToken('discovery'), g.google.accessToken('discovery'), g.google.idToken('command', 'https://a.run.app')]);
    expect(tokens[0]).toBe(tokens[1]);
    expect(g.to(STS)).toHaveLength(1);
    expect(g.to(`${IAM}${DISCOVERY}:generateAccessToken`)).toHaveLength(1);
  });

  it('keeps an ID token per audience, asked of the command account with includeEmail', async () => {
    const g = fakeGoogle();
    const a = await g.google.idToken('command', 'https://dmtr-europe-west2-controller-abc.a.run.app');
    expect(await g.google.idToken('command', 'https://dmtr-europe-west2-controller-abc.a.run.app')).toBe(a);
    const b = await g.google.idToken('command', 'https://dmtr-europe-west1-controller-abc.a.run.app');
    expect(b).not.toBe(a);
    const asks = g.to(`${IAM}${COMMAND}:generateIdToken`);
    expect(asks.map((s) => JSON.parse(s.body))).toEqual([
      { audience: 'https://dmtr-europe-west2-controller-abc.a.run.app', includeEmail: true },
      { audience: 'https://dmtr-europe-west1-controller-abc.a.run.app', includeEmail: true },
    ]);
    expect(asks[0]!.headers['authorization']).toBe('Bearer federated-1');
    g.set(T0 + 55 * 60_000);
    expect(await g.google.idToken('command', 'https://dmtr-europe-west2-controller-abc.a.run.app')).not.toBe(a);
  });

  it('answers a 403 from iamcredentials as a GoogleError with its reason and message only, and keeps nothing of it', async () => {
    let refuse = true;
    const g = fakeGoogle((req) => (refuse && req.url.endsWith(':generateAccessToken') ? json(403, {
      error: {
        code: 403,
        message: 'Permission \'iam.serviceAccounts.getAccessToken\' denied on resource (or it may not exist).',
        status: 'PERMISSION_DENIED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'IAM_PERMISSION_DENIED', domain: 'iam.googleapis.com', metadata: { permission: 'iam.serviceAccounts.getAccessToken' } }],
      },
    }) : undefined));
    const err = await g.google.accessToken('discovery').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleError);
    expect(err).toMatchObject({ status: 403, reason: 'IAM_PERMISSION_DENIED', message: 'Permission \'iam.serviceAccounts.getAccessToken\' denied on resource (or it may not exist).' });
    const said = `${String(err)} ${JSON.stringify(err)} ${(err as Error).stack}`;
    expect(said).not.toContain('federated-');
    expect(said).not.toContain('Signature=');
    expect(said).not.toContain('the-session-token');
    refuse = false;
    expect(await g.google.accessToken('discovery')).toMatch(/^access-/);
    expect(g.to(STS)).toHaveLength(1);
  });

  it('answers a refused exchange with STS\'s error code as the reason', async () => {
    const g = fakeGoogle((req) => (req.url === STS ? json(400, { error: 'unauthorized_client', error_description: 'The given credential is rejected by the attribute condition.' }) : undefined));
    await expect(g.google.idToken('command', 'https://a.run.app')).rejects.toMatchObject({
      name: 'GoogleError', status: 400, reason: 'unauthorized_client', message: 'The given credential is rejected by the attribute condition.',
    });
  });

  it('calls an API with the account\'s access token: JSON in and out, a refusal as a GoogleError', async () => {
    const g = fakeGoogle((req) => {
      if (req.url === 'https://run.googleapis.com/v2/projects/dormeto-dev/locations/-/services') return json(200, { services: [{ name: 'dmtr-europe-west2-controller' }] });
      if (req.url === 'https://compute.googleapis.com/compute/v1/projects/p/global/urlMaps') return json(403, { error: { code: 403, message: 'Required \'compute.urlMaps.list\' permission', errors: [{ reason: 'forbidden' }] } });
      return undefined;
    });
    expect(await g.google.call('discovery', 'GET', 'https://run.googleapis.com/v2/projects/dormeto-dev/locations/-/services')).toEqual({ services: [{ name: 'dmtr-europe-west2-controller' }] });
    expect(g.seen.at(-1)).toMatchObject({ method: 'GET', headers: { authorization: 'Bearer access-2' }, body: '' });
    expect(g.seen.at(-1)!.headers['content-type']).toBeUndefined();
    await g.google.call('command', 'POST', 'https://example.googleapis.com/v1/things', { a: 1 });
    expect(g.seen.at(-1)).toMatchObject({ method: 'POST', headers: { authorization: 'Bearer access-3', 'content-type': 'application/json' }, body: '{"a":1}' });
    await expect(g.google.call('discovery', 'GET', 'https://compute.googleapis.com/compute/v1/projects/p/global/urlMaps')).rejects.toMatchObject({
      status: 403, reason: 'forbidden', message: 'Required \'compute.urlMaps.list\' permission',
    });
  });

  it('forgets an access token Google answers 401 to and sends the call once more with a new one', async () => {
    const g = fakeGoogle((req) => (req.url === 'https://run.googleapis.com/v2/x' && req.headers['authorization'] === 'Bearer access-2'
      ? json(401, { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } })
      : undefined));
    expect(await g.google.call('discovery', 'GET', 'https://run.googleapis.com/v2/x')).toEqual({ ok: true });
    expect(g.to('https://run.googleapis.com/v2/x').map((s) => s.headers['authorization'])).toEqual(['Bearer access-2', 'Bearer access-3']);
    expect(await g.google.accessToken('discovery')).toBe('access-3');
  });

  it('aborts a call whose socket is silent for 10 s', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetch = vi.fn((_: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason));
    }));
    const google = createGoogle({ connection, credentials, fetch: fetch as typeof globalThis.fetch, now: () => T0 });
    let settled: unknown = 'pending';
    const asked = google.accessToken('discovery').then(() => 'answered', (e: unknown) => e);
    void asked.then((v) => { settled = v; });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0]!.aborted).toBe(true);
    expect(await asked).toMatchObject({ name: 'GoogleError', status: 0, message: 'no answer from sts.googleapis.com in 10 s' });
  });

  it('lets an answer that keeps talking run past 10 s, and aborts one that falls silent for 10 s', async () => {
    vi.useFakeTimers();
    const chunks = (gaps: number[], silentAtEnd: boolean, signal: AbortSignal) => new ReadableStream<Uint8Array>({
      async pull(c) {
        const gap = gaps.shift();
        if (gap === undefined) {
          if (!silentAtEnd) c.close();
          return new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => { c.error(signal.reason); reject(signal.reason); }));
        }
        await new Promise((r) => setTimeout(r, gap));
        c.enqueue(new TextEncoder().encode(gaps.length === 0 && !silentAtEnd ? '{"services":[]}' : ' '));
      },
    });
    let silent = false;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === STS) return json(200, { access_token: 'federated', expires_in: 3600 });
      if (url.endsWith(':generateAccessToken')) return json(200, { accessToken: 'access', expireTime: new Date(T0 + 3600_000).toISOString() });
      return new Response(chunks([6_000, 6_000, 6_000], silent, init!.signal!), { status: 200 });
    });
    const google = createGoogle({ connection, credentials, fetch: fetch as typeof globalThis.fetch, now: () => T0 });
    const talking = google.call('discovery', 'GET', 'https://run.googleapis.com/v2/slow');
    await vi.advanceTimersByTimeAsync(18_000);
    expect(await talking).toEqual({ services: [] });
    silent = true;
    const quiet = google.call('discovery', 'GET', 'https://run.googleapis.com/v2/slow').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(28_000);
    expect(await quiet).toMatchObject({ name: 'GoogleError', status: 0, message: 'no answer from run.googleapis.com in 10 s' });
  });
});
