// The manager's Google identity (Google Cloud manager design §4.1): workload identity federation from its Lambda roles
// to the two service accounts of the host project, then REST over node:https (no Google client library). The Lambda's AWS
// credentials sign a GetCallerIdentity request (the subject token), Google's STS exchanges it for a federated token, and
// that token asks iamcredentials for a service account's access token (scope cloud-platform) or ID token (a Cloud Run
// controller's audience). No key, no secret, nothing stored: an instance keeps its tokens in memory until 5 minutes
// before they expire, so a caller keeps one instance per execution environment (at module level), not one per
// invocation. Nothing here logs a token or a signature.
import { createHash, createHmac, type Hash, type Hmac } from 'node:crypto';
import { SignatureV4 } from '@smithy/signature-v4';
import { errorOf, GoogleError } from './errors.js';
import { fetchTransport, httpsTransport, send, type Answer, type Bounds, type Fetch } from './fetch.js';

// The connection's record (`DISC#GOOGLE`, `T#default`), written by `dormeto gcp connect`.
export interface GoogleConnection {
  project: string;
  projectNumber: string;
  pool: string;
  provider: string;
  scopes: string[];
  serviceAccounts: { discovery: string; command: string };
  // controller: the router's Cloud Run URL and version: its DMT_VERSION, each empty when unknown.
  routers: { project: string; region: string; controller?: string; version?: string }[];
  googleAdded: string[];
  connectedAt: string;
  connectedBy: string;
  cli: string;
}

// The Google twins of the manager's DmtDiscoveryRole and DmtCommandRole.
export type ServiceAccount = keyof GoogleConnection['serviceAccounts'];

export type AwsCredentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string; expiration?: Date };
export type AwsCredentialsProvider = () => Promise<AwsCredentials>;

export function serviceAccountEmails(env: string, project: string): GoogleConnection['serviceAccounts'] {
  return {
    discovery: `dmt-${env}-discovery@${project}.iam.gserviceaccount.com`,
    command: `dmt-${env}-command@${project}.iam.gserviceaccount.com`,
  };
}

const KEEP_MARGIN_MS = 5 * 60_000;
const CLOUD_PLATFORM = 'https://www.googleapis.com/auth/cloud-platform';
const STS_URL = 'https://sts.googleapis.com/v1/token';
const IAM_CREDENTIALS = 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/';
const GET_CALLER_IDENTITY = 'https://sts.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15';

// SHA-256 and its HMAC for the signer, on node:crypto.
type SourceData = string | ArrayBuffer | ArrayBufferView;
const bytes = (data: SourceData): Buffer => (typeof data === 'string' ? Buffer.from(data, 'utf8')
  : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(data));

class Sha256 {
  private readonly hash: Hash | Hmac;

  constructor(secret?: SourceData) {
    this.hash = secret === undefined ? createHash('sha256') : createHmac('sha256', bytes(secret));
  }

  update(data: SourceData): void {
    this.hash.update(bytes(data));
  }

  async digest(): Promise<Uint8Array> {
    return new Uint8Array(this.hash.digest());
  }
}

// The Lambda's own credentials, from the default provider chain, loaded when first needed.
let chain: AwsCredentialsProvider | undefined;
const lambdaCredentials: AwsCredentialsProvider = async () => {
  chain ??= (await import('@aws-sdk/credential-providers')).fromNodeProviderChain();
  return chain();
};

type Token = { value: string; expiresAt: number };

// Tokens kept by key until 5 minutes before they expire; concurrent callers share one request, and a failed one is
// not kept.
function keeper(now: () => number) {
  const kept = new Map<string, { asked: Promise<Token>; token?: Token }>();
  return {
    async get(key: string, ask: () => Promise<Token>): Promise<string> {
      const entry = kept.get(key);
      if (entry && (!entry.token || now() < entry.token.expiresAt - KEEP_MARGIN_MS)) return (await entry.asked).value;
      const fresh: { asked: Promise<Token>; token?: Token } = { asked: ask() };
      kept.set(key, fresh);
      fresh.asked.then((token) => { fresh.token = token; }, () => { if (kept.get(key) === fresh) kept.delete(key); });
      return (await fresh.asked).value;
    },
    drop(key: string): void {
      kept.delete(key);
    },
  };
}

// An ID token's expiry, from its `exp` claim (0 when unreadable: not kept).
function expiryOf(jwt: string): number {
  try {
    const { exp } = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof exp === 'number' ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

const ok = (a: Answer) => a.status >= 200 && a.status <= 299;

// A 2xx answer's JSON, or a GoogleError that says what came instead (never a SyntaxError).
const notJson = (answer: Answer, url: string) => new GoogleError({ status: answer.status, reason: '', message: `${new URL(url).host} answered HTTP ${answer.status} with something other than JSON` });
function parsed(answer: Answer, url: string): unknown {
  try {
    return JSON.parse(answer.text);
  } catch {
    throw notJson(answer, url);
  }
}
function jsonOf(answer: Answer, url: string): Record<string, unknown> {
  const body = parsed(answer, url);
  if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  throw notJson(answer, url);
}

// The fields a token's answer must hold, each a non-empty string, a number, or a string that is a date; a GoogleError naming
// those missing (never a NaN expiry, nor a request sent with "Bearer undefined").
type Field = 'string' | 'number' | 'date';
const holds = (value: unknown, field: Field) => (field === 'number' ? typeof value === 'number' && Number.isFinite(value)
  : typeof value === 'string' && value !== '' && (field === 'string' || Number.isFinite(Date.parse(value))));
function fieldsOf(answer: Answer, url: string, fields: Record<string, Field>): Record<string, unknown> {
  const body = jsonOf(answer, url);
  const lacking = Object.entries(fields).filter(([name, field]) => !holds(body[name], field)).map(([name]) => name);
  if (lacking.length) throw new GoogleError({ status: answer.status, reason: '', message: `${new URL(url).host} answered HTTP ${answer.status} without ${lacking.join(' or ')}` });
  return body;
}

export function createGoogle({ connection, credentials = lambdaCredentials, fetch, now = Date.now }: {
  connection: GoogleConnection;
  credentials?: AwsCredentials | AwsCredentialsProvider;
  // A fetch in place of node:https (the tests'): bounded by its silence only.
  fetch?: Fetch;
  now?: () => number;
}) {
  const provider = `//iam.googleapis.com/projects/${connection.projectNumber}/locations/global/workloadIdentityPools/${connection.pool}/providers/${connection.provider}`;
  const signer = new SignatureV4({ service: 'sts', region: 'us-east-1', credentials, sha256: Sha256, applyChecksum: false });
  const kept = keeper(now);
  const transport = fetch ? fetchTransport(fetch) : httpsTransport();

  // Google's documented subject token for AWS: the signed request as URL-encoded JSON, its target resource signed.
  async function subjectToken(): Promise<string> {
    const { headers } = await signer.sign({
      method: 'POST',
      protocol: 'https:',
      hostname: 'sts.amazonaws.com',
      path: '/',
      query: { Action: 'GetCallerIdentity', Version: '2011-06-15' },
      headers: { host: 'sts.amazonaws.com', 'x-goog-cloud-target-resource': provider },
    }, { signingDate: new Date(now()) });
    const token = headers['x-amz-security-token'];
    return encodeURIComponent(JSON.stringify({
      url: GET_CALLER_IDENTITY,
      method: 'POST',
      headers: [
        { key: 'Authorization', value: headers['authorization'] },
        { key: 'host', value: headers['host'] },
        { key: 'x-amz-date', value: headers['x-amz-date'] },
        { key: 'x-goog-cloud-target-resource', value: headers['x-goog-cloud-target-resource'] },
        ...(token ? [{ key: 'x-amz-security-token', value: token }] : []),
      ],
    }));
  }

  const federatedToken = () => kept.get('federated', async () => {
    const at = now();
    const answer = await send(transport, STS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        audience: provider,
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        scope: CLOUD_PLATFORM,
        subject_token_type: 'urn:ietf:params:aws:token-type:aws4_request',
        subject_token: await subjectToken(),
      }).toString(),
    });
    if (!ok(answer)) throw errorOf(answer.status, answer.text, STS_URL);
    const { access_token: value, expires_in: expiresIn } = fieldsOf(answer, STS_URL, { access_token: 'string', expires_in: 'number' }) as { access_token: string; expires_in: number };
    return { value, expiresAt: at + expiresIn * 1000 };
  });

  // A request with a kept token; Google's 401 (the token revoked before its time) forgets it and sends once more with
  // a new one. `bounds` are the request's own (the token's requests keep theirs).
  async function authorized(key: string, token: () => Promise<string>, url: string, method: string, body?: unknown, bounds?: Bounds): Promise<Answer> {
    const request = async () => send(transport, url, {
      method,
      headers: { authorization: `Bearer ${await token()}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, bounds);
    const answer = await request();
    if (answer.status !== 401) return answer;
    kept.drop(key);
    return request();
  }

  // iamcredentials' answer for the service account, as the federated principal, holding the fields asked.
  async function generate(sa: ServiceAccount, method: 'generateAccessToken' | 'generateIdToken', body: object, fields: Record<string, Field>): Promise<Record<string, unknown>> {
    const url = `${IAM_CREDENTIALS}${connection.serviceAccounts[sa]}:${method}`;
    const answer = await authorized('federated', federatedToken, url, 'POST', body);
    if (!ok(answer)) throw errorOf(answer.status, answer.text, url);
    return fieldsOf(answer, url, fields);
  }

  const accessToken = (sa: ServiceAccount): Promise<string> => kept.get(`access ${sa}`, async () => {
    const { accessToken: value, expireTime } = await generate(sa, 'generateAccessToken', { scope: [CLOUD_PLATFORM] }, { accessToken: 'string', expireTime: 'date' }) as { accessToken: string; expireTime: string };
    return { value, expiresAt: Date.parse(expireTime) };
  });

  const idToken = (sa: ServiceAccount, audience: string): Promise<string> => kept.get(`id ${sa} ${audience}`, async () => {
    const { token } = await generate(sa, 'generateIdToken', { audience, includeEmail: true }, { token: 'string' }) as { token: string };
    return { value: token, expiresAt: expiryOf(token) };
  });

  // A Google API's JSON answer ({} when empty), as the service account; a refusal, or an answer that isn't JSON, is a
  // GoogleError. `bounds` are the call's own (a Catalog page: 60 s), the token's requests keeping Google's 10 s.
  async function call<T = unknown>(sa: ServiceAccount, method: string, url: string, body?: unknown, bounds?: Bounds): Promise<T> {
    const answer = await authorized(`access ${sa}`, () => accessToken(sa), url, method, body, bounds);
    if (!ok(answer)) throw errorOf(answer.status, answer.text, url);
    return (answer.text.trim() ? parsed(answer, url) : {}) as T;
  }

  // A Cloud Run service's answer as it comes (its status and text, whatever they are), as the service account with an
  // ID token for the audience; Google's 401 asks a new token once, as `call` does. The caller reads the answer: the
  // service's own JSON, or Google's refusal in front of it. `bounds`: the service's silence and the caller's signal (a
  // router's call: its own bound); the ID token's requests keep Google's 10 s.
  const request = (sa: ServiceAccount, audience: string, method: string, url: string, body?: unknown, bounds?: Bounds): Promise<Answer> =>
    authorized(`id ${sa} ${audience}`, () => idToken(sa, audience), url, method, body, bounds);

  return { accessToken, idToken, call, request };
}

export type Google = ReturnType<typeof createGoogle>;
