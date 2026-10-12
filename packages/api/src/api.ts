// Manager API: HTTP API (payload 2.0) behind the Cognito JWT authorizer. The routers answer through their controller;
// this layer adds identity, roles, aggregation over routers and the audit of mutating calls.
import {
  DEFAULT_CONFIG, EXCLUSION_KINDS, activeExclusions, exclusionCriterion, lint, matches, rescope, restatus, validateConfig, withExclusions,
  type Candidate, type DiscoveryStore, type Exclusion, type ExclusionKind,
} from '@dormeto/discovery';
import type { InstalledRouter, Operation, OperationType } from '@dormeto/operations';

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

// Workload ids of onboarded workloads (the waker finds a workload from its target group name).
const WORKLOAD_ID = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;

export function createApi({ routers: terraformRouters, invoke, audit, now = Date.now, newId = () => crypto.randomUUID(), version, users, preferences, discovery, operations, managerAccount }: ApiOptions) {
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

  async function listAll() {
    const results = await Promise.allSettled(routers.map((r) => invoke(r, { action: 'list' })));
    return results.map((result, i) => ({ router: routers[i]!, result }));
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

    if (method === 'GET' && resource === 'routers' && !a) return reply(200, { routers: await Promise.all(routers.map(routerRow)) });
    if (resource === 'routers' && a) {
      const router = routerOf(a);
      if (method === 'GET' && !b) return reply(200, { ...where(router), ...(await invokeNew(router, { action: 'router' }, 'router details') as object) });
      if (method === 'POST' && (b === 'pause' || b === 'resume') && !action) return pauseRoute(identity, event, router, b);
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
  const pairText = (list: { router: string; workloadId: string }[]) => list.map((p) => `${p.router}/${p.workloadId}`).join(', ');

  // The stored candidates decided again with the current exclusions.
  async function rescoped(d: DiscoveryApi) {
    const [stored, exclusions, inventory, candidates] = await Promise.all([d.store.getConfig(), d.store.listExclusions(), d.store.getInventory(), d.store.listCandidates()]);
    const changed = rescope(candidates, withExclusions(stored?.config ?? DEFAULT_CONFIG, exclusions, now()), inventory ?? { accounts: [], ous: {} }, now());
    await d.store.putCandidates(changed);
    return changed.length;
  }

  // An expired exclusion no longer applies: the stored candidates are re-scoped once (no run needed), on the next read.
  async function settleExpired(d: DiscoveryApi): Promise<Exclusion[]> {
    const exclusions = await d.store.listExclusions();
    const lapsed = exclusions.filter((e) => e.expiresAt && Date.parse(e.expiresAt) <= now() && !e.lapsedAt);
    if (!lapsed.length) return exclusions;
    await rescoped(d);
    const at = new Date(now()).toISOString();
    for (const e of lapsed) await d.store.putExclusion({ ...e, lapsedAt: at });
    return d.store.listExclusions();
  }

  // Pause the managed workloads of the stored candidates the exclusion matches (and the workload it was created from) in the
  // registered router of their account and region whose workload forwards to their target group. Each pause is saved with
  // the exclusion as soon as it succeeds (a Lift resumes it); a failure is reported, never fatal.
  async function pauseMatched(d: DiscoveryApi, e: Exclusion, identity: Identity, hint?: { router: Router; id: string }) {
    const inventory = (await d.store.getInventory()) ?? { accounts: [], ous: {} };
    const criterion = exclusionCriterion(e);
    const accountOf = (c: Candidate) => inventory.accounts.find((a) => a.id === c.account) ?? { id: c.account, name: c.accountName, ouPath: c.ouPath, tags: {} };
    const wanted = new Map<string, { workloadId: string; targetGroupArn?: string; routers: Router[] }>();
    for (const c of await d.store.listCandidates()) {
      if (!c.workloadId || c.goneAt || !matches(criterion, accountOf(c), c, inventory)) continue;
      wanted.set(`${c.workloadId} ${c.targetGroupArn}`, {
        workloadId: c.workloadId, ...(c.targetGroupArn ? { targetGroupArn: c.targetGroupArn } : {}),
        routers: routers.filter((r) => r.region === c.region && (!r.account || r.account === c.account)),
      });
    }
    if (hint) wanted.set(`${hint.id} ${e.target.arn}`, { workloadId: hint.id, targetGroupArn: e.target.arn!, routers: [hint.router] });
    const paused: { router: string; workloadId: string }[] = [];
    const unpaused: string[] = [];
    for (const { workloadId, targetGroupArn, routers: candidates } of wanted.values()) {
      let outcome: string | null = `${workloadId}: no registered router manages it`;
      for (const router of candidates) {
        try {
          await invoke(router, {
            action: 'pause', workloadId, ...(targetGroupArn ? { targetGroupArn } : {}), by: identity.email, reason: `${EXCLUDED}${e.reason}`,
            ...(e.expiresAt ? { until: e.expiresAt } : {}), exclusionId: e.id,
          });
          paused.push({ router: router.name, workloadId });
          await d.store.putExclusion({ ...e, paused });
          outcome = null;
          break;
        } catch (err) {
          if (err instanceof RouterError && err.message.startsWith('workload not configured')) continue;
          outcome = `${workloadId} (${router.name}): ${unknownAction(err, 'pause') ? 'router too old to pause, upgrade it to 0.16.0 or later' : (err as Error).message}`;
          break;
        }
      }
      if (outcome) unpaused.push(outcome);
    }
    return { paused, unpaused };
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
      return audited(identity, 'exclude', targetText(target), async () => {
        // Stored first: the exclusion stands even if a router cannot be reached.
        await d.store.putExclusion(exclusion);
        const candidates = await rescoped(d);
        const { paused, unpaused } = await pauseMatched(d, exclusion, identity, hint);
        const saved = { ...exclusion, ...(paused.length ? { paused } : {}) };
        const result = [reason, ...(expiresAt ? [`until ${expiresAt}`] : []), ...(paused.length ? [`paused ${pairText(paused)}`] : []),
          ...unpaused.map((u) => `not paused ${u}`)].join('; ');
        return { result, response: reply(201, { exclusion: saved, candidates, paused, unpaused }) };
      });
    }
    if (method === 'DELETE' && id) {
      need(identity, 'operator');
      const exclusion = await d.store.getExclusion(decodeURIComponent(id));
      if (!exclusion) throw new HttpError(404, 'not_found', `unknown exclusion: ${id}`);
      return audited(identity, 'exclusion-lift', targetText(exclusion.target), async () => {
        // Marked lifted first (it no longer applies), deleted only once every workload paused for it is resumed: a router
        // that cannot be reached leaves the exclusion listed, and Lift again retries.
        const lifted = { ...exclusion, liftedAt: exclusion.liftedAt ?? new Date(now()).toISOString() };
        await d.store.putExclusion(lifted);
        const candidates = await rescoped(d);
        const resumed: { router: string; workloadId: string }[] = [];
        const left: { router: string; workloadId: string }[] = [];
        const errors: string[] = [];
        for (const p of exclusion.paused ?? []) {
          const router = routers.find((r) => r.name === p.router);
          try {
            if (!router) throw new Error(`router ${p.router} is no longer registered`);
            // { resumed: false }: the pause already lapsed (its until), nothing left to resume.
            await invoke(router, { action: 'resume', workloadId: p.workloadId, by: identity.email, exclusionId: exclusion.id });
            resumed.push(p);
          } catch (err) {
            left.push(p);
            errors.push(`${p.router}/${p.workloadId}: ${(err as Error).message}`);
          }
        }
        if (left.length) await d.store.putExclusion({ ...lifted, paused: left });
        else await d.store.deleteExclusion(exclusion.id);
        const result = [exclusion.reason, ...(resumed.length ? [`resumed ${pairText(resumed)}`] : []), ...errors.map((e) => `not resumed ${e}`)].join('; ');
        return { result, response: reply(200, { candidates, resumed, errors }) };
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
      const workloadId = String(body.workloadId ?? '');
      if (!WORKLOAD_ID.test(workloadId)) throw new HttpError(400, 'bad_request', 'workloadId: lowercase letters, digits and hyphens, not starting or ending with a hyphen');
      const candidateId = String(body.candidateId ?? '');
      if (!(await discovery?.store.getCandidate(candidateId))) throw new HttpError(400, 'bad_request', `unknown candidate: ${candidateId}`);
      if (body.settings !== undefined && (typeof body.settings !== 'object' || body.settings === null || Array.isArray(body.settings))) throw new HttpError(400, 'bad_request', 'settings must be an object');
      if (body.databases !== undefined && !Array.isArray(body.databases)) throw new HttpError(400, 'bad_request', 'databases must be a list');
      input = { candidateId, workloadId, settings: body.settings ?? {}, databases: body.databases ?? [] };
      target = `${candidateId} as ${workloadId}`;
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
