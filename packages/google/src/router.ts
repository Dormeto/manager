// The manager's calls to a Google Cloud router (Google Cloud manager design §5.1, §6.2): the AWS controller's payload
// POSTed to the controller's /v1/actions with the command account's ID token for the controller's origin, the whole call
// within its bound. The controller answers in the AWS controller's shapes, in its own JSON; Google answers in front of it
// when it refuses the token (401 or 403: an HTML page, Google's JSON error or nothing) or knows no such service (an HTML
// or empty 404).
// A broken connection fails before that, at the ID token (STS or iamcredentials): marked apart, never a router gone.
// The API and the fleet's poll call routers through it; the poll reads the version of a router too old to poll from its
// health (GET /v1/health, which every router version answers), the same way.
import { errorOf, GoogleError, redacted } from './errors.js';
import type { Bounds } from './fetch.js';
import type { Google, GoogleConnection } from './google.js';

// The router version the manager needs (/v1/actions, the journal, the check summary).
// Declared again as GOOGLE_ROUTER_MINIMUM in @dormeto/fleet/clouds (the dashboard reads that one; fleet depends on this
// package, never the reverse): packages/fleet/test/router-minimum.test.ts pins the two equal.
export const ROUTER_MINIMUM = '0.40.0';

// A call's refusal: the manager's accounts can't reach the router, or the router has no /v1/actions.
export type RouterRefusal = 'no_access' | 'router_too_old';
// What the manager can't do with a Google Cloud router, a call's refusal or, before any call, a controller discovery
// hasn't found yet: the API answers each as a 409, the poll records it, the watchdog says it.
export type Refusal = RouterRefusal | 'router_unknown';

// The commands that fix what the manager can't do on Google Cloud, as the API answers them and the fleet's poll records
// them. The operator's AWS profile is theirs to fill in.
export const connectCommand = (host: string, env: string) => `dormeto gcp connect --project ${host} --profile <profile> --env ${env}`;
// The version named is the pinned one, never below the minimum (a dev release pins the AWS router's).
export const installCommand = (project: string, region: string, pinned: string | undefined) =>
  `dormeto gcp install --project ${project} --region ${region}${pinned ? ` --version ${routerTooOld(pinned) ? ROUTER_MINIMUM : pinned}` : ''}`;
// said: what Google answered (see `googleSaid`), so the cause can be seen from the poll's error and the API's 502.
export const accessMissingText = (host: string, env: string, said?: string) => `the manager's accounts can't reach the router: ${connectCommand(host, env)}${said ? ` (${said})` : ''}`;
export const controllerUnknownText = (host: string, env: string) => `discovery hasn't found this router's controller yet: ${connectCommand(host, env)} again`;
// version: '' when it is unknown (the router answered that it has no /v1/actions).
export const tooOldText = (version: string, project: string, region: string, pinned: string | undefined) =>
  `router ${version || `older than ${ROUTER_MINIMUM}`} can't report to the manager: ${installCommand(project, region, pinned)}`;

export class RouterCallError extends Error {
  // status: the HTTP status, 0 when nothing came back; google: Google's own answer to the controller URL, not the
  // controller's JSON; token: STS or iamcredentials refused or failed the ID token, and the controller was not called.
  readonly status: number;
  readonly google: boolean;
  readonly token: boolean;
  readonly refusal?: Refusal;
  // Google's own words when Google refused or failed (`Google: <host> <status> <reason>: <message>`), from the token's stage
  // or the controller URL's; never a token or a signature.
  readonly said?: string;

  constructor(message: string, { status = 0, google = false, token = false, refusal, said }: { status?: number; google?: boolean; token?: boolean; refusal?: Refusal; said?: string } = {}) {
    super(redacted(message, Infinity)); // whatever Google echoed never carries a credential
    if (said) this.said = said;
    this.name = 'RouterCallError';
    this.status = status;
    this.google = google;
    this.token = token;
    if (refusal) this.refusal = refusal;
  }
}

// A known version below the minimum, by major.minor.patch alone (a dev router's 0.40.0-dev.1 meets 0.40.0, 0.39.0-dev.3
// doesn't; the registry keeps the version as the router reports it); an unknown one ('' or not a version) is called, and
// its answer says.
export function routerTooOld(version: string): boolean {
  const v = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!v) return false;
  const floor = ROUTER_MINIMUM.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (Number(v[i + 1]) !== floor[i]) return Number(v[i + 1]) < floor[i]!;
  return false;
}

const ok = (status: number) => status >= 200 && status <= 299;
const denied = (status: number) => status === 401 || status === 403;
// The connection broken at the token: STS refusing the provider (its pool or provider gone, its condition refusing the
// role), iamcredentials refusing the impersonation (the grant revoked) or not knowing the account (deleted). One rule for
// the router calls, the access check and the discovery scan: a revoked federation is a missing access for each of them.
// A refusal of any other host is a permission the account lacks there, not the connection.
const TOKEN_HOSTS = new Set(['sts.googleapis.com', 'iamcredentials.googleapis.com']);
const BROKEN_EXCHANGE = new Set(['invalid_grant', 'invalid_target', 'unauthorized_client']);
export const brokenConnection = (err: unknown): err is GoogleError => err instanceof GoogleError && TOKEN_HOSTS.has(err.host)
  && (denied(err.status) || err.status === 404 || (err.status === 400 && BROKEN_EXCHANGE.has(err.reason)));
// What Google answered, in one line: its host, status, reason (when it gives one) and message cut to 200 characters.
const googleSaid = (host: string, status: number, reason: string, message: string) =>
  `Google: ${[host, status, reason].filter((part) => part !== '').join(' ')}: ${redacted(message)}`;
// Google's JSON error ({error: {code, message, status}}); the controller's own errors hold a string.
const googleShaped = (body: unknown) => typeof (body as { error?: unknown } | null)?.error === 'object' && (body as { error: unknown }).error !== null;

// What the controller URL answered: its status, its body, and whether the body is the controller's own JSON.
type Reply = { host: string; status: number; body: unknown; json: boolean; text: string };
type Own = { refused?: unknown; error?: unknown; message?: unknown } | null;

async function replyOf(google: Pick<Google, 'request'>, origin: string, method: string, path: string, payload: Record<string, unknown> | undefined, bounds: Bounds): Promise<Reply> {
  const host = new URL(origin).host;
  let status: number;
  let text: string;
  try {
    ({ status, text } = await google.request('command', origin, method, `${origin}${path}`, payload, bounds));
  } catch (err) {
    // request answers whatever the controller URL answers, so a GoogleError with a status is the ID token's (STS or
    // iamcredentials); one without is no answer at all, from either. The bound's own error goes as it is.
    if (err instanceof GoogleError && err.status !== 0) {
      throw new RouterCallError(err.message, { status: err.status, token: true, said: googleSaid(err.host, err.status, err.reason, err.message), ...(brokenConnection(err) ? { refusal: 'no_access' as const } : {}) });
    }
    if (err instanceof GoogleError) throw new RouterCallError(err.message);
    throw err;
  }
  let body: unknown = null;
  // The controller always answers JSON: an empty failure, as one that isn't JSON, is Google's in front of it (an empty 2xx
  // is the controller's empty answer).
  let json = ok(status) || text.trim() !== '';
  try {
    if (text.trim()) body = JSON.parse(text);
  } catch {
    json = false;
  }
  return { host, status, body, json, text };
}

// The controller's own failure, from its JSON message or error.
const ownFailure = ({ host, status }: Reply, own: Own, unknownAction?: string) => new RouterCallError(typeof own?.message === 'string' ? own.message
  : own?.error === 'unknown-action' && unknownAction ? `unknown action: ${unknownAction}`
    : typeof own?.error === 'string' ? own.error : `${host} answered HTTP ${status}`, { status });

// Google's answer in front of the controller: its JSON error's message, or the status of its page.
function googleFailure({ host, status, body, json, text }: Reply): RouterCallError {
  const message = ok(status) ? `${host} answered something other than JSON`
    : json ? String((body as { error: { message?: unknown } }).error.message ?? `${host} answered HTTP ${status}`) : `${host} answered HTTP ${status}`;
  const said = errorOf(status, text);
  return new RouterCallError(message, { status, google: true, said: googleSaid(host, status, said.reason, said.message), ...(denied(status) ? { refusal: 'no_access' as const } : {}) });
}

async function answerOf(google: Pick<Google, 'request'>, origin: string, payload: Record<string, unknown>, bounds: Bounds): Promise<unknown> {
  const reply = await replyOf(google, origin, 'POST', '/v1/actions', payload, bounds);
  const { host, status, body, json } = reply;
  if (json && ok(status)) return body;
  if (json && !googleShaped(body)) {
    const own = body as Own;
    // A refusal, as the AWS controller answers it: the caller reads it.
    if (own?.refused) return own;
    if (status === 404) throw new RouterCallError(`${host} has no /v1/actions: the router is older than ${ROUTER_MINIMUM}`, { status, refusal: 'router_too_old' });
    throw ownFailure(reply, own, String(payload.action));
  }
  throw googleFailure(reply);
}

// What a router's health answers (every router version has it): its version, project and region.
export type RouterHealth = { version: string; project?: string; region?: string };

async function healthOf(google: Pick<Google, 'request'>, origin: string, bounds: Bounds): Promise<RouterHealth> {
  const reply = await replyOf(google, origin, 'GET', '/v1/health', undefined, bounds);
  const { host, status, body, json } = reply;
  if (json && ok(status)) {
    const health = body as { version?: unknown; project?: unknown; region?: unknown } | null;
    if (typeof health?.version !== 'string' || !health.version) throw new RouterCallError(`${host} answered its health without a version`, { status });
    return { version: health.version, ...(typeof health.project === 'string' ? { project: health.project } : {}), ...(typeof health.region === 'string' ? { region: health.region } : {}) };
  }
  if (json && !googleShaped(body)) throw ownFailure(reply, body as Own);
  throw googleFailure(reply);
}

// The work within timeoutMs, the ID token's requests included. At timeoutMs the work's signal aborts the controller's
// request (or keeps it from being sent), and the call fails as an answer lost: no refusal.
async function bounded<T>(timeoutMs: number, work: (bounds: Bounds) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const late = new Promise<never>((_, reject) => { controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }); });
  const timer = setTimeout(() => controller.abort(new RouterCallError(`no answer within ${timeoutMs} ms`)), timeoutMs);
  try {
    // The controller answers once its action is done (an onboarding waits for Compute Engine): it may be silent up to the bound.
    return await Promise.race([work({ silenceMs: timeoutMs, signal: controller.signal }), late]);
  } finally {
    clearTimeout(timer);
  }
}

// The controller's JSON answer, or a RouterCallError; the whole call (the ID token's requests included) within timeoutMs.
export async function callRouter(google: Pick<Google, 'request'>, router: { controller: string }, payload: Record<string, unknown>, { timeoutMs }: { timeoutMs: number }): Promise<unknown> {
  const origin = new URL(router.controller).origin;
  return bounded(timeoutMs, (bounds) => answerOf(google, origin, payload, bounds));
}

// The router's health (GET /v1/health, as the command account), or a RouterCallError read as callRouter's: the poll reads
// the version of a router too old to poll there.
export async function routerHealth(google: Pick<Google, 'request'>, router: { controller: string }, { timeoutMs }: { timeoutMs: number }): Promise<RouterHealth> {
  const origin = new URL(router.controller).origin;
  return bounded(timeoutMs, (bounds) => healthOf(google, origin, bounds));
}

// A router the manager acts on (Google Cloud manager design §6.2): the connection and its Google instance as read now
// (null while there is none), the router as the registry holds it (version: as the router reports it, '' when unknown).
// A router the manager can't use is refused before any call: a version before 0.40.0, no controller known yet, no
// connection. The payload is sent with `refusals: true` (without it a router answers a workload it doesn't know with its
// REST JSON 404, which reads as a router too old). The answer is the router's body, a `{refused}` answer as it is: each
// caller maps it. A failure is a RouterCallError, its `refusal` set when the manager's side can fix it.
export async function actOnRouter(
  current: { connection: GoogleConnection; google: Pick<Google, 'request'> } | null,
  router: { controller?: string; account?: string; region: string; version?: string },
  payload: Record<string, unknown>,
  { timeoutMs, env, routerVersion }: { timeoutMs: number; env: string; routerVersion?: string | undefined },
): Promise<unknown> {
  const [project, region, version] = [router.account ?? '', router.region, router.version ?? ''];
  if (routerTooOld(version)) throw new RouterCallError(tooOldText(version, project, region, routerVersion), { refusal: 'router_too_old' });
  const host = current?.connection.project ?? '<host>';
  if (!router.controller) throw new RouterCallError(controllerUnknownText(host, env), { refusal: 'router_unknown' });
  if (!current) throw new RouterCallError(accessMissingText(host, env), { refusal: 'no_access' });
  try {
    return await callRouter(current.google, { controller: router.controller }, { ...payload, refusals: true }, { timeoutMs });
  } catch (err) {
    if (!(err instanceof RouterCallError)) throw err;
    if (err.refusal === 'no_access') throw new RouterCallError(accessMissingText(host, env, err.said), { refusal: err.refusal });
    if (err.refusal === 'router_too_old') throw new RouterCallError(tooOldText('', project, region, routerVersion), { refusal: err.refusal });
    throw err;
  }
}
