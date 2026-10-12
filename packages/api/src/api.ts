// Manager API: HTTP API (payload 2.0) behind the Cognito JWT authorizer. The routers answer through their controller;
// this layer adds identity, roles, aggregation over routers and the audit of mutating calls.
import {
  DEFAULT_CONFIG, EXCLUSION_KINDS, activeExclusions, lint, rescope, restatus, validateConfig, withExclusions,
  type Candidate, type DiscoveryStore, type Exclusion, type ExclusionKind,
} from '@dormeto/discovery';
import type { InstalledRouter, Operation, OperationType } from '@dormeto/operations';
import { reporting, type RouterSummary, type WorkloadSummary } from '@dormeto/fleet';

export interface Router {
  name: string;
  region: string;
  controller: string;
  account?: string; // the manager's account until routers run in other accounts (onboarding, R4)
  source?: 'terraform' | 'manager'; // written in Terraform, or installed by the manager (operations)
}

// Operations (onboarding, R4b): created by the API, run by the workflow.
export interface OperationsApi {
  create(type: OperationType, input: Record<string, unknown>, by: string): Promise<Operation>;
  list(): Promise<Operation[]>;
  get(id: string): Promise<Operation | null>;
  installedRouters(): Promise<InstalledRouter[]>;
}

export interface ApiEvent {
  rawPath: string;
  queryStringParameters?: Record<string, string>;
  requestContext: { http: { method: string }; authorizer?: { jwt?: { claims?: Record<string, string> } } };
  body?: string;
}

export interface ApiResponse {
  statusCode: number;
  headers: Record<string, string>;
  body?: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  who: string;
  role: Role;
  action: string;
  target: string;
  result: string;
}

export interface Audit {
  write(entry: AuditEntry): Promise<void>;
  list(): Promise<AuditEntry[]>;
}

export type Invoke = (router: Router, payload: Record<string, unknown>, options?: { async?: boolean }) => Promise<unknown>;

export type Role = 'viewer' | 'operator' | 'admin';

// Per-user dashboard preferences.
export interface Preferences {
  refreshSeconds: number;
}

export interface PreferencesStore {
  get(sub: string): Promise<Preferences | null>;
  put(sub: string, preferences: Preferences): Promise<void>;
}

const DEFAULT_PREFERENCES: Preferences = { refreshSeconds: 10 };

export interface UserView {
  email: string;
  role: Role;
  status: string;
  enabled: boolean;
  createdAt: string | null;
}

// User management (Cognito, SES identities in the sandbox), behind the routes, roles and audit of this API.
export interface UsersService {
  list(): Promise<UserView[]>;
  invite(email: string, role: Role): Promise<{ invitation: 'sent' | 'pending-verification' }>;
  resend(email: string): Promise<{ invitation: 'sent' }>;
  setRole(email: string, role: Role): Promise<void>;
  setEnabled(email: string, enabled: boolean): Promise<void>;
}

// Organization discovery: its items in the manager table, and a run on demand (asynchronous Lambda invoke).
export interface DiscoveryApi {
  store: DiscoveryStore;
  run(by: string): Promise<void>;
}

// A router answered with an error (function error, unknown workload): 502 for the caller.
export class RouterError extends Error {}

// A request the API refuses: status code and machine-readable error.
export class HttpError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
  }
}

const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };
const GROUPS: Record<string, Role> = { 'dmt-admin': 'admin', 'dmt-operator': 'operator', 'dmt-viewer': 'viewer' };
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface Identity {
  sub: string;
  email: string;
  groups: string[];
  role: Role;
}

// The JWT authorizer flattens arrays: "[dmt-admin dmt-viewer]".
export function identityOf(event: ApiEvent): Identity | null {
  const claims = event.requestContext.authorizer?.jwt?.claims;
  if (!claims?.sub) return null;
  const groups = (claims['cognito:groups'] ?? '').replace(/^\[|\]$/g, '').split(/[\s,]+/).filter(Boolean);
  const role = groups.map((g) => GROUPS[g]).filter((r): r is Role => r !== undefined)
    .reduce<Role>((best, r) => (RANK[r] > RANK[best] ? r : best), 'viewer');
  return { sub: claims.sub, email: claims.email ?? claims['cognito:username'] ?? claims.sub, groups, role };
}

const reply = (statusCode: number, body?: unknown): ApiResponse => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export interface ApiOptions {
  routers: Router[];
  invoke: Invoke;
  audit: Audit;
  now?: () => number;
  newId?: () => string;
  version: string;
  users?: UsersService;
  preferences?: PreferencesStore;
  discovery?: DiscoveryApi;
  operations?: OperationsApi;
  managerAccount?: string;
  routerVersion?: string; // the router version the manager installs and upgrades to
  // Routers and workloads as the routers report them (scale design §4): read instead of calling every router.
  fleet?: { listRouters(): Promise<RouterSummary[]>; listWorkloads(): Promise<WorkloadSummary[]> };
  // What the caller may see in listings (everything for now; R11 scopes it by tags).
  visible?: (identity: Identity, item: { account?: string; region: string }) => boolean;
  callTimeoutMs?: number; // a router that does not report, called directly: answer within (5 s)
  callConcurrency?: number; // at most this many such calls at once (10)
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DAY_MS = 86_400_000;
const REASON_MAX = 256;
// Pause until and exclusion expiry: at most this far ahead.
const AHEAD_MAX_MS = 366 * DAY_MS;
const ACCOUNT = /^\d{12}$/;
const ARNS: Record<Exclude<ExclusionKind, 'account'>, RegExp> = {
  'target-group': /^arn:aws[a-z-]*:elasticloadbalancing:([a-z0-9-]+):(\d{12}):targetgroup\/([A-Za-z0-9-]{1,32})\/[0-9a-f]{16}$/,
  'load-balancer': /^arn:aws[a-z-]*:elasticloadbalancing:([a-z0-9-]+):(\d{12}):loadbalancer\/app\/([A-Za-z0-9-]{1,32})\/[0-9a-f]{16}$/,
};
// An exclusion pauses its workloads with the reason "excluded: <reason>", which the router caps at REASON_MAX.
const EXCLUDED = 'excluded: ';
const KIND_TEXT: Record<ExclusionKind, string> = { 'target-group': 'target group', 'load-balancer': 'load balancer', account: 'account' };
const ROLES = new Set<Role>(['viewer', 'operator', 'admin']);

function bodyOf(event: ApiEvent): Record<string, unknown> {
  try {
    const body = JSON.parse(event.body ?? '{}') as unknown;
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // Reported below.
  }
  throw new HttpError(400, 'bad_request', 'JSON object body expected');
}

function reasonIn(body: Record<string, unknown>, max = REASON_MAX): string {
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason || reason.length > max) throw new HttpError(400, 'bad_request', `reason required (1 to ${max} characters)`);
  return reason;
}

// An optional date in the future, at most 366 days ahead (ISO 8601).
function aheadIn(body: Record<string, unknown>, name: string, now: number): string | undefined {
  const value = body[name];
  if (value === undefined || value === null) return undefined;
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!(at > now && at <= now + AHEAD_MAX_MS)) throw new HttpError(400, 'bad_request', `${name} must be a date in the future, within 366 days`);
  return new Date(at).toISOString();
}

function roleIn(body: Record<string, unknown>): Role {
  const role = body.role as Role;
  if (!ROLES.has(role)) throw new HttpError(400, 'bad_request', 'role must be viewer, operator or admin');
  return role;
}

// Workload names (routers 0.20.0 and later, vision onboarding design section 7): for people only, never in a resource
// name; trimmed, at most 64 characters, no control characters. The router derives the workload id from the target group.
const NAME_MAX = 64;
function nameOf(value: unknown, { required }: { required: boolean }): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, 'bad_request', 'name must be text');
  const name = value.trim();
  if (!name && required) throw new HttpError(400, 'bad_request', 'name: required');
  if (name.length > NAME_MAX) throw new HttpError(400, 'bad_request', `name: at most ${NAME_MAX} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new HttpError(400, 'bad_request', 'name: no control characters');
  return name || undefined;
}
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;

export function createApi({
  routers: terraformRouters, invoke, audit, now = Date.now, newId = () => crypto.randomUUID(), version, users, preferences, discovery, operations, managerAccount, routerVersion,
  fleet, visible = () => true, callTimeoutMs = 5_000, callConcurrency = 10,
}: ApiOptions) {
  // Routers of this request: written in Terraform, then installed by the manager (a unique name each: the AWS name is the
  // same in every region).
  let routers: Router[] = terraformRouters;
  async function refreshRouters() {
    const installed = (await operations?.installedRouters()) ?? [];
    routers = [
      ...terraformRouters.map((r) => ({ ...r, source: 'terraform' as const })),
      ...installed.filter((i) => !terraformRouters.some((t) => (t.account ?? managerAccount) === i.account && t.region === i.region)).map((i) => ({
        name: `${i.name}${i.account === managerAccount ? '' : `-${i.account}`}-${i.region}`, region: i.region, controller: i.controller, account: i.account, source: 'manager' as const,
      })),
    ];
  }
  const routerOf = (name: string | undefined): Router => {
    const router = routers.find((r) => r.name === name);
    if (!router) throw new HttpError(404, 'not_found', `unknown router: ${name}`);
    return router;
  };
  const workloadId = (raw: string | undefined): string => {
    const id = decodeURIComponent(raw ?? '');
    if (!ID.test(id)) throw new HttpError(400, 'bad_request', `invalid workload id: ${id}`);
    return id;
  };
  const need = (identity: Identity, role: Role) => {
    if (RANK[identity.role] < RANK[role]) throw new HttpError(403, 'forbidden', `${role} role required`);
  };

  // Mutating call: always audited, with its result or its error.
  async function audited(identity: Identity, action: string, target: string, run: () => Promise<{ result: string; response: ApiResponse }>) {
    const entry = { id: newId(), at: new Date(now()).toISOString(), who: identity.email, role: identity.role, action, target };
    try {
      const { result, response } = await run();
      await audit.write({ ...entry, result });
      return response;
    } catch (err) {
      await audit.write({ ...entry, result: `error: ${(err as Error).message}` });
      throw err;
    }
  }

  // A router called directly (it does not report): its answer within the timeout, at most callConcurrency at once.
  function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new RouterError(`no answer within ${callTimeoutMs} ms`)), callTimeoutMs); });
    return Promise.race([promise, late]).finally(() => clearTimeout(timer));
  }
  async function each<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
    const out: PromiseSettledResult<R>[] = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(callConcurrency, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        try {
          out[i] = { status: 'fulfilled', value: await bounded(work(items[i]!)) };
        } catch (reason) {
          out[i] = { status: 'rejected', reason };
        }
      }
    }));
    return out;
  }

  // The summary of each registered router that reports (its account: the manager's when the configuration has none).
  const accountOfRouter = (router: Router) => router.account ?? managerAccount ?? '';
  async function reports(): Promise<{ summaries: Map<Router, RouterSummary>; workloads: WorkloadSummary[] }> {
    if (!fleet) return { summaries: new Map(), workloads: [] };
    const [summaries, workloads] = await Promise.all([fleet.listRouters(), fleet.listWorkloads()]);
    const out = new Map<Router, RouterSummary>();
    for (const router of routers) {
      const summary = summaries.find((x) => x.account === accountOfRouter(router) && x.region === router.region);
      if (summary && reporting(summary, now())) out.set(router, summary);
    }
    return { summaries: out, workloads };
  }

  // Every workload: from the summaries of the routers that report, from the others by their list action.
  async function listAll() {
    const { summaries, workloads } = await reports();
    const silent = routers.filter((r) => !summaries.has(r));
    const called = await each(silent, (r) => invoke(r, { action: 'list' }));
    const rows: Record<string, unknown>[] = [];
    const errors: { router: string; message: string }[] = [];
    for (const router of routers) {
      const summary = summaries.get(router);
      if (summary) {
        rows.push(...workloads.filter((w) => w.account === summary.account && w.region === summary.region)
          .sort((a, b) => a.workloadId.localeCompare(b.workloadId))
          .map(({ account: _a, router: _r, checkedAt: _c, stateAt: _s, ...w }) => ({ ...w, router: router.name, account: summary.account })));
        continue;
      }
      const result = called[silent.indexOf(router)]!;
      if (result.status === 'fulfilled') {
        const account = accountOfRouter(router);
        rows.push(...((result.value as { workloads?: Record<string, unknown>[] }).workloads ?? []).map((w) => ({ router: router.name, ...(account ? { account } : {}), region: router.region, ...w })));
      } else errors.push({ router: router.name, message: (result.reason as Error).message });
    }
    return { rows, errors };
  }

  // A router older than the action (0.15 and earlier for router, pause, resume, request-nap).
  const unknownAction = (err: unknown, action: string) => err instanceof RouterError && err.message === `unknown action: ${action}`;
  async function invokeNew(router: Router, payload: Record<string, unknown>, what: string) {
    try {
      return await invoke(router, payload);
    } catch (err) {
      if (unknownAction(err, payload.action as string)) throw new RouterError(`router ${router.name} does not support ${what}: upgrade it to 0.16.0 or later`);
      throw err;
    }
  }
  const where = (router: Router) => ({ name: router.name, region: router.region, ...(router.account ? { account: router.account } : {}), ...(router.source ? { source: router.source } : {}) });

  type RouterInfo = {
    router: { version?: string; build?: string };
    pauses: unknown[];
    workloads: { total: number; byState: Record<string, number>; paused: number; lastActivityAt: string | null };
    health: { status: string; problems: unknown[]; checkSchedule: string | null; lastScheduledCheckAt: string | null };
  };
  type Listed = { router?: { version?: string; build?: string; checkSchedule?: string; lastScheduledCheckAt?: string }; workloads?: unknown[] };

  // One row of the Routers view: the router action, or the list of a router older than 0.16.
  async function routerRow(router: Router) {
    try {
      const info = await invoke(router, { action: 'router' }) as RouterInfo;
      return {
        ...where(router), version: info.router.version ?? null, build: info.router.build ?? null, workloads: info.workloads.total,
        checkSchedule: info.health.checkSchedule, lastScheduledCheckAt: info.health.lastScheduledCheckAt,
        health: { status: info.health.status, problems: info.health.problems }, pauses: info.pauses,
        workloadStates: info.workloads.byState, paused: info.workloads.paused, lastActivityAt: info.workloads.lastActivityAt,
      };
    } catch (err) {
      if (!unknownAction(err, 'router')) return { ...where(router), error: (err as Error).message };
    }
    try {
      const listed = await invoke(router, { action: 'list' }) as Listed;
      return {
        ...where(router), version: listed.router?.version ?? null, build: listed.router?.build ?? null, workloads: (listed.workloads ?? []).length,
        // Health of the automatic naps: when the schedule last ran the idle check.
        checkSchedule: listed.router?.checkSchedule ?? null, lastScheduledCheckAt: listed.router?.lastScheduledCheckAt ?? null,
      };
    } catch (err) {
      return { ...where(router), error: (err as Error).message };
    }
  }

  // Pause of a router (no workload id) or a workload: the body checked here, the router enforces it.
  function pauseRequest(event: ApiEvent, identity: Identity, workloadId?: string) {
    const body = bodyOf(event);
    const reason = reasonIn(body);
    const until = aheadIn(body, 'until', now());
    if (body.keepAsleep !== undefined && typeof body.keepAsleep !== 'boolean') throw new HttpError(400, 'bad_request', 'keepAsleep must be true or false');
    const keepAsleep = body.keepAsleep === true;
    const payload = { action: 'pause', ...(workloadId ? { workloadId } : {}), by: identity.email, reason, ...(until ? { until } : {}), keepAsleep };
    const text = (woken: string[]) => [reason, ...(until ? [`until ${until}`] : []), ...(keepAsleep ? ['keep asleep'] : []), ...(woken.length ? [`woken ${woken.join(', ')}`] : [])].join('; ');
    return { payload, text };
  }

  async function pauseRoute(identity: Identity, event: ApiEvent, router: Router, action: string, workloadId?: string) {
    need(identity, 'operator');
    const target = workloadId ? `${router.name}/${workloadId}` : router.name;
    const prefix = workloadId ? '' : 'router-';
    if (action === 'pause') {
      const { payload, text } = pauseRequest(event, identity, workloadId);
      return audited(identity, `${prefix}pause`, target, async () => {
        const result = await invokeNew(router, payload, 'pause') as { woken?: string[] };
        return { result: text(result?.woken ?? []), response: reply(200, result) };
      });
    }
    return audited(identity, `${prefix}resume`, target, async () => {
      const result = await invokeNew(router, { action: 'resume', ...(workloadId ? { workloadId } : {}), by: identity.email }, 'resume') as { resumed?: boolean };
      return { result: result?.resumed ? 'resumed' : 'not paused', response: reply(200, result) };
    });
  }

  async function route(method: string, parts: string[], identity: Identity, event: ApiEvent): Promise<ApiResponse> {
    const [resource, a, b, action] = parts;
    if (method === 'GET' && resource === 'me' && !a) return reply(200, { email: identity.email, groups: identity.groups, role: identity.role });

    if (resource === 'preferences' && !a && preferences) {
      if (method === 'GET') return reply(200, { ...DEFAULT_PREFERENCES, ...((await preferences.get(identity.sub)) ?? {}) });
      if (method === 'PUT') {
        const refresh = bodyOf(event).refreshSeconds;
        if (!Number.isInteger(refresh) || (refresh !== 0 && ((refresh as number) < 5 || (refresh as number) > 600))) {
          throw new HttpError(400, 'bad_request', 'refreshSeconds must be 0 (off) or an integer from 5 to 600');
        }
        const saved = { refreshSeconds: refresh as number };
        await preferences.put(identity.sub, saved);
        return reply(200, saved);
      }
    }

    if (method === 'GET' && resource === 'routers' && !a) {
      const shown = routers.filter((r) => visible(identity, { account: accountOfRouter(r), region: r.region }));
      const { summaries, workloads } = await reports();
      const silent = shown.filter((r) => !summaries.has(r));
      const called = await each(silent, (r) => routerRow(r));
      const rows = shown.map((router) => {
        const summary = summaries.get(router);
        if (!summary) {
          const result = called[silent.indexOf(router)]!;
          return { ...(result.status === 'fulfilled' ? result.value : { ...where(router), error: (result.reason as Error).message }), reporting: false };
        }
        const own = workloads.filter((w) => w.account === summary.account && w.region === summary.region);
        const health = (summary.health ?? {}) as { status?: string; problems?: unknown[]; lastScheduledCheckAt?: string | null };
        const updated = own.map((w) => Date.parse(String(w.updatedAt ?? ''))).filter((ms) => ms > 0);
        return {
          ...where(router), version: summary.version, build: summary.build, workloads: Object.values(summary.counts).reduce((n, c) => n + c, 0),
          checkSchedule: summary.checkSchedule, lastScheduledCheckAt: health.lastScheduledCheckAt ?? summary.checkedAt,
          health: { status: health.status ?? 'unknown', problems: health.problems ?? [] }, pauses: summary.pauses, workloadStates: summary.counts,
          paused: summary.pauses.length ? own.length : own.filter((w) => (w.pauses as unknown[] | undefined)?.length).length,
          lastActivityAt: updated.length ? new Date(Math.max(...updated)).toISOString() : null, reporting: true, checkedAt: summary.checkedAt,
        };
      });
      return reply(200, { routers: rows, ...(routerVersion ? { available: { version: routerVersion } } : {}) });
    }
    if (resource === 'routers' && a) {
      const router = routerOf(a);
      if (method === 'GET' && !b) return reply(200, { ...where(router), ...(await invokeNew(router, { action: 'router' }, 'router details') as object) });
      if (method === 'POST' && (b === 'pause' || b === 'resume') && !action) return pauseRoute(identity, event, router, b);
    }

    if (method === 'GET' && resource === 'workloads' && !a) {
      const q = event.queryStringParameters ?? {};
      const { rows, errors } = await listAll();
      const seen = rows.filter((w) => visible(identity, { account: w.account as string | undefined, region: String(w.region ?? routers.find((r) => r.name === w.router)?.region ?? '') }));
      // Counts and 7-day totals of what the caller sees, whatever the filters (the Overview).
      const byState: Record<string, number> = {};
      const stats7d = { wakes: 0, ignored: 0, deferred: 0 };
      for (const w of seen) {
        byState[String(w.state)] = (byState[String(w.state)] ?? 0) + 1;
        const stats = w.stats7d as typeof stats7d | null | undefined;
        for (const k of ['wakes', 'ignored', 'deferred'] as const) stats7d[k] += stats?.[k] ?? 0;
      }
      const states = q.state ? q.state.split(',') : null;
      const text = q.q?.toLowerCase();
      // Needs attention: failed or waking, or paused (a pause is easy to forget).
      const attention = (w: Record<string, unknown>) => w.state === 'FAILED' || w.state === 'WAKING' || Boolean((w.pauses as unknown[] | undefined)?.length);
      const matching = seen.filter((w) => (!states || states.includes(String(w.state))) && (!q.router || w.router === q.router)
        && (!text || `${w.name ?? ''} ${w.workloadId}`.toLowerCase().includes(text)) && (q.attention !== '1' || attention(w)));
      // Pages: an opaque cursor (the offset); without a limit, every workload.
      const limit = q.limit ? Math.min(Math.max(Number(q.limit) || 0, 1), 1000) : matching.length;
      // From a cursor (the next page) or an offset (a page number).
      let start = 0;
      if (q.cursor) start = Number(Buffer.from(q.cursor, 'base64url').toString('utf8'));
      else if (q.offset) start = Number(q.offset);
      if (!Number.isInteger(start) || start < 0) throw new HttpError(400, 'bad_request', q.cursor ? 'invalid cursor' : 'invalid offset');
      const page = matching.slice(start, start + limit);
      const cursor = start + limit < matching.length ? Buffer.from(String(start + limit)).toString('base64url') : null;
      return reply(200, { workloads: page, total: matching.length, byState, stats7d, cursor, errors });
    }

    if (resource === 'workloads' && a && b) {
      const router = routerOf(a);
      const id = workloadId(b);
      if (method === 'GET' && !action) return reply(200, await invoke(router, { action: 'status', workloadId: id }));
      if (method === 'POST' && action === 'nap' && !parts[4]) {
        need(identity, 'operator');
        return audited(identity, 'nap', `${router.name}/${id}`, async () => {
          // The router refuses at once a nap it would skip (paused, not awake); an older router naps asynchronously.
          let answer: { requested?: boolean; reason?: string } | null;
          try {
            answer = await invoke(router, { action: 'request-nap', workloadId: id, by: identity.email }) as typeof answer;
          } catch (err) {
            if (!unknownAction(err, 'request-nap')) throw err;
            await invoke(router, { action: 'nap', workloadId: id }, { async: true });
            answer = { requested: true };
          }
          if (!answer?.requested) throw new HttpError(409, 'conflict', answer?.reason ?? 'nap refused');
          return { result: 'requested', response: reply(202, { accepted: true }) };
        });
      }
      if (method === 'POST' && (action === 'pause' || action === 'resume') && !parts[4]) return pauseRoute(identity, event, router, action, id);
      if (method === 'POST' && action === 'rename' && !parts[4]) {
        need(identity, 'operator');
        const name = nameOf(bodyOf(event).name, { required: true })!;
        return audited(identity, 'rename', `${router.name}/${id}`, async () => {
          try {
            const result = await invoke(router, { action: 'rename', workloadId: id, name, by: identity.email }) as { workloadId: string; name: string };
            return { result: result.name, response: reply(200, result) };
          } catch (err) {
            if (unknownAction(err, 'rename')) throw new HttpError(409, 'conflict', `router ${router.name} too old to rename, upgrade it to 0.20.0 or later`);
            if (err instanceof RouterError && err.message.includes('written by Terraform')) throw new HttpError(409, 'conflict', err.message);
            if (err instanceof RouterError && err.message.startsWith('workload not configured')) throw new HttpError(404, 'not_found', err.message);
            throw err;
          }
        });
      }
      if (method === 'POST' && action === 'wake' && !parts[4]) {
        need(identity, 'operator');
        return audited(identity, 'wake', `${router.name}/${id}`, async () => {
          const result = await invoke(router, { action: 'force-wake', workloadId: id, by: identity.email }) as { state?: string };
          return { result: result?.state ?? 'done', response: reply(200, result) };
        });
      }
    }

    if (resource === 'operations' && operations && !b) {
      const response = await operationsRoute(method, a, identity, event, operations);
      if (response) return response;
    }

    if (resource === 'exclusions' && discovery && !b) {
      const response = await exclusionsRoute(method, a, identity, event, discovery);
      if (response) return response;
    }

    if (resource === 'discovery' && discovery && !b) {
      const response = await discoveryRoute(method, a, identity, event, discovery);
      if (response) return response;
    }

    if (method === 'GET' && resource === 'audit' && !a) {
      need(identity, 'admin');
      return reply(200, { entries: await audit.list() });
    }

    if (resource === 'users' && users) {
      need(identity, 'admin');
      if (method === 'GET' && !a) return reply(200, { users: await users.list() });
      if (method === 'POST' && !a) {
        const body = bodyOf(event);
        const email = String(body.email ?? '').trim().toLowerCase();
        if (!EMAIL.test(email)) throw new HttpError(400, 'bad_request', 'valid email required');
        const role = roleIn(body);
        return audited(identity, 'invite', email, async () => {
          const { invitation } = await users.invite(email, role);
          return { result: `${role}, ${invitation}`, response: reply(201, { email, role, invitation }) };
        });
      }
      const email = decodeURIComponent(a ?? '').toLowerCase();
      if (a && !EMAIL.test(email)) throw new HttpError(400, 'bad_request', `invalid email: ${email}`);
      // An administrator never demotes or disables themselves: the last admin could lock everybody out.
      const notSelf = () => {
        if (email === identity.email.toLowerCase()) throw new HttpError(409, 'conflict', 'you cannot change your own account');
      };
      if (method === 'POST' && b === 'resend' && !action) {
        return audited(identity, 'resend', email, async () => ({ result: 'sent', response: reply(200, await users.resend(email)) }));
      }
      if (method === 'PUT' && b === 'role' && !action) {
        notSelf();
        const role = roleIn(bodyOf(event));
        return audited(identity, 'role', email, async () => {
          await users.setRole(email, role);
          return { result: role, response: reply(200, { email, role }) };
        });
      }
      if (method === 'POST' && (b === 'disable' || b === 'enable') && !action) {
        notSelf();
        return audited(identity, b, email, async () => {
          await users.setEnabled(email, b === 'enable');
          return { result: 'done', response: reply(200, { email, enabled: b === 'enable' }) };
        });
      }
    }

    throw new HttpError(404, 'not_found', `no route for ${method} /api/${parts.join('/')}`);
  }

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

  async function discoveryRoute(method: string, sub: string | undefined, identity: Identity, event: ApiEvent, d: DiscoveryApi): Promise<ApiResponse | null> {
    if (method === 'GET' && !sub) {
      await settleExpired(d);
      const q = event.queryStringParameters ?? {};
      const candidates = (await d.store.listCandidates())
        .filter((c) => (!q.status || c.status === q.status) && (!q.account || c.account === q.account) && (!q.region || c.region === q.region));
      return reply(200, { lastRun: await d.store.lastRun(), candidates });
    }
    if (method === 'POST' && sub === 'run') {
      need(identity, 'operator');
      return audited(identity, 'discovery-run', 'discovery', async () => {
        await d.run(identity.email);
        return { result: 'requested', response: reply(202, { accepted: true }) };
      });
    }
    if (sub === 'config') {
      const inventory = (await d.store.getInventory()) ?? { accounts: [], ous: {} };
      // The lint counts the active manual exclusions, as runs do.
      const exclusions = await d.store.listExclusions();
      const linted = (config: typeof DEFAULT_CONFIG) => lint(withExclusions(config, exclusions, now()), inventory);
      if (method === 'GET') {
        const stored = await d.store.getConfig();
        const config = stored?.config ?? DEFAULT_CONFIG;
        return reply(200, { config, updatedAt: stored?.updatedAt ?? null, updatedBy: stored?.updatedBy ?? null, lint: linted(config) });
      }
      if (method === 'PUT') {
        need(identity, 'admin');
        const { config, errors } = validateConfig(bodyOf(event));
        if (!config) return reply(400, { error: 'bad_request', message: 'invalid configuration', errors });
        const summary = `${plural(config.filters.length, 'filter')}, ${plural(config.globalExcludes.length, 'global exclude')}, regions ${config.regions.join(' ')}`;
        return audited(identity, 'discovery-config', 'discovery', async () => {
          await d.store.putConfig(config, identity.email);
          return { result: summary, response: reply(200, { config, lint: linted(config) }) };
        });
      }
    }
    if (method === 'POST' && (sub === 'dismiss' || sub === 'restore')) {
      need(identity, 'operator');
      const body = bodyOf(event);
      const ids = body.ids;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || ids.some((id) => typeof id !== 'string')) {
        throw new HttpError(400, 'bad_request', 'ids must be a list of 1 to 100 candidate IDs');
      }
      const note = typeof body.note === 'string' ? body.note.slice(0, 256) : undefined;
      const found = await Promise.all((ids as string[]).map((id) => d.store.getCandidate(id)));
      const missing = (ids as string[]).filter((_, i) => !found[i]);
      if (missing.length) throw new HttpError(404, 'not_found', `unknown candidates: ${missing.join(', ')}`);
      const at = new Date(now()).toISOString();
      return audited(identity, `discovery-${sub}`, (ids as string[]).join(' '), async () => {
        const updated = (found as Candidate[]).map((c) => {
          const { dismissed: _, ...rest } = c;
          return restatus(sub === 'dismiss' ? { ...rest, dismissed: { by: identity.email, at, ...(note ? { note } : {}) } } : rest, at);
        });
        await d.store.putCandidates(updated);
        return { result: plural(updated.length, 'candidate'), response: reply(200, { candidates: updated }) };
      });
    }
    return null;
  }

  // --- Manual exclusions: global excludes with a reason, author and expiry; the managed workloads they match are paused --

  function exclusionTarget(body: Record<string, unknown>, inventoryName: (account: string) => string): Exclusion['target'] {
    const target = body.target as Record<string, unknown> | undefined;
    const kind = target?.kind as ExclusionKind;
    if (!target || !EXCLUSION_KINDS.includes(kind)) throw new HttpError(400, 'bad_request', `target.kind must be ${EXCLUSION_KINDS.join(', ')}`);
    if (kind === 'account') {
      const account = String(target.account ?? '');
      if (!ACCOUNT.test(account)) throw new HttpError(400, 'bad_request', 'target.account must be a 12-digit account ID');
      return { kind, account, name: inventoryName(account) };
    }
    const arn = String(target.arn ?? '');
    const parsed = ARNS[kind].exec(arn);
    if (!parsed) throw new HttpError(400, 'bad_request', `target.arn must be the ARN of an application ${KIND_TEXT[kind]}`);
    return { kind, arn, account: parsed[2]!, region: parsed[1]!, name: parsed[3]! };
  }

  const targetText = (t: Exclusion['target']) => `${KIND_TEXT[t.kind]} ${t.name}${t.kind === 'account' && t.name !== t.account ? ` (${t.account})` : ''}`;

  // The stored candidates decided again with the current exclusions.
  // The stored candidates decided again with the exclusions (no run needed): those of the given accounts only (an
  // exclusion concerns one account), or all.
  async function rescoped(d: DiscoveryApi, accounts?: string[]) {
    const load = accounts ? Promise.all(accounts.map((a) => d.store.accountCandidates(a))).then((x) => x.flat()) : d.store.listCandidates();
    const [stored, exclusions, inventory, candidates] = await Promise.all([d.store.getConfig(), d.store.listExclusions(), d.store.getInventory(), load]);
    const changed = rescope(candidates, withExclusions(stored?.config ?? DEFAULT_CONFIG, exclusions, now()), inventory ?? { accounts: [], ous: {} }, now());
    await d.store.putCandidates(changed);
    return changed.length;
  }

  // An expired exclusion no longer applies: the stored candidates are re-scoped once (no run needed), on the next read.
  async function settleExpired(d: DiscoveryApi): Promise<Exclusion[]> {
    const exclusions = await d.store.listExclusions();
    const lapsed = exclusions.filter((e) => e.expiresAt && Date.parse(e.expiresAt) <= now() && !e.lapsedAt);
    if (!lapsed.length) return exclusions;
    await rescoped(d, [...new Set(lapsed.map((e) => e.target.account))]);
    const at = new Date(now()).toISOString();
    for (const e of lapsed) await d.store.putExclusion({ ...e, lapsedAt: at });
    return d.store.listExclusions();
  }



  async function exclusionsRoute(method: string, id: string | undefined, identity: Identity, event: ApiEvent, d: DiscoveryApi): Promise<ApiResponse | null> {
    if (method === 'GET' && !id) {
      const all = await settleExpired(d);
      const active = new Set(activeExclusions(all, now()).map((e) => e.id));
      return reply(200, { exclusions: all.map((e) => ({ ...e, expired: !e.liftedAt && !active.has(e.id), lifting: Boolean(e.liftedAt) })) });
    }
    if (method === 'POST' && !id) {
      need(identity, 'operator');
      const body = bodyOf(event);
      const inventory = await d.store.getInventory();
      const target = exclusionTarget(body, (account) => inventory?.accounts.find((a) => a.id === account)?.name ?? account);
      const reason = reasonIn(body, REASON_MAX - EXCLUDED.length);
      const expiresAt = aheadIn(body, 'expiresAt', now());
      const workload = body.workload as { router?: string; id?: string } | undefined;
      let hint: { router: Router; id: string } | undefined;
      if (workload !== undefined) {
        const router = routers.find((r) => r.name === workload?.router);
        if (!router || !ID.test(String(workload?.id ?? '')) || target.kind !== 'target-group') {
          throw new HttpError(400, 'bad_request', 'workload must name a registered router and a workload id, with a target group exclusion');
        }
        hint = { router, id: String(workload.id) };
      }
      const exclusion: Exclusion = { id: newId(), target, reason, by: identity.email, at: new Date(now()).toISOString(), ...(expiresAt ? { expiresAt } : {}) };
      if (!operations) throw new HttpError(503, 'unavailable', 'the operations workflow is not configured');
      return audited(identity, 'exclude', targetText(target), async () => {
        // Stored first: the exclusion stands even if a router cannot be reached. The workflow pauses its workloads
        // (scale design §6): the API answers at once, whatever their number.
        await d.store.putExclusion(exclusion);
        const candidates = await rescoped(d, [target.account]);
        const op = await operations.create('exclude', { exclusionId: exclusion.id, ...(hint ? { hint: { router: hint.router.name, workloadId: hint.id } } : {}) }, identity.email);
        const result = [reason, ...(expiresAt ? [`until ${expiresAt}`] : []), `operation ${op.id}`].join('; ');
        return { result, response: reply(202, { exclusion, candidates, operation: op }) };
      });
    }
    if (method === 'DELETE' && id) {
      need(identity, 'operator');
      const exclusion = await d.store.getExclusion(decodeURIComponent(id));
      if (!exclusion) throw new HttpError(404, 'not_found', `unknown exclusion: ${id}`);
      if (!operations) throw new HttpError(503, 'unavailable', 'the operations workflow is not configured');
      return audited(identity, 'exclusion-lift', targetText(exclusion.target), async () => {
        // Marked lifted first (it no longer applies); the workflow resumes its workloads and deletes it once all are
        // resumed: until then it stays listed, and Lift again retries.
        const lifted = { ...exclusion, liftedAt: exclusion.liftedAt ?? new Date(now()).toISOString() };
        await d.store.putExclusion(lifted);
        const candidates = await rescoped(d, [exclusion.target.account]);
        const op = await operations.create('lift-exclusion', { exclusionId: exclusion.id }, identity.email);
        return { result: `${exclusion.reason}; operation ${op.id}`, response: reply(202, { candidates, operation: op }) };
      });
    }
    return null;
  }

  // --- Operations: onboard, offboard, install, upgrade and uninstall routers -------------------------------------------

  const ADMIN_TYPES = new Set(['install-router', 'upgrade-router', 'uninstall-router']);
  async function operationsRoute(method: string, id: string | undefined, identity: Identity, event: ApiEvent, ops: OperationsApi): Promise<ApiResponse | null> {
    if (method === 'GET' && !id) return reply(200, { operations: await ops.list() });
    if (method === 'GET' && id) {
      const op = await ops.get(decodeURIComponent(id));
      if (!op) throw new HttpError(404, 'not_found', `unknown operation: ${id}`);
      return reply(200, op);
    }
    if (method !== 'POST' || id) return null;
    const body = bodyOf(event);
    const type = String(body.type ?? '') as OperationType;
    if (!['onboard', 'offboard', ...ADMIN_TYPES].includes(type)) throw new HttpError(400, 'bad_request', 'type must be onboard, offboard, install-router, upgrade-router or uninstall-router');
    need(identity, ADMIN_TYPES.has(type) ? 'admin' : 'operator');
    let input: Record<string, unknown>;
    let target: string;
    if (type === 'onboard') {
      const name = nameOf(body.name, { required: false });
      const candidateId = String(body.candidateId ?? '');
      if (!(await discovery?.store.getCandidate(candidateId))) throw new HttpError(400, 'bad_request', `unknown candidate: ${candidateId}`);
      if (body.settings !== undefined && (typeof body.settings !== 'object' || body.settings === null || Array.isArray(body.settings))) throw new HttpError(400, 'bad_request', 'settings must be an object');
      if (body.databases !== undefined && !Array.isArray(body.databases)) throw new HttpError(400, 'bad_request', 'databases must be a list');
      input = { candidateId, ...(name ? { name } : {}), settings: body.settings ?? {}, databases: body.databases ?? [] };
      target = name ? `${candidateId} as ${name}` : candidateId;
    } else if (type === 'install-router') {
      const account = String(body.account ?? '');
      const region = String(body.region ?? '');
      if (!ACCOUNT.test(account) || !REGION.test(region)) throw new HttpError(400, 'bad_request', 'account (12 digits) and region required');
      input = { account, region };
      target = `${account}/${region}`;
    } else {
      const router = routerOf(String(body.router ?? ''));
      const account = router.account ?? managerAccount ?? '';
      if (type === 'offboard') {
        const workloadId = String(body.workloadId ?? '');
        if (!ID.test(workloadId)) throw new HttpError(400, 'bad_request', `invalid workload id: ${workloadId}`);
        input = { router: router.name, account, region: router.region, workloadId };
        target = `${router.name}/${workloadId}`;
      } else {
        input = { account, region: router.region };
        target = router.name;
      }
    }
    return audited(identity, `operation-${type}`, target, async () => {
      try {
        const op = await ops.create(type, input, identity.email);
        return { result: `started ${op.id}`, response: reply(202, { operation: op }) };
      } catch (err) {
        if ((err as Error).name === 'Conflict') {
          return { result: `conflict: ${(err as { operationId?: string }).operationId}`, response: reply(409, { error: 'conflict', message: (err as Error).message, operationId: (err as { operationId?: string }).operationId }) };
        }
        throw err;
      }
    });
  }

  return async function handler(event: ApiEvent): Promise<ApiResponse> {
    const method = event.requestContext.http.method;
    const parts = event.rawPath.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    try {
      if (method === 'GET' && parts.length === 1 && parts[0] === 'health') return reply(200, { status: 'ok', version });
      const identity = identityOf(event);
      if (!identity) throw new HttpError(401, 'unauthorized', 'sign in required');
      await refreshRouters();
      return await route(method, parts, identity, event);
    } catch (err) {
      if (err instanceof HttpError) return reply(err.statusCode, { error: err.code, message: err.message });
      if (err instanceof RouterError) return reply(502, { error: 'router_error', message: err.message });
      console.error(JSON.stringify({ level: 'error', event: 'ApiError', error: (err as Error).message }));
      return reply(500, { error: 'internal', message: 'internal error' });
    }
  };
}
