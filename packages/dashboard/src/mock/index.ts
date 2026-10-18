// Demo mode of the dashboard (npm run dev:mock, development only): the manager API, the sign-in and the user's Cognito
// calls answered in the browser from a demo organization kept in memory (a reload starts it again). Loaded only when
// DEMO is on (enabled.ts: development with VITE_MOCK=1), by dynamic imports behind it (api.ts, auth.ts, cognito.ts): a build
// never contains it.
import { User } from 'oidc-client-ts';
import type { Status } from '@dormeto/discovery/types';
import { ApiError } from '../api';
import { STATUSES } from '../discovery';
import {
  changeDismissal, createExclusion, liftExclusion, pauseRouter, putConfig, putPreferences, putSavingsSettings, putUpdateCheck, resumeRouter, runDiscovery, startOperation, updateCheck, userAction,
  workloadAction,
} from './actions';
import { AVAILABLE } from './fixtures';
import { ME } from './org';
import { updateChanges, updateRequest, updateState } from './update';
import { MockError, advance, fail, lintOf, pausesOf, routerOf, state, workloadOf, type Demo } from './state';
import {
  accessReport, alerts, candidateView, exclusionView, fleetStates, idleAdvice, ipLists, operationView, routerDetails, routerRow, savingsSummary, workloadHistory,
  workloadRow, workloadStatus,
} from './views';

type Body = Record<string, unknown>;
const ACCOUNT = /^\d{12}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;

// A network's delay, so that loading states show.
const latency = (min = 150, max = 450) => new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));

// The API call api() would make: its answer, or an ApiError as the API's error answer would give.
export async function mockApi(path: string, init: RequestInit = {}): Promise<unknown> {
  await latency();
  const method = (init.method ?? 'GET').toUpperCase();
  const url = new URL(path, 'https://demo.invalid');
  const parts = url.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  try {
    let body: Body = {};
    if (typeof init.body === 'string' && init.body) {
      try {
        body = JSON.parse(init.body) as Body;
      } catch {
        fail(400, 'bad_request', 'the body is not JSON');
      }
    }
    const d = state();
    const now = Date.now();
    advance(d, now);
    // A copy: the views change what they are given (a row's running operation, for example).
    return structuredClone(route(d, method, parts, url.searchParams, body, now) ?? null);
  } catch (err) {
    if (err instanceof MockError) throw new ApiError(err.status, err.message, { error: err.code, message: err.message, ...err.body });
    throw new ApiError(500, `demo data: ${(err as Error).message}`, { error: 'internal', message: (err as Error).message });
  }
}

function route(d: Demo, method: string, parts: string[], q: URLSearchParams, body: Body, now: number): unknown {
  const [resource, a, b, action] = parts;
  if (method === 'GET' && resource === 'health' && !a) return { status: 'ok', version: 'demo' };
  if (method === 'GET' && resource === 'me' && !a) return { ...d.me, groups: ['dmt-admin'] };
  if (resource === 'preferences' && !a) {
    if (method === 'GET') return d.preferences;
    if (method === 'PUT') return putPreferences(d, body);
  }
  if (method === 'GET' && resource === 'ip-lists' && !a) return ipLists(now);
  if (method === 'GET' && resource === 'alerts' && !a) return alerts(d);
  if (method === 'GET' && resource === 'audit' && !a) return { entries: d.audit };
  if (resource === 'update') {
    if (method === 'GET' && !a) return updateState(now);
    if (method === 'GET' && a === 'check') return updateCheck(d, now);
    if (method === 'PUT' && a === 'check') return putUpdateCheck(d, body, now);
    if (method === 'GET' && a === 'available') return { count: updateState(now).versions.length };
    if (method === 'GET' && a === 'changes') return updateChanges(q.get('to'));
    if (method === 'POST' && a === 'plan') return updateRequest('plan', String(body.version ?? ''), now);
    if (method === 'POST' && a === 'apply') return updateRequest('apply', updateState(now).versions[0]!.version, now, String(body.planBuild ?? ''));
  }
  if (resource === 'users') return userAction(d, method, a, b, action, body, now);

  if (resource === 'routers') {
    if (method === 'GET' && !a) return { routers: d.routers.map((r) => routerRow(d, r, now)), available: { version: AVAILABLE.version } };
    if (a && !action) {
      const router = routerOf(d, a);
      if (method === 'GET' && !b) return routerDetails(d, router, now);
      if (method === 'POST' && b === 'pause') return pauseRouter(d, router, body, now);
      if (method === 'POST' && b === 'resume') return resumeRouter(d, router, now);
    }
  }

  if (resource === 'savings') {
    if (method === 'GET' && !a) return { summary: savingsSummary(d), settings: d.savings };
    if (method === 'PUT' && a === 'settings' && !b) return putSavingsSettings(d, body, now);
  }

  if (resource === 'workloads') {
    if (method === 'GET' && a === 'states' && !b) return fleetStates(d, now);
    if (method === 'GET' && !a) return workloads(d, q, now);
    if (a && b && !parts[4]) {
      if (method === 'GET' && !action) return workloadStatus(d, workloadOf(d, a, b), now);
      if (method === 'GET' && action === 'history') {
        const days = Number(q.get('days') ?? 7);
        if (!Number.isInteger(days) || days < 1 || days > 31) fail(400, 'bad_request', 'days must be a whole number from 1 to 31');
        return workloadHistory(d, workloadOf(d, a, b), days, now);
      }
      if (method === 'GET' && action === 'idle-window') return idleAdvice(d, workloadOf(d, a, b), now);
      if (method === 'POST' && action) return workloadAction(d, a, b, action, body, now);
    }
  }

  if (resource === 'operations' && !b) {
    if (method === 'GET' && !a) return { operations: d.operations.map((op) => operationView(op, now)) };
    if (method === 'GET' && a) return operationView(d.operations.find((op) => op.id === a) ?? fail(404, 'not_found', `unknown operation: ${a}`), now);
    if (method === 'POST' && !a) return startOperation(d, body, now);
  }

  if (resource === 'exclusions' && !b) {
    if (method === 'GET' && !a) return { exclusions: d.exclusions.map((e) => exclusionView(d, e, now)) };
    if (method === 'POST' && !a) return createExclusion(d, body, now);
    if (method === 'DELETE' && a) return liftExclusion(d, a, now);
  }

  if (resource === 'discovery' && !b) return discovery(d, method, a, q, body, now);

  return fail(404, 'not_found', `no route for ${method} /api/${parts.join('/')} in the demo data (src/mock)`);
}

// GET /api/workloads: a page of the workloads, with the counts and 7-day totals of all of them.
function workloads(d: Demo, q: URLSearchParams, now: number) {
  const ordered = d.routers.flatMap((r) => d.workloads.filter((w) => w.router === r.name).sort((x, y) => x.workloadId.localeCompare(y.workloadId)));
  const byState: Record<string, number> = {};
  const stats7d = { wakes: 0, ignored: 0, deferred: 0 };
  for (const w of ordered) {
    byState[w.state] = (byState[w.state] ?? 0) + 1;
    const s = workloadRow(d, w, now).stats7d!;
    stats7d.wakes += s.wakes;
    stats7d.ignored += s.ignored;
    stats7d.deferred += s.deferred;
  }
  const states = q.get('state')?.split(',') ?? null;
  const text = q.get('q')?.toLowerCase();
  const router = q.get('router');
  const attention = q.get('attention') === '1';
  const matching = ordered.filter((w) => (!states || states.includes(w.state)) && (!router || w.router === router)
    && (!text || `${w.name} ${w.workloadId}`.toLowerCase().includes(text))
    && (!attention || w.state === 'FAILED' || w.state === 'WAKING' || pausesOf(d, w).length > 0));
  const limited = q.has('limit');
  const limit = limited ? Math.min(Math.max(Number(q.get('limit')) || 0, 1), 1000) : matching.length;
  const start = q.get('cursor') ? Number(atob(q.get('cursor')!)) : Number(q.get('offset') ?? 0);
  if (!Number.isInteger(start) || start < 0) fail(400, 'bad_request', q.get('cursor') ? 'invalid cursor' : 'invalid offset');
  const page = matching.slice(start, start + limit).map((w) => workloadRow(d, w, now, { idle: limited && q.get('idle') === '1', states: limited && q.get('states') === '1' }));
  return {
    workloads: page, total: matching.length, byState, stats7d, cursor: start + limit < matching.length ? btoa(String(start + limit)) : null, errors: [],
    ...(q.get('routers') === '1' ? { routers: d.routers.map((r) => routerRow(d, r, now)) } : {}),
  };
}

function discovery(d: Demo, method: string, sub: string | undefined, q: URLSearchParams, body: Body, now: number): unknown {
  const counts: Partial<Record<Status, number>> = {};
  for (const c of d.candidates) counts[c.status] = (counts[c.status] ?? 0) + 1;
  if (method === 'GET' && !sub) {
    return { lastRun: d.runs.at(-1)!.record, counts, access: { discoveryRole: 'DmtDiscoveryRole', commandRole: 'DmtCommandRole', source: 'terraform' } };
  }
  if (method === 'GET' && sub === 'access') {
    const limit = Number(q.get('limit') ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) fail(400, 'bad_request', 'limit must be 1 to 1000');
    return accessReport(d, limit);
  }
  if (method === 'GET' && sub === 'candidates') {
    const status = q.get('status') as Status;
    if (!STATUSES.includes(status)) fail(400, 'bad_request', `status must be one of ${STATUSES.join(', ')}`);
    const account = q.get('account');
    const region = q.get('region');
    if ((account && !ACCOUNT.test(account)) || (region && (!account || !REGION.test(region)))) fail(400, 'bad_request', 'account must be 12 digits; a region needs its account');
    const limit = Number(q.get('limit') ?? 50);
    if (!Number.isInteger(limit) || limit < 1) fail(400, 'bad_request', 'limit must be a positive integer');
    const start = q.get('cursor') ? Number(atob(q.get('cursor')!)) : 0;
    if (!Number.isInteger(start) || start < 0) fail(400, 'bad_request', 'invalid cursor');
    const matching = d.candidates.filter((c) => c.status === status && (!account || c.account === account) && (!region || c.region === region));
    const page = matching.slice(start, start + Math.min(limit, 200));
    return { candidates: page.map((c) => candidateView(d, c, now)), cursor: start + page.length < matching.length ? btoa(String(start + page.length)) : null };
  }
  if (method === 'POST' && sub === 'run') return runDiscovery(d, now);
  if (sub === 'config') {
    if (method === 'GET') return { config: d.config.config, updatedAt: d.config.updatedAt, updatedBy: d.config.updatedBy, lint: lintOf(d.config.config) };
    if (method === 'PUT') {
      const answer = putConfig(d, body, now);
      return { ...answer, lint: lintOf(answer.config) };
    }
  }
  if (method === 'POST' && (sub === 'dismiss' || sub === 'restore')) return changeDismissal(d, sub, body, now);
  return fail(404, 'not_found', `no route for ${method} /api/discovery${sub ? `/${sub}` : ''} in the demo data (src/mock)`);
}

// --- Sign-in and Cognito -------------------------------------------------------------------------------------------------

// The signed-in demo user: an administrator whose session never expires.
export function mockUser(): User {
  const now = Math.floor(Date.now() / 1000);
  return new User({
    id_token: 'mock', access_token: 'mock', token_type: 'Bearer', scope: 'openid email profile aws.cognito.signin.user.admin', expires_at: now + 3600,
    profile: { sub: 'demo-user', iss: 'https://example.invalid', aud: 'demo', iat: now, exp: now + 3600, email: ME, 'cognito:groups': ['dmt-admin'] },
  });
}

// The user's own calls to Cognito (two-step verification set-up, R6c): they succeed, and /api/me then tells.
// The demo user's passkeys.
let passkeys = [{ CredentialId: 'demo-1', FriendlyCredentialName: 'Laptop', AuthenticatorAttachment: 'platform', CreatedAt: Math.floor(Date.now() / 1000) - 12 * 86400 }];

export async function mockCognito(target: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  await latency(200, 400);
  const d = state();
  const setMfa = (enabled: boolean) => {
    if (d.me.mfa) d.me.mfa = { ...d.me.mfa, enabled };
    const me = d.users.find((u) => u.email === d.me.email);
    if (me) me.mfa = enabled;
  };
  switch (target) {
    case 'AssociateSoftwareToken':
      return { SecretCode: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' };
    case 'VerifySoftwareToken':
      if (!/^\d{6}$/.test(String(body.UserCode ?? ''))) throw new Error('Invalid code received for user');
      return { Status: 'SUCCESS' };
    case 'SetUserMFAPreference':
      setMfa(Boolean((body.SoftwareTokenMfaSettings as { Enabled?: boolean } | undefined)?.Enabled));
      return {};
    case 'ListWebAuthnCredentials':
      return { Credentials: passkeys };
    case 'DeleteWebAuthnCredential':
      passkeys = passkeys.filter((c) => c.CredentialId !== body.CredentialId);
      return {};
    default:
      throw new Error(`demo data: Cognito ${target} is not answered (src/mock)`);
  }
}
