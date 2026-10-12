// Manager API: HTTP API (payload 2.0) behind the Cognito JWT authorizer. The routers answer through their controller;
// this layer adds identity, roles, aggregation over routers and the audit of mutating calls.
import { DEFAULT_CONFIG, lint, restatus, validateConfig, type Candidate, type DiscoveryStore } from '@dormeto/discovery';

export interface Router {
  name: string;
  region: string;
  controller: string;
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
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
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

function roleIn(body: Record<string, unknown>): Role {
  const role = body.role as Role;
  if (!ROLES.has(role)) throw new HttpError(400, 'bad_request', 'role must be viewer, operator or admin');
  return role;
}

export function createApi({ routers, invoke, audit, now = Date.now, newId = () => crypto.randomUUID(), version, users, preferences, discovery }: ApiOptions) {
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

  async function listAll() {
    const results = await Promise.allSettled(routers.map((r) => invoke(r, { action: 'list' })));
    return results.map((result, i) => ({ router: routers[i]!, result }));
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
      const all = await listAll();
      type Listed = { router?: { version?: string; build?: string; checkSchedule?: string; lastScheduledCheckAt?: string }; workloads?: unknown[] };
      return reply(200, {
        routers: all.map(({ router, result }) => (result.status === 'fulfilled'
          ? {
            name: router.name, region: router.region,
            version: (result.value as Listed).router?.version ?? null,
            build: (result.value as Listed).router?.build ?? null,
            workloads: ((result.value as Listed).workloads ?? []).length,
            // Health of the automatic naps: when the schedule last ran the idle check.
            checkSchedule: (result.value as Listed).router?.checkSchedule ?? null,
            lastScheduledCheckAt: (result.value as Listed).router?.lastScheduledCheckAt ?? null,
          }
          : { name: router.name, region: router.region, error: (result.reason as Error).message })),
      });
    }

    if (method === 'GET' && resource === 'workloads' && !a) {
      const all = await listAll();
      const workloads = all.flatMap(({ router, result }) => (result.status === 'fulfilled'
        ? ((result.value as { workloads?: Record<string, unknown>[] }).workloads ?? []).map((w) => ({ router: router.name, ...w }))
        : []));
      const errors = all.filter(({ result }) => result.status === 'rejected')
        .map(({ router, result }) => ({ router: router.name, message: ((result as PromiseRejectedResult).reason as Error).message }));
      return reply(200, { workloads, errors });
    }

    if (resource === 'workloads' && a && b) {
      const router = routerOf(a);
      const id = workloadId(b);
      if (method === 'GET' && !action) return reply(200, await invoke(router, { action: 'status', workloadId: id }));
      if (method === 'POST' && action === 'nap' && !parts[4]) {
        need(identity, 'operator');
        return audited(identity, 'nap', `${router.name}/${id}`, async () => {
          await invoke(router, { action: 'nap', workloadId: id }, { async: true });
          return { result: 'requested', response: reply(202, { accepted: true }) };
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
      if (method === 'GET') {
        const stored = await d.store.getConfig();
        const config = stored?.config ?? DEFAULT_CONFIG;
        return reply(200, { config, updatedAt: stored?.updatedAt ?? null, updatedBy: stored?.updatedBy ?? null, lint: lint(config, inventory) });
      }
      if (method === 'PUT') {
        need(identity, 'admin');
        const { config, errors } = validateConfig(bodyOf(event));
        if (!config) return reply(400, { error: 'bad_request', message: 'invalid configuration', errors });
        const summary = `${plural(config.filters.length, 'filter')}, ${plural(config.globalExcludes.length, 'global exclude')}, regions ${config.regions.join(' ')}`;
        return audited(identity, 'discovery-config', 'discovery', async () => {
          await d.store.putConfig(config, identity.email);
          return { result: summary, response: reply(200, { config, lint: lint(config, inventory) }) };
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

  return async function handler(event: ApiEvent): Promise<ApiResponse> {
    const method = event.requestContext.http.method;
    const parts = event.rawPath.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    try {
      if (method === 'GET' && parts.length === 1 && parts[0] === 'health') return reply(200, { status: 'ok', version });
      const identity = identityOf(event);
      if (!identity) throw new HttpError(401, 'unauthorized', 'sign in required');
      return await route(method, parts, identity, event);
    } catch (err) {
      if (err instanceof HttpError) return reply(err.statusCode, { error: err.code, message: err.message });
      if (err instanceof RouterError) return reply(502, { error: 'router_error', message: err.message });
      console.error(JSON.stringify({ level: 'error', event: 'ApiError', error: (err as Error).message }));
      return reply(500, { error: 'internal', message: 'internal error' });
    }
  };
}
