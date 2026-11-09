// The manager's calls to a Google Cloud router (Google Cloud manager design §5.1, §6.2): the AWS controller's payload
// POSTed to the controller's /v1/actions with the command account's ID token for the controller's origin, the whole call
// within its bound. The controller answers in the AWS controller's shapes, in its own JSON; Google answers in front of it
// when it refuses the token (401 or 403: an HTML page, Google's JSON error or nothing) or knows no such service (an HTML
// or empty 404).
// A broken connection fails before that, at the ID token (STS or iamcredentials): marked apart, never a router gone.
// The API and the fleet's poll call routers through it.
import { GoogleError } from './errors.js';
import type { Google } from './google.js';

// The router version the manager needs (/v1/actions, the journal, the check summary).
export const ROUTER_MINIMUM = '0.40.0';

// The manager's accounts can't reach the router, or the router has no /v1/actions.
export type RouterRefusal = 'manager-access-missing' | 'router-too-old';

// The commands that fix what the manager can't do on Google Cloud, as the API answers them and the fleet's poll records
// them. The operator's AWS profile is theirs to fill in.
export const connectCommand = (host: string, env: string) => `dormeto gcp connect --project ${host} --profile <profile> --env ${env}`;
export const installCommand = (project: string, region: string, pinned: string | undefined) => `dormeto gcp install --project ${project} --region ${region}${pinned ? ` --version ${pinned}` : ''}`;
export const accessMissingText = (host: string, env: string) => `the manager's accounts can't reach the router: ${connectCommand(host, env)}`;
// version: '' when it is unknown (the router answered that it has no /v1/actions).
export const tooOldText = (version: string, project: string, region: string, pinned: string | undefined) =>
  `router ${version || `older than ${ROUTER_MINIMUM}`} can't report to the manager: ${installCommand(project, region, pinned)}`;

export class RouterCallError extends Error {
  // status: the HTTP status, 0 when nothing came back; google: Google's own answer to the controller URL, not the
  // controller's JSON; token: STS or iamcredentials refused or failed the ID token, and the controller was not called.
  readonly status: number;
  readonly google: boolean;
  readonly token: boolean;
  readonly refusal?: RouterRefusal;

  constructor(message: string, { status = 0, google = false, token = false, refusal }: { status?: number; google?: boolean; token?: boolean; refusal?: RouterRefusal } = {}) {
    super(message);
    this.name = 'RouterCallError';
    this.status = status;
    this.google = google;
    this.token = token;
    if (refusal) this.refusal = refusal;
  }
}

// A known version below the minimum; an unknown one ('' or not a version) is called, and its answer says.
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
// role), iamcredentials refusing the impersonation (the grant revoked) or not knowing the account (deleted).
const BROKEN_EXCHANGE = new Set(['invalid_grant', 'invalid_target', 'unauthorized_client']);
const brokenConnection = (err: GoogleError) => denied(err.status) || err.status === 404 || (err.status === 400 && BROKEN_EXCHANGE.has(err.reason));
// Google's JSON error ({error: {code, message, status}}); the controller's own errors hold a string.
const googleShaped = (body: unknown) => typeof (body as { error?: unknown } | null)?.error === 'object' && (body as { error: unknown }).error !== null;

async function answerOf(google: Pick<Google, 'request'>, origin: string, payload: Record<string, unknown>): Promise<unknown> {
  const host = new URL(origin).host;
  let status: number;
  let text: string;
  try {
    ({ status, text } = await google.request('command', origin, 'POST', `${origin}/v1/actions`, payload));
  } catch (err) {
    // request answers whatever the controller URL answers, so a GoogleError with a status is the ID token's (STS or
    // iamcredentials); one without is no answer at all, from either.
    if (err instanceof GoogleError && err.status !== 0) {
      throw new RouterCallError(err.message, { status: err.status, token: true, ...(brokenConnection(err) ? { refusal: 'manager-access-missing' as const } : {}) });
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
  if (json && ok(status)) return body;
  if (json && !googleShaped(body)) {
    const own = body as { refused?: unknown; error?: unknown; message?: unknown } | null;
    // A refusal, as the AWS controller answers it: the caller reads it.
    if (own?.refused) return own;
    if (status === 404) throw new RouterCallError(`${host} has no /v1/actions: the router is older than ${ROUTER_MINIMUM}`, { status, refusal: 'router-too-old' });
    const message = typeof own?.message === 'string' ? own.message
      : own?.error === 'unknown-action' ? `unknown action: ${String(payload.action)}`
        : typeof own?.error === 'string' ? own.error : `${host} answered HTTP ${status}`;
    throw new RouterCallError(message, { status });
  }
  // Google's answer: its JSON error's message, or the status of its page.
  const message = ok(status) ? `${host} answered something other than JSON`
    : json ? String((body as { error: { message?: unknown } }).error.message ?? `${host} answered HTTP ${status}`) : `${host} answered HTTP ${status}`;
  throw new RouterCallError(message, { status, google: true, ...(denied(status) ? { refusal: 'manager-access-missing' as const } : {}) });
}

// The controller's JSON answer, or a RouterCallError; the whole call (the ID token's requests included) within timeoutMs.
export async function callRouter(google: Pick<Google, 'request'>, router: { controller: string }, payload: Record<string, unknown>, { timeoutMs }: { timeoutMs: number }): Promise<unknown> {
  const origin = new URL(router.controller).origin;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new RouterCallError(`no answer within ${timeoutMs} ms`)), timeoutMs); });
  try {
    return await Promise.race([answerOf(google, origin, payload), late]);
  } finally {
    clearTimeout(timer);
  }
}
