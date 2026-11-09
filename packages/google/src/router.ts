// The manager's calls to a Google Cloud router (Google Cloud manager design §5.1, §6.2): the AWS controller's payload
// POSTed to the controller's /v1/actions with the command account's ID token for the controller's origin, the whole call
// within its bound. The controller answers in the AWS controller's shapes, in its own JSON; Google answers in front of it
// when it refuses the token (401 or 403: an HTML page or Google's JSON error) or knows no such service (an HTML 404).
// The API and the fleet's poll call routers through it.
import { GoogleError } from './errors.js';
import type { Google } from './google.js';

// The router version the manager needs (/v1/actions, the journal, the check summary).
export const ROUTER_MINIMUM = '0.40.0';

// The manager's accounts can't reach the router, or the router has no /v1/actions.
export type RouterRefusal = 'manager-access-missing' | 'router-too-old';

export class RouterCallError extends Error {
  // status: the HTTP status, 0 when nothing came back; google: the answer was Google's, not the controller's JSON.
  readonly status: number;
  readonly google: boolean;
  readonly refusal?: RouterRefusal;

  constructor(message: string, { status = 0, google = false, refusal }: { status?: number; google?: boolean; refusal?: RouterRefusal } = {}) {
    super(message);
    this.name = 'RouterCallError';
    this.status = status;
    this.google = google;
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
// Google's JSON error ({error: {code, message, status}}); the controller's own errors hold a string.
const googleShaped = (body: unknown) => typeof (body as { error?: unknown } | null)?.error === 'object' && (body as { error: unknown }).error !== null;

async function answerOf(google: Pick<Google, 'request'>, origin: string, payload: Record<string, unknown>): Promise<unknown> {
  const host = new URL(origin).host;
  let status: number;
  let text: string;
  try {
    ({ status, text } = await google.request('command', origin, 'POST', `${origin}/v1/actions`, payload));
  } catch (err) {
    // The ID token refused (STS or iamcredentials), or no answer at all.
    if (err instanceof GoogleError) throw new RouterCallError(err.message, { status: err.status, google: err.status !== 0, ...(denied(err.status) ? { refusal: 'manager-access-missing' as const } : {}) });
    throw err;
  }
  let body: unknown = null;
  let json = true;
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
