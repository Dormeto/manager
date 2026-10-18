// Manager API: HTTP API (payload 2.0) behind the Cognito JWT authorizer. The routers answer through their controller;
// this layer adds identity, roles, aggregation over routers and the audit of mutating calls.
import {
  CANDIDATE_STATUSES, EXCLUSION_KINDS, InvalidCursor, activeExclusions, defaultConfig, lint, rescope, restatus, validateConfig, withExclusions,
  type Candidate, type DiscoveryConfig, type DiscoveryStore, type Exclusion, type ExclusionKind, type Status,
} from '@dormeto/discovery';
import type { InstalledRouter, Operation, WorkflowType } from '@dormeto/operations';
import { baselineHours, checkMinutesOf, historyView, idleWindowAdvice, reporting, savingsOf, type Baseline, type Discounts, type HistoryEntry, type RouterSummary, type SavingsSettings, type SavingsSummary, type UpdateCheck, type UpdateResult, type IdleWindowAdvice, type StoppedItem, type WorkloadSummary } from '@dormeto/fleet';
import { addEnergy, savedEnergy, type Energy } from '@dormeto/fleet/energy';
import type { IdleRequests } from './idle-requests.js';
import { fleetRouters, type FleetRouter } from './routers.js';
import type { Alarm, ListStatusLine } from './watchdog.js';
import { compareVersions, VERSION, type UpdateService } from './update.js';

export type Router = FleetRouter;

// Operations (onboarding, R4b): created by the API, run by the workflow.
export interface OperationsApi {
  create(type: WorkflowType, input: Record<string, unknown>, by: string): Promise<Operation>;
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
  // The newest version whose update notice the user dismissed (the daily check's banner).
  dismissedUpdate?: string;
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
  mfa?: boolean | null; // an authenticator app set up (R6c); null when Cognito could not say
}

// User management (Cognito, SES identities in the sandbox), behind the routes, roles and audit of this API.
export interface UsersService {
  list(): Promise<UserView[]>;
  invite(email: string, role: Role): Promise<{ invitation: 'sent' | 'pending-verification' }>;
  resend(email: string): Promise<{ invitation: 'sent' }>;
  setRole(email: string, role: Role): Promise<void>;
  setEnabled(email: string, enabled: boolean): Promise<void>;
  // The user's authenticator app turned off and, when the API can, deleted: they set one up again at their next sign-in
  // (R6c). tokenDeleted: false when there was none, or the delete is not available (then, under required, the pool still
  // asks for the old device).
  resetMfa(email: string): Promise<{ tokenDeleted: boolean }>;
}

// The MFA policy (R6c): optional; operators (administrators and operators must use MFA, viewer rights until they do);
// required (everyone, also enforced by the user pool).
export type MfaMode = 'optional' | 'operators' | 'required';

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
  username: string; // cognito:username, the user's name in the user pool
  email: string;
  groups: string[];
  role: Role;
  amr: string[] | null; // how this session signed in (the ID token's amr); null when the token has none
}

// A session is multi-factor when it signed in with a passkey (user verification) or with two factors.
const MULTI_FACTOR = ['mfa', 'swk', 'hwk'];
export const mfaSession = (identity: Identity): boolean | null => identity.amr && identity.amr.some((m) => MULTI_FACTOR.includes(m));

// The JWT authorizer flattens arrays: "[dmt-admin dmt-viewer]", "[pwd otp mfa]".
export function identityOf(event: ApiEvent): Identity | null {
  const claims = event.requestContext.authorizer?.jwt?.claims;
  if (!claims?.sub) return null;
  const groups = (claims['cognito:groups'] ?? '').replace(/^\[|\]$/g, '').split(/[\s,]+/).filter(Boolean);
  const amr = claims.amr === undefined || claims.amr === '' ? null : claims.amr.replace(/^\[|\]$/g, '').split(/[\s,]+/).filter(Boolean);
  const role = groups.map((g) => GROUPS[g]).filter((r): r is Role => r !== undefined)
    .reduce<Role>((best, r) => (RANK[r] > RANK[best] ? r : best), 'viewer');
  return { sub: claims.sub, username: claims['cognito:username'] ?? claims.sub, email: claims.email ?? claims['cognito:username'] ?? claims.sub, groups, role, amr };
}

// 'app' only for two factors (otp and mfa): a session that stopped at the password is 'password'.
const signInMethod = (identity: Identity): 'passkey' | 'app' | 'password' | null =>
  !identity.amr ? null : identity.amr.some((m) => m === 'swk' || m === 'hwk') ? 'passkey' : identity.amr.includes('otp') && identity.amr.includes('mfa') ? 'app' : 'password';

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
  install?: { env: string; region: string }; // the answer of a manager not set up for updates: its env and region
  update?: UpdateService; // the manager's self-update: only when installed with the Dormeto CLI
  preferences?: PreferencesStore;
  discovery?: DiscoveryApi;
  operations?: OperationsApi;
  managerAccount?: string;
  discoveryMode?: string; // the mode of the perimeter's default configuration (DISCOVERY_MODE: organization or account)
  routerVersion?: string; // the router version the manager installs and upgrades to
  // Routers and workloads as the routers report them (scale design §4): read instead of calling every router.
  fleet?: {
    listRouters(): Promise<RouterSummary[]>; listWorkloads(): Promise<WorkloadSummary[]>; getWorkload(account: string, region: string, id: string): Promise<WorkloadSummary | null>;
    // The state history (R8).
    listHistory?(account: string, region: string, id: string, from: string, to: string): Promise<{ entries: HistoryEntry[]; truncated: boolean }>;
    historyBefore?(account: string, region: string, id: string, at: string): Promise<HistoryEntry | null>;
    // What the daily savings job computed last (R9).
    getSavingsSummary?(): Promise<SavingsSummary | null>;
    // The discounts for commitments (R9.5).
    getSavingsSettings?(): Promise<SavingsSettings>;
    putSavingsSettings?(discounts: Discounts, by: string): Promise<void>;
    // The daily update check (its setting, and the last result).
    getUpdateCheck?(): Promise<UpdateCheck>;
    putUpdateCheck?(check: UpdateCheck & { updatedBy: string }): Promise<void>;
    getUpdateResult?(): Promise<UpdateResult | null>;
    // A workload's idle window advice (R10), kept a day.
    getIdleWindow?(account: string, region: string, id: string): Promise<IdleWindowAdvice | null>;
    putIdleWindow?(account: string, region: string, id: string, advice: IdleWindowAdvice): Promise<void>;
  };
  // The idle window advisor (R10): a workload's requests per minute, read by the discovery function.
  idleRequests?: IdleRequests;
  // A period's savings (R9): AWS's list prices of what the naps stopped, within the baseline; Spot prices and the
  // discounts (R9.5).
  savings?: { baseline: Baseline; hourly(region: string, item: StoppedItem, discounts?: Discounts): Promise<number | null> };
  // What the caller may see in listings (everything for now; R11 scopes it by tags).
  visible?: (identity: Identity, item: { account?: string; region: string }) => boolean;
  // How long each workload's figures are kept for the bar of all workloads, whatever its state (an hour).
  statesCacheMs?: number;
  // The organization roles the manager assumes, set in its Terraform (packaging design §3).
  accessRoles?: { discoveryRole: string; commandRole: string };
  callTimeoutMs?: number; // a router that does not report, called directly: answer within (5 s)
  callConcurrency?: number; // at most this many such calls at once (10)
  callDeadlineMs?: number; // and all of them within (20 s: API Gateway answers within 29 s); the others are not called
  // Health alarms (R6a): the watchdog's open alarms, and where the alert topic sends them.
  alerts?: {
    open(): Promise<Alarm[]>;
    subscriptions(): Promise<{ topicArn: string; subscriptions: { protocol: string; endpoint: string; pending: boolean }[] }>;
  };
  // The MFA policy (R6c) and whether a user has an authenticator app (Cognito AdminGetUser).
  // passkeys: whether the pool offers them (the module's PASSKEYS).
  mfa?: { mode: MfaMode; passkeys?: boolean; enabled(username: string): Promise<boolean> };
  // The manager's IP lists (R6b): its catalog, and what the list function last did for each list (status.json).
  ipLists?: {
    catalogUrl: string;
    catalog(): Promise<{ lists?: { name: string; url: string; action: string; refreshHours: number }[] } | null>;
    status(): Promise<{ lists?: (ListStatusLine & { dropped?: number })[] } | null>;
  };
}

// An alert endpoint as administrators see it: an address reduced to its first letter and domain, an ARN to its name.
export function maskEndpoint(protocol: string, endpoint: string): string {
  if (protocol === 'email' || protocol === 'email-json') {
    const [local = '', domain = ''] = endpoint.split('@');
    return `${local.slice(0, 1)}…@${domain}`;
  }
  if (endpoint.startsWith('arn:')) return endpoint.split(':').at(-1)!;
  try {
    return new URL(endpoint).host;
  } catch {
    return '…';
  }
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DAY_MS = 86_400_000;
// The time in each state of a Workloads row and a workload's view (7 days) and its savings (30 days): kept 5 minutes, for
// at most 10,000 workloads.
const STATES_DAYS = 7;
const COSTS_DAYS = 30;
// The idle window advisor (R10): the days of requests replayed (CloudWatch keeps one-minute data 15 days), and the
// router's idle window when the summary has none.
const IDLE_DAYS = 14;
const DEFAULT_IDLE_MINUTES = 15;
const STATES_MS = 300_000;
const STATES_KEPT_MAX = 10_000;
const HOUR_MS = 3_600_000;
// The bar of all workloads reads at most this many workloads' histories at once.
const STATES_CONCURRENCY = 20;
const MONTH_HOURS = 730;
// The discounts for commitments (R9.5): read at most once a minute.
const DISCOUNTS_MS = 60_000;
const DISCOUNT_MAX = 90;
const anyDiscount = (d: Discounts) => d.compute > 0 || d.databases > 0;
const sameDiscounts = (a: Discounts, b: Discounts) => a.compute === b.compute && a.databases === b.databases;

// Seconds per state of the phases within [from, to].
function totalsWithin(phases: { state: string; from: string; to: string }[], from: string, to: string): Record<string, number> {
  const [a, b] = [Date.parse(from), Date.parse(to)];
  const totals: Record<string, number> = {};
  for (const p of phases) {
    const seconds = Math.round((Math.min(b, Date.parse(p.to)) - Math.max(a, Date.parse(p.from))) / 1000);
    if (seconds > 0) totals[p.state] = (totals[p.state] ?? 0) + seconds;
  }
  return totals;
}
const REASON_MAX = 256;
// Pause until and exclusion expiry: at most this far ahead.
const AHEAD_MAX_MS = 366 * DAY_MS;
const ACCOUNT = /^\d{12}$/;
// Candidates per page of the Discovery view: 50 by default, at most 200 (scale design §5).
const CANDIDATES_PAGE = 50;
// Accounts not ready per page of the Organization access panel.
const ACCESS_PAGE = 100;
const ACCESS_MAX = 1000;
const CANDIDATES_MAX = 200;
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


// What a failed wake does (R7a), checked before the operation starts (the router checks it again at its preview).
const INSTANCE_TYPE = /^[a-z][a-z0-9-]*\d[a-z0-9-]*\.[a-z0-9]+$/;
function settingsOfFailures(settings: Record<string, unknown> | undefined) {
  const types = settings?.fallbackInstanceTypes;
  if (types !== undefined && (!Array.isArray(types) || types.length > 5 || !types.every((t) => typeof t === 'string' && INSTANCE_TYPE.test(t)))) {
    throw new HttpError(400, 'bad_request', 'settings: fallbackInstanceTypes must be at most 5 EC2 instance types (for example t3a.medium)');
  }
  const retry = settings?.failedRetrySeconds;
  if (retry !== undefined && (!Number.isInteger(retry) || (retry as number) < 10 || (retry as number) > 600)) {
    throw new HttpError(400, 'bad_request', 'settings: failedRetrySeconds must be a whole number from 10 to 600');
  }
}
export function createApi({
  routers: terraformRouters, invoke, audit, now = Date.now, newId = () => crypto.randomUUID(), version, users, install, update, preferences, discovery, operations, managerAccount, discoveryMode, routerVersion, alerts, ipLists, mfa, savings,
  fleet, idleRequests, visible = () => true, callTimeoutMs = 5_000, callConcurrency = 10, callDeadlineMs = 20_000, accessRoles, statesCacheMs = 3_600_000,
}: ApiOptions) {
  // Routers of this request: written in Terraform, then installed by the manager (a unique name each: the AWS name is the
  // same in every region).
  let routers: Router[] = terraformRouters;
  async function refreshRouters() {
    routers = fleetRouters(terraformRouters, (await operations?.installedRouters()) ?? [], managerAccount);
  }
  // What the caller may see (everything until R11): anything else answers as unknown.
  const sees = (identity: Identity, account: string | undefined, region: string | undefined) => visible(identity, { account, region: region ?? '' });
  const routerOf = (name: string | undefined, identity?: Identity): Router => {
    const router = routers.find((r) => r.name === name);
    if (!router || (identity && !sees(identity, router.account ?? managerAccount ?? '', router.region))) throw new HttpError(404, 'not_found', `unknown router: ${name}`);
    return router;
  };
  const workloadId = (raw: string | undefined): string => {
    const id = decodeURIComponent(raw ?? '');
    if (!ID.test(id)) throw new HttpError(400, 'bad_request', `invalid workload id: ${id}`);
    return id;
  };
  const need = (identity: Identity, role: Role) => {
    if (RANK[identity.role] >= RANK[role]) return;
    // Rights the user has, waiting for their MFA (R6c): say so rather than that they lack the role.
    const own = claimed.get(identity)?.role;
    if (own && RANK[own] >= RANK[role]) throw new HttpError(403, 'forbidden', `two-step verification required to use your ${own} rights: set it up from your Account page`);
    throw new HttpError(403, 'forbidden', `${role} role required`);
  };

  // The MFA policy (R6c): what Cognito says of each user's authenticator, cached per instance (5 minutes when set up, 30
  // seconds when not, so that a user who just set it up gets their rights soon; /api/me?fresh=1 reads it again).
  const mfaCache = new Map<string, { enabled: boolean; at: number }>();
  const MFA_ON_MS = 5 * 60_000;
  const MFA_OFF_MS = 30_000;
  async function mfaOf(identity: Identity, fresh: boolean): Promise<boolean> {
    const cached = mfaCache.get(identity.username);
    if (!fresh && cached && now() - cached.at < (cached.enabled ? MFA_ON_MS : MFA_OFF_MS)) return cached.enabled;
    const enabled = await mfa!.enabled(identity.username);
    mfaCache.set(identity.username, { enabled, at: now() });
    return enabled;
  }
  // The role a user's groups give, the role they act with, and their MFA, per request.
  const claimed = new WeakMap<Identity, { role: Role; enabled: boolean | null; effective: Role | null }>();
  const mfaRequired = (role: Role) => !!mfa && (mfa.mode === 'required' || (mfa.mode === 'operators' && role !== 'viewer'));
  // amr counts only where the pool offers passkeys: otherwise the enrollment decides, as before.
  const session = (identity: Identity): boolean | null => (mfa?.passkeys ? mfaSession(identity) : null);
  async function applyMfa(identity: Identity, isMe: boolean, fresh: boolean) {
    const role = identity.role;
    const required = mfaRequired(role);
    // Cognito unable to say (throttled, the user gone): the MFA is unknown, so the rights it gives are not given.
    // A session that says how it signed in (amr) decides by itself; the authenticator is read for /api/me only.
    const enabled = mfa && ((required && session(identity) === null) || isMe)
      ? await mfaOf(identity, fresh).catch((err: Error) => {
        console.error(JSON.stringify({ level: 'error', event: 'MfaUnknown', user: identity.username, error: err.message }));
        return null;
      })
      : null;
    let effective: Role | null = role;
    if (required && !(session(identity) ?? enabled)) effective = mfa!.mode === 'required' ? null : 'viewer';
    claimed.set(identity, { role, enabled: enabled ?? null, effective });
    if (effective === null && !isMe) throw new HttpError(403, 'mfa_required', 'two-step verification required: set it up from your Account page');
    identity.role = effective ?? 'viewer';
  }
  function me(identity: Identity) {
    const c = claimed.get(identity) ?? { role: identity.role, enabled: null, effective: identity.role };
    return {
      email: identity.email, groups: identity.groups, role: c.role, effectiveRole: c.effective,
      // enabled: null when Cognito could not say.
      // method: how this session signed in; null for a token without amr.
      ...(mfa ? { mfa: { mode: mfa.mode, enabled: c.enabled, required: mfaRequired(c.role), method: mfa.passkeys ? signInMethod(identity) : null, passkeys: mfa.passkeys ?? false } } : {}),
    };
  }

  // Mutating call: always audited, with its result or its error.
  // `run` may name the target it found (a plan's version), else the one given is kept.
  async function audited(identity: Identity, action: string, target: string, run: () => Promise<{ result: string; response: ApiResponse; target?: string }>) {
    const entry = { id: newId(), at: new Date(now()).toISOString(), who: identity.email, role: identity.role, action, target };
    try {
      const { result, response, target: found } = await run();
      await audit.write({ ...entry, ...(found ? { target: found } : {}), result });
      return response;
    } catch (err) {
      await audit.write({ ...entry, result: `error: ${(err as Error).message}` });
      throw err;
    }
  }

  // A router called directly (it does not report): its answer within the timeout, at most callConcurrency at once, and
  // none started once the request's deadline is reached (a fleet whose reports stopped still lists within it).
  function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new RouterError(`no answer within ${ms} ms`)), ms); });
    return Promise.race([promise, late]).finally(() => clearTimeout(timer));
  }
  // A call that timed out keeps its place until the router answers (its Lambda still runs): at most callConcurrency
  // router invocations at once, without waiting for those answers.
  async function each<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
    const out: PromiseSettledResult<R>[] = new Array(items.length);
    const deadline = Date.now() + callDeadlineMs;
    let next = 0;
    let running = 0;
    const waiting: (() => void)[] = [];
    // A place for a call, or false once the deadline passes while waiting for one.
    const place = (left: number) => new Promise<boolean>((resolve) => {
      if (running < callConcurrency) {
        running += 1;
        resolve(true);
        return;
      }
      const take = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        const at = waiting.indexOf(take);
        if (at >= 0) waiting.splice(at, 1);
        resolve(false);
      }, left);
      waiting.push(take);
    });
    // An answer frees its place for the next waiting call.
    const free = () => {
      const take = waiting.shift();
      if (take) take();
      else running -= 1;
    };
    const notCalled = (): PromiseSettledResult<R> => ({ status: 'rejected', reason: new RouterError(`not called: no time left in this request (${callDeadlineMs} ms)`) });
    await Promise.all(Array.from({ length: Math.min(callConcurrency, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        const left = deadline - Date.now();
        if (left <= 0 || !(await place(left))) {
          out[i] = notCalled();
          continue;
        }
        const call = work(items[i]!);
        call.then(free, free);
        try {
          out[i] = { status: 'fulfilled', value: await bounded(call, Math.max(1, Math.min(callTimeoutMs, deadline - Date.now()))) };
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

  // Every workload of the routers the caller sees: from the summaries of the routers that report, from the others by
  // their list action.
  // A workload's history over a period (R8): its entries from the store, the state before them, and the view of it.
  async function historyOf(account: string, region: string, id: string, from: string, to: string, summaryOf: () => Promise<{ state?: unknown; historySince?: unknown } | null>) {
    const [{ entries, truncated }, found] = await Promise.all([fleet!.listHistory!(account, region, id, from, to), fleet!.historyBefore!(account, region, id, from)]);
    // Capped (review I2): the newest entries are kept, and the time before the oldest of them is unknown.
    const before = truncated ? null : found;
    // No entry before the period, but a history that began before it (review I3: its last change expired): the state
    // then was the one before the period's first change, or, with none, the summary's.
    let initial: string | undefined;
    if (!before && !truncated) {
      const summary = await summaryOf().catch(() => null);
      if (typeof summary?.historySince === 'string' && summary.historySince < from) initial = entries[0]?.from ?? (summary.state as string | undefined);
    }
    return { view: historyView({ before, entries, from, to, now: to, initial }), before, entries, truncated };
  }

  // From a workload's last 30 days of history (user request: the bar of a Workloads row and of a workload's view): its
  // seconds in each state over the last 7 days, and, with prices, its savings over the 30 days: what its naps saved, the
  // share of its time with history asleep within the baseline, and its last nap's items priced (an estimate of a month's
  // savings at that rate). Kept 5 minutes per workload while its state stays the same; without its history, nothing
  // (never an error).
  type Costs = {
    baseline: Baseline; from: string; to: string; napAt: string | null; savedShare: number | null;
    items: { item: StoppedItem; hourly: number | null }[]; saved: { usd: number; hours: number; unpricedHours: number };
    discounts?: Discounts;
  };
  // The discounts for commitments (R9.5), read at most once a minute (a read in progress shared); a change made here is
  // seen at once, one made elsewhere within the minute, and then the figures kept, priced with the previous ones, are
  // priced again (final review 1). While the reads fail, the last ones known; none known, the read fails (no costs).
  let discountsKept: { at: number; value: Discounts } | null = null;
  let discountsAsked: Promise<Discounts> | null = null;
  function discountsOf(): Promise<Discounts> {
    if (discountsKept && now() - discountsKept.at < DISCOUNTS_MS) return Promise.resolve(discountsKept.value);
    discountsAsked ??= (async () => {
      try {
        const stored = await fleet?.getSavingsSettings?.();
        const value = { compute: stored?.compute ?? 0, databases: stored?.databases ?? 0 };
        if (discountsKept && !sameDiscounts(discountsKept.value, value)) statesKept.clear();
        discountsKept = { at: now(), value };
        return value;
      } catch (err) {
        if (!discountsKept) throw err;
        discountsKept = { at: now(), value: discountsKept.value };
        return discountsKept.value;
      } finally {
        discountsAsked = null;
      }
    })();
    return discountsAsked;
  }
  // energy: with the costs, what the last nap's items saved over its hours asleep within the baseline (costs.saved.hours),
  // in the workload's region (@dormeto/fleet/energy).
  type States = { states7d: { from: string; to: string; totals: Record<string, number> }; costs?: Costs; energy?: Energy };
  const statesKept = new Map<string, { state: unknown; at: number; value: States }>();
  // A workload's figures and when they were computed: kept maxAgeMs, and, for its own row and view, while its state stays
  // the same.
  async function statesEntry(account: string, region: string, id: string, summary: { state?: unknown; historySince?: unknown } | null,
    { maxAgeMs = STATES_MS, sameState = true } = {}): Promise<{ value: States; at: number } | undefined> {
    if (!fleet?.listHistory || !fleet.historyBefore) return undefined;
    const key = `${account}#${region}#${id}`;
    // The discounts first: a change seen elsewhere clears the figures kept. Without them, the figures have no costs.
    const discounts = savings ? await discountsOf().catch(() => null) : null;
    const t = now();
    const kept = statesKept.get(key);
    if (kept && t - kept.at < maxAgeMs && (!sameState || kept.state === summary?.state)) return kept;
    try {
      const to = new Date(t).toISOString();
      const [from, from7] = [new Date(t - COSTS_DAYS * DAY_MS).toISOString(), new Date(t - STATES_DAYS * DAY_MS).toISOString()];
      const { view } = await historyOf(account, region, id, from, to, async () => summary);
      const value: States = { states7d: { from: from7, to, totals: totalsWithin(view.phases, from7, to) } };
      if (savings && discounts) {
        const hourly = (item: StoppedItem) => savings.hourly(region, item, discounts).catch(() => null);
        const known = view.phases.filter((p) => p.state !== 'UNKNOWN').reduce((n, p) => n + (Date.parse(p.to) - Date.parse(p.from)) / HOUR_MS, 0);
        const asleep = view.phases.filter((p) => p.state === 'ASLEEP').reduce((n, p) => n + baselineHours(p.from, p.to, savings.baseline), 0);
        const last = [...view.phases].reverse().find((p) => p.state === 'ASLEEP' && p.stopped);
        const realized = await savingsOf(view.phases, { hourly, baseline: savings.baseline });
        value.costs = {
          baseline: savings.baseline, from, to, napAt: last?.from ?? null, savedShare: known ? asleep / known : null,
          items: await Promise.all((last?.stopped ?? []).map(async (item) => ({ item, hourly: await hourly(item) }))),
          saved: { usd: realized.usd, hours: realized.hours, unpricedHours: realized.unpriced.reduce((n, u) => n + u.hours, 0) },
          ...(anyDiscount(discounts) ? { discounts } : {}),
        };
        value.energy = savedEnergy(value.costs.items.map((i) => i.item), value.costs.saved.hours, region);
      }
      const entry = { state: summary?.state, at: t, value };
      // Figures without their costs because the discounts could not be read are not kept.
      if (savings && !discounts) return entry;
      if (statesKept.size >= STATES_KEPT_MAX) statesKept.clear();
      statesKept.set(key, entry);
      return entry;
    } catch {
      return undefined;
    }
  }
  const statesOf = async (account: string, region: string, id: string, summary: { state?: unknown; historySince?: unknown } | null) => (await statesEntry(account, region, id, summary))?.value;

  // All the workloads the caller sees (user request: the bar of the Workloads view): their seconds in each state over 7
  // days, their savings and the energy their naps did not use (the Overview, PR #1) added up, from each workload's figures
  // kept statesCacheMs whatever its state.
  async function allStates(seen: Record<string, unknown>[]) {
    // Read before the figures: those kept are then priced with them (final review 1).
    const discounts = savings ? await discountsOf().catch(() => null) : null;
    const queue = [...seen];
    const entries: { value: States; at: number }[] = [];
    await Promise.all(Array.from({ length: STATES_CONCURRENCY }, async () => {
      for (let w = queue.shift(); w; w = queue.shift()) {
        const router = routers.find((r) => r.name === w.router);
        if (!router) continue;
        const entry = await statesEntry(String(w.account ?? accountOfRouter(router)), String(w.region ?? router.region), String(w.workloadId), w, { maxAgeMs: statesCacheMs, sameState: false });
        if (entry) entries.push(entry);
      }
    }));
    const computedAt = entries.length ? Math.min(...entries.map((e) => e.at)) : now();
    const totals: Record<string, number> = {};
    for (const { value } of entries) for (const [state, seconds] of Object.entries(value.states7d.totals)) totals[state] = (totals[state] ?? 0) + seconds;
    const priced = entries.map((e) => e.value.costs).filter((c): c is Costs => Boolean(c));
    const hourlyOf = (c: Costs) => c.items.reduce((n, i) => n + (i.hourly ?? 0), 0);
    const pricedOnes = priced.filter((c) => c.items.some((i) => i.hourly !== null));
    // The workloads with an estimate (an item of a known shape): none, no estimate yet (never a zero said as one).
    const estimated = entries.map((e) => e.value.energy).filter((e): e is Energy => Boolean(e?.estimated));
    return {
      workloads: seen.length, computedAt: new Date(computedAt).toISOString(), cacheMinutes: statesCacheMs / 60_000,
      states7d: { from: new Date(computedAt - STATES_DAYS * DAY_MS).toISOString(), to: new Date(computedAt).toISOString(), totals },
      ...(savings && discounts ? {
        costs: {
          baseline: savings.baseline,
          saved: priced.reduce((n, c) => ({ usd: n.usd + c.saved.usd, hours: n.hours + c.saved.hours, unpricedHours: n.unpricedHours + c.saved.unpricedHours }), { usd: 0, hours: 0, unpricedHours: 0 }),
          hourly: pricedOnes.length ? pricedOnes.reduce((n, c) => n + hourlyOf(c), 0) : null,
          monthly: pricedOnes.length ? pricedOnes.reduce((n, c) => n + hourlyOf(c) * MONTH_HOURS * (c.savedShare ?? 0), 0) : null,
          priced: pricedOnes.length,
          ...(anyDiscount(discounts) ? { discounts } : {}),
        },
        energy: { ...estimated.reduce(addEnergy, { kwh: 0, co2Kg: 0, estimated: 0 }), workloads: estimated.length },
      } : {}),
    };
  }

  async function listAll(identity: Identity) {
    const { summaries, workloads } = await reports();
    const shown = routers.filter((r) => visible(identity, { account: accountOfRouter(r), region: r.region }));
    const silent = shown.filter((r) => !summaries.has(r));
    const called = await each(silent, (r) => invoke(r, { action: 'list' }));
    const rows: Record<string, unknown>[] = [];
    const errors: { router: string; message: string }[] = [];
    for (const router of shown) {
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
    // The routers' rows as well (the Overview): from their summaries, or from the list answer of those that do not report.
    const routerRows = () => shown.map((router) => {
      const summary = summaries.get(router);
      if (summary) return reportingRow(router, summary, workloads);
      const result = called[silent.indexOf(router)]!;
      return result.status === 'fulfilled' ? listedRow(router, result.value as Listed) : { ...where(router), error: (result.reason as Error).message, reporting: false };
    });
    return { rows, errors, routerRows };
  }

  // A router that reports, from its summary and its workloads' summaries.
  function reportingRow(router: Router, summary: RouterSummary, workloads: WorkloadSummary[]) {
    const own = workloads.filter((w) => w.account === summary.account && w.region === summary.region);
    const health = (summary.health ?? {}) as { status?: string; problems?: unknown[]; lastScheduledCheckAt?: string | null };
    const updated = own.map((w) => Date.parse(String(w.updatedAt ?? ''))).filter((ms) => ms > 0);
    // An install or upgrade since its last report: the version it put there (the router reports it at its next check).
    const { version, build } = router.installed && Date.parse(router.installed.at) > Date.parse(summary.checkedAt ?? '') ? router.installed : summary;
    return {
      ...where(router), version, build, workloads: Object.values(summary.counts).reduce((n, c) => n + c, 0),
      checkSchedule: summary.checkSchedule, lastScheduledCheckAt: health.lastScheduledCheckAt ?? summary.checkedAt,
      health: { status: health.status ?? 'unknown', problems: health.problems ?? [] }, pauses: summary.pauses, workloadStates: summary.counts,
      paused: summary.pauses.length ? own.length : own.filter((w) => (w.pauses as unknown[] | undefined)?.length).length,
      lastActivityAt: updated.length ? new Date(Math.max(...updated)).toISOString() : null, reporting: true, checkedAt: summary.checkedAt,
    };
  }
  // A router that does not report, from its list answer (no health: its check schedule tells whether it is late).
  function listedRow(router: Router, listed: Listed) {
    const own = (listed.workloads ?? []) as { state?: string; pauses?: unknown[]; updatedAt?: string }[];
    const workloadStates: Record<string, number> = {};
    for (const w of own) workloadStates[String(w.state)] = (workloadStates[String(w.state)] ?? 0) + 1;
    const updated = own.map((w) => Date.parse(String(w.updatedAt ?? ''))).filter((ms) => ms > 0);
    const pauses = (listed.router as { pauses?: unknown[] } | undefined)?.pauses ?? [];
    return {
      ...where(router), version: listed.router?.version ?? null, build: listed.router?.build ?? null, workloads: own.length,
      checkSchedule: listed.router?.checkSchedule ?? null, lastScheduledCheckAt: listed.router?.lastScheduledCheckAt ?? null, pauses, workloadStates,
      paused: pauses.length ? own.length : own.filter((w) => w.pauses?.length).length,
      lastActivityAt: updated.length ? new Date(Math.max(...updated)).toISOString() : null, reporting: false,
    };
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
  const where = (router: Router) => ({
    name: router.name, region: router.region, ...(router.account ? { account: router.account } : {}), ...(router.source ? { source: router.source } : {}),
    ...(router.clusters ? { clusters: router.clusters } : {}),
  });

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
    if (method === 'GET' && resource === 'me' && !a) return reply(200, me(identity));

    if (resource === 'preferences' && !a && preferences) {
      if (method === 'GET') return reply(200, { ...DEFAULT_PREFERENCES, ...((await preferences.get(identity.sub)) ?? {}) });
      if (method === 'PUT') {
        const body = bodyOf(event);
        const stored = { ...DEFAULT_PREFERENCES, ...((await preferences.get(identity.sub)) ?? {}) };
        const saved = { ...stored };
        // Each field is optional but one: what is not sent is kept.
        if (body.dismissedUpdate !== undefined) {
          if (typeof body.dismissedUpdate !== 'string' || !VERSION.test(body.dismissedUpdate)) throw new HttpError(400, 'bad_request', 'dismissedUpdate must be a version');
          saved.dismissedUpdate = body.dismissedUpdate;
        }
        if (body.refreshSeconds !== undefined || body.dismissedUpdate === undefined) {
          const refresh = body.refreshSeconds;
          if (!Number.isInteger(refresh) || (refresh !== 0 && ((refresh as number) < 5 || (refresh as number) > 600))) {
            throw new HttpError(400, 'bad_request', 'refreshSeconds must be 0 (off) or an integer from 5 to 600');
          }
          saved.refreshSeconds = refresh as number;
        }
        await preferences.put(identity.sub, saved);
        return reply(200, saved);
      }
    }

    if (method === 'GET' && resource === 'ip-lists' && !a) {
      if (!ipLists) return reply(200, { catalog: null, lists: [] });
      const [catalog, status] = await Promise.all([ipLists.catalog(), ipLists.status()]);
      const lines = new Map((status?.lists ?? []).map((l) => [l.name, l]));
      return reply(200, {
        catalog: ipLists.catalogUrl,
        lists: (catalog?.lists ?? []).map(({ name, url, action, refreshHours }) => {
          const l = lines.get(name);
          // The version published, when it comes from this URL; the last attempt, when it tried this URL.
          const published = l && l.url === url ? { version: l.version, entries: l.entries, dropped: l.dropped, fetchedAt: l.fetchedAt } : {};
          const attempted = l && (l.attemptUrl ?? l.url) === url ? { lastAttemptAt: l.lastAttemptAt, error: l.error, errorAt: l.errorAt } : {};
          const done = { ...published, ...attempted };
          return { name, url, action, refreshHours, ...Object.fromEntries(Object.entries(done).filter(([, v]) => v !== undefined)) };
        }),
      });
    }

    if (method === 'GET' && resource === 'alerts' && !a) {
      if (!alerts) return reply(200, { alarms: [], notifications: null });
      const [open, { topicArn, subscriptions }] = await Promise.all([alerts.open(), alerts.subscriptions()]);
      const shown = open.filter((alarm) => alarm.subject.kind !== 'router' || visible(identity, { account: alarm.subject.account, region: alarm.subject.region ?? '' }));
      const confirmed = subscriptions.filter((x) => !x.pending).length;
      return reply(200, {
        alarms: shown.map(({ subject, level, since, problems }) => ({ ...subject, level, since, problems })),
        notifications: {
          topicArn, confirmed, pending: subscriptions.length - confirmed,
          ...(RANK[identity.role] >= RANK.admin ? { endpoints: subscriptions.map((x) => ({ protocol: x.protocol, endpoint: maskEndpoint(x.protocol, x.endpoint), pending: x.pending })) } : {}),
        },
      });
    }

    if (method === 'GET' && resource === 'routers' && !a) {
      const shown = routers.filter((r) => visible(identity, { account: accountOfRouter(r), region: r.region }));
      const [{ summaries, workloads }, listed] = await Promise.all([reports(), operations?.list() ?? []]);
      const silent = shown.filter((r) => !summaries.has(r));
      const called = await each(silent, (r) => routerRow(r));
      // The install, upgrade or uninstall running on a router (the dashboard shows it in progress).
      const running = listed.filter((op) => op.status === 'running' && ADMIN_TYPES.has(op.type));
      const operationOf = (router: Router) => {
        const op = running.find((o) => o.target.account === accountOfRouter(router) && o.target.region === router.region);
        return op ? { operation: { id: op.id, type: op.type } } : {};
      };
      const rows = shown.map((router) => {
        const summary = summaries.get(router);
        if (!summary) {
          const result = called[silent.indexOf(router)]!;
          return { ...(result.status === 'fulfilled' ? result.value : { ...where(router), error: (result.reason as Error).message }), reporting: false, ...operationOf(router) };
        }
        return { ...reportingRow(router, summary, workloads), ...operationOf(router) };
      });
      return reply(200, { routers: rows, ...(routerVersion ? { available: { version: routerVersion } } : {}) });
    }
    if (resource === 'routers' && a) {
      const router = routerOf(a, identity);
      if (method === 'GET' && !b) {
        const details = await invokeNew(router, { action: 'router' }, 'router details') as { configuration?: Record<string, { source?: string }> };
        // A router cannot tell who installed it: one the manager installed has its configuration from the manager (its
        // router settings, in the blueprint), not from a Terraform of its own.
        const configuration = router.source === 'manager' && details?.configuration
          ? Object.fromEntries(Object.entries(details.configuration).map(([k, v]) => [k, v && typeof v === 'object' ? { ...v, source: 'manager' } : v]))
          : details?.configuration;
        return reply(200, { ...where(router), ...details, ...(configuration ? { configuration } : {}) });
      }
      if (method === 'POST' && (b === 'pause' || b === 'resume') && !action) return pauseRoute(identity, event, router, b);
    }

    // The fleet's estimated savings (R9): the daily job's summary, one read.
    if (method === 'GET' && resource === 'savings' && !a) {
      // A failed read of the discounts never fails the summary (final review 2).
      const settings = fleet?.getSavingsSettings ? await fleet.getSavingsSettings().catch(() => null) : null;
      return reply(200, { summary: (await fleet?.getSavingsSummary?.()) ?? null, settings });
    }
    // The discounts for commitments (R9.5): administrators set them, whole percentages from 0 to 90.
    if (method === 'PUT' && resource === 'savings' && a === 'settings' && !b) {
      need(identity, 'admin');
      if (!fleet?.putSavingsSettings || !fleet.getSavingsSettings) throw new HttpError(404, 'not_found', 'no savings in this manager');
      const body = bodyOf(event);
      const percent = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= DISCOUNT_MAX;
      if (!percent(body.compute) || !percent(body.databases)) throw new HttpError(400, 'bad_request', `compute and databases must be whole percentages from 0 to ${DISCOUNT_MAX}`);
      const discounts = { compute: body.compute as number, databases: body.databases as number };
      return audited(identity, 'savings-discounts', 'savings', async () => {
        await fleet.putSavingsSettings!(discounts, identity.email);
        // Seen at once by this container's figures; others within a minute and their figures' own time.
        discountsKept = { at: now(), value: discounts };
        statesKept.clear();
        // Answered with what was written (final review 5), not a read right after it.
        const settings = { ...discounts, updatedAt: new Date(now()).toISOString(), updatedBy: identity.email };
        return { result: `compute ${discounts.compute}%, databases ${discounts.databases}%`, response: reply(200, { settings }) };
      });
    }

    if (method === 'GET' && resource === 'workloads' && a === 'states' && !b) {
      const { rows } = await listAll(identity);
      return reply(200, await allStates(rows.filter((w) => visible(identity, { account: w.account as string | undefined, region: String(w.region ?? routers.find((r) => r.name === w.router)?.region ?? '') }))));
    }

    if (method === 'GET' && resource === 'workloads' && !a) {
      const q = event.queryStringParameters ?? {};
      const { rows, errors, routerRows } = await listAll(identity);
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
      const listed = matching.slice(start, start + limit);
      // A page's idle hours and requests over 7 days, from each workload's discovery candidate (one per target group, found
      // by its ARN), and its time in each state over 7 days, from its history: when the Workloads view asks.
      const page = q.limit && (q.idle === '1' || q.states === '1') ? await Promise.all(listed.map(async (w) => {
        const router = routers.find((r) => r.name === w.router);
        const [c, states] = await Promise.all([
          q.idle === '1' && discovery && typeof w.targetGroupArn === 'string' ? discovery.store.getCandidate(w.targetGroupArn).catch(() => null) : null,
          q.states === '1' && router ? statesOf(String(w.account ?? accountOfRouter(router)), String(w.region ?? router.region), String(w.workloadId), w) : undefined,
        ]);
        return { ...w, ...(c && typeof c.idleHours7d === 'number' ? { idleHours7d: c.idleHours7d, requests7d: c.requests7d } : {}), ...states };
      })) : listed;
      const cursor = start + limit < matching.length ? Buffer.from(String(start + limit)).toString('base64url') : null;
      return reply(200, { workloads: page, total: matching.length, byState, stats7d, cursor, errors, ...(q.routers === '1' ? { routers: routerRows() } : {}) });
    }

    if (resource === 'workloads' && a && b) {
      const router = routerOf(a, identity);
      const id = workloadId(b);
      // Its state history over the last days (R8), from the manager's store: never the router.
      if (method === 'GET' && action === 'history' && !parts[4]) {
        const days = Number(event.queryStringParameters?.days ?? 7);
        if (!Number.isInteger(days) || days < 1 || days > 31) throw new HttpError(400, 'bad_request', 'days must be a whole number from 1 to 31');
        if (!fleet?.listHistory || !fleet.historyBefore) throw new HttpError(404, 'not_found', 'no state history in this manager');
        const t = now();
        const [from, to] = [new Date(t - days * 86_400_000).toISOString(), new Date(t).toISOString()];
        const account = accountOfRouter(router);
        const { view, before, entries, truncated } = await historyOf(account, router.region, id, from, to, () => fleet.getWorkload(account, router.region, id));
        // The estimate never fails the history (review I4): without it, the card shows the history alone.
        const priced = savings
          ? await discountsOf().then((discounts) => savingsOf(view.phases, { hourly: (item) => savings.hourly(router.region, item, discounts), baseline: savings.baseline })
            .then((r) => ({ ...r, baseline: savings.baseline, ...(anyDiscount(discounts) ? { discounts } : {}) }))).catch(() => undefined)
          : undefined;
        return reply(200, { ...view, before, entries, truncated, ...(priced ? { savings: priced } : {}) });
      }
      // Its idle window advice (R10): its last 14 days of requests replayed against idle windows, priced as its savings;
      // kept a day, or until its idle window changes.
      if (method === 'GET' && action === 'idle-window' && !parts[4]) {
        if (!fleet?.listHistory || !fleet.historyBefore || !idleRequests) throw new HttpError(404, 'not_found', 'no idle window advice in this manager');
        const account = accountOfRouter(router);
        const summary = await fleet.getWorkload(account, router.region, id);
        if (!summary || typeof summary.targetGroupArn !== 'string') throw new HttpError(404, 'not_found', `unknown workload: ${id}`);
        const idle = (summary.settings as { idleMinutes?: unknown } | undefined)?.idleMinutes;
        const current = typeof idle === 'number' && idle > 0 ? idle : DEFAULT_IDLE_MINUTES;
        const kept = await fleet.getIdleWindow?.(account, router.region, id).catch(() => null);
        if (kept && kept.current === current) return reply(200, kept);
        let requests: Awaited<ReturnType<IdleRequests>>;
        try {
          requests = await idleRequests(account, router.region, summary.targetGroupArn, IDLE_DAYS);
        } catch (err) {
          throw new HttpError(502, 'requests_unreadable', (err as Error).message);
        }
        const t = now();
        const [month, period, routerSummary, discounts] = await Promise.all([
          historyOf(account, router.region, id, new Date(t - COSTS_DAYS * DAY_MS).toISOString(), new Date(t).toISOString(), async () => summary),
          historyOf(account, router.region, id, requests.from, requests.to, async () => summary),
          fleet.listRouters().then((all) => all.find((r) => r.account === account && r.region === router.region) ?? null).catch(() => null),
          savings ? discountsOf().catch(() => null) : null,
        ]);
        // What the latest nap stopped, priced as the workload's costs: without prices, the advice is in hours.
        const last = [...month.view.phases].reverse().find((p) => p.state === 'ASLEEP' && p.stopped);
        const advice = await idleWindowAdvice({
          requests, current, checkMinutes: checkMinutesOf(routerSummary?.checkSchedule ?? null), wakeMs: month.view.wakes.medianMs,
          startAsleep: period.view.phases[0]?.state === 'ASLEEP', actualWakes: period.view.wakes.count,
          // The real wakes are compared from when the history knows the period (onboarded during it: later; capped: never).
          actualFrom: period.truncated ? null : period.view.phases.find((p) => p.state !== 'UNKNOWN')?.from ?? null,
          stopped: savings && discounts ? last?.stopped ?? null : null,
          hourly: (item) => (savings && discounts ? savings.hourly(router.region, item, discounts).catch(() => null) : Promise.resolve(null)),
          baseline: savings?.baseline ?? { kind: 'always' }, wakerTargetGroup: requests.wakerTargetGroupArn !== null, now: t,
        });
        await fleet.putIdleWindow?.(account, router.region, id, advice).catch(() => undefined);
        return reply(200, advice);
      }
      if (method === 'GET' && !action) {
        // Its link comes from its summary (the router's status has none): one read, not the whole list.
        const [status, summary] = await Promise.all([
          invoke(router, { action: 'status', workloadId: id }),
          fleet ? fleet.getWorkload(accountOfRouter(router), router.region, id).catch(() => null) : null,
        ]);
        // The bar of its header, as on a Workloads row: its time in each state, and its idle hours from discovery.
        const [states, c] = await Promise.all([
          statesOf(accountOfRouter(router), router.region, id, summary),
          discovery && typeof summary?.targetGroupArn === 'string' ? discovery.store.getCandidate(summary.targetGroupArn).catch(() => null) : null,
        ]);
        return reply(200, {
          // Its account and region: the ARNs of its backends and targets.
          ...(status as object), ...(accountOfRouter(router) ? { account: accountOfRouter(router) } : {}), region: router.region, url: (summary?.url as string | null | undefined) ?? null, ...states,
          ...(c && typeof c.idleHours7d === 'number' ? { idleHours7d: c.idleHours7d, requests7d: c.requests7d } : {}),
        });
      }
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

    if (resource === 'update' && !b) {
      need(identity, 'admin');
      if (method === 'GET' && !a) return reply(200, update ? await update.state() : { installedWithCli: false, version, env: install?.env ?? '', region: install?.region ?? '' });
      if (a === 'check' && (method === 'GET' || method === 'PUT')) {
        if (!fleet?.getUpdateCheck || !fleet.putUpdateCheck || !fleet.getUpdateResult) throw new HttpError(404, 'not_found', 'no update check in this manager');
        // newer: the banner's condition, judged against the version running now (an update since the check, or the check
        // turned off, leaves an old result stale).
        const view = (check: UpdateCheck, result: UpdateResult | null) => ({
          ...check, newer: check.enabled && !!result?.latest && VERSION.test(result.latest) && compareVersions(result.latest, version) > 0, result,
        });
        if (method === 'GET') return reply(200, view(await fleet.getUpdateCheck(), await fleet.getUpdateResult()));
        const body = bodyOf(event);
        if (typeof body.enabled !== 'boolean' || typeof body.alert !== 'boolean') throw new HttpError(400, 'bad_request', 'enabled and alert must be true or false');
        if (body.alert && !body.enabled) throw new HttpError(400, 'bad_request', 'the alert needs the daily check turned on');
        const check = { enabled: body.enabled, alert: body.alert };
        return audited(identity, 'update-check', 'update', async () => {
          await fleet.putUpdateCheck!({ ...check, updatedBy: identity.email });
          // Answered with what was written, as the discounts are.
          const saved = { ...check, updatedAt: new Date(now()).toISOString(), updatedBy: identity.email };
          return { result: [check.enabled ? 'enabled' : 'disabled', ...(check.alert ? ['alert'] : [])].join(', '), response: reply(200, view(saved, await fleet.getUpdateResult!())) };
        });
      }
      if (method === 'GET' && a === 'available') return reply(200, { count: update ? await update.available() : 0 });
      if (update && method === 'GET' && a === 'changes') {
        const to = event.queryStringParameters?.to;
        if (!to) throw new HttpError(400, 'bad_request', 'to is required');
        return reply(200, await update.changes(to));
      }
      if (update && method === 'POST' && a === 'plan') {
        const target = bodyOf(event).version;
        if (typeof target !== 'string') throw new HttpError(400, 'bad_request', 'version is required');
        return audited(identity, 'update-plan', target, async () => {
          const pending = await update.plan(target, identity.email);
          return { result: 'requested', response: reply(202, pending) };
        });
      }
      if (update && method === 'POST' && a === 'apply') {
        const planBuild = bodyOf(event).planBuild;
        if (typeof planBuild !== 'string') throw new HttpError(400, 'bad_request', 'planBuild is required');
        return audited(identity, 'update-apply', planBuild, async () => {
          const pending = await update.apply(planBuild, identity.email);
          return { result: 'requested', response: reply(202, pending), target: pending.version };
        });
      }
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
      if (method === 'POST' && b === 'mfa' && action === 'reset') {
        notSelf();
        return audited(identity, 'mfa-reset', email, async () => {
          const { tokenDeleted } = await users.resetMfa(email);
          return { result: tokenDeleted ? 'reset, authenticator deleted' : 'reset, no authenticator deleted', response: reply(200, { email, mfa: false, tokenDeleted }) };
        });
      }
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

  // A managed candidate's workload, by its name (the id is not for people), with the router the dashboard links to.
  async function withWorkload(c: Candidate) {
    if (!c.workloadId) return c;
    const router = routers.find((r) => accountOfRouter(r) === c.account && r.region === c.region);
    const summary = fleet ? await fleet.getWorkload(c.account, c.region, c.workloadId).catch(() => null) : null;
    if (!router && !summary) return c;
    return { ...c, workload: { router: router?.name ?? summary!.router, workloadId: c.workloadId, name: (summary?.name as string | undefined) ?? c.workloadId } };
  }

  async function discoveryRoute(method: string, sub: string | undefined, identity: Identity, event: ApiEvent, d: DiscoveryApi): Promise<ApiResponse | null> {
    // The last run and the counts per status (scale design §5); the candidates come by page.
    if (method === 'GET' && !sub) {
      await settleExpired(d);
      // The last run that ran (or runs); a Run now refused since (another run was in progress) is given apart, so that it
      // never hides that run and its result.
      const [newest, lastRun, counts] = await Promise.all([d.store.lastRun(), d.store.lastRun({ completed: true }), d.store.getCounts()]);
      const refused = newest?.status === 'skipped' && (!lastRun || newest.startedAt > lastRun.startedAt) ? newest : null;
      return reply(200, { lastRun, ...(refused ? { refused } : {}), counts: counts?.counts ?? lastRun?.counts ?? {}, ...(accessRoles ? { access: { ...accessRoles, source: 'terraform' } } : {}) });
    }
    // Organization access of the last run (packaging design §3): the counts, and the accounts not ready by page.
    if (method === 'GET' && sub === 'access') {
      const q = event.queryStringParameters ?? {};
      const limit = q.limit === undefined ? ACCESS_PAGE : Number(q.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > ACCESS_MAX) throw new HttpError(400, 'bad_request', `limit must be 1 to ${ACCESS_MAX}`);
      const report = await d.store.accessReport({ limit, ...(q.cursor ? { cursor: q.cursor } : {}) });
      // Every account it names, the forwarders' included (R5c review I6).
      const forwarders = report.forwarders && {
        ...report.forwarders,
        impossible: report.forwarders.impossible.filter((f) => sees(identity, f.account, '')),
        failed: (report.forwarders.failed ?? []).filter((f) => sees(identity, f.account, '')),
      };
      return reply(200, {
        ...report, accounts: report.accounts.filter((a) => sees(identity, a.account, '')), ...(forwarders ? { forwarders } : {}),
        ...(report.discoveryOnly ? { discoveryOnly: report.discoveryOnly.filter((account) => sees(identity, account, '')) } : {}),
      });
    }
    if (method === 'GET' && sub === 'candidates') {
      const q = event.queryStringParameters ?? {};
      const status = q.status as Status;
      if (!CANDIDATE_STATUSES.includes(status)) throw new HttpError(400, 'bad_request', `status must be one of ${CANDIDATE_STATUSES.join(', ')}`);
      if ((q.account && !ACCOUNT.test(q.account)) || (q.region && (!q.account || !REGION.test(q.region)))) {
        throw new HttpError(400, 'bad_request', 'account must be 12 digits; a region needs its account');
      }
      const limit = q.limit === undefined ? CANDIDATES_PAGE : Number(q.limit);
      if (!Number.isInteger(limit) || limit < 1) throw new HttpError(400, 'bad_request', 'limit must be a positive integer');
      let page;
      try {
        page = await d.store.pageCandidates({ status, limit: Math.min(limit, CANDIDATES_MAX), ...(q.cursor ? { cursor: q.cursor } : {}), ...(q.account ? { account: q.account } : {}), ...(q.region ? { region: q.region } : {}) });
      } catch (err) {
        if (err instanceof InvalidCursor) throw new HttpError(400, 'bad_request', 'invalid cursor');
        throw err;
      }
      const shown = page.candidates.filter((c) => visible(identity, { account: c.account, region: c.region }));
      // The onboarding or offboarding running on a candidate (the dashboard shows it in progress).
      const running = shown.length ? ((await operations?.list()) ?? []).filter((op) => op.status === 'running' && (op.type === 'onboard' || op.type === 'offboard')) : [];
      const operationOf = (c: Candidate) => {
        const op = running.find((o) => o.target.account === c.account && o.target.region === c.region
          && (o.type === 'onboard' ? o.target.targetGroupArn === c.targetGroupArn : Boolean(c.workloadId) && o.target.workloadId === c.workloadId));
        return op ? { operation: { id: op.id, type: op.type } } : {};
      };
      return reply(200, { candidates: await Promise.all(shown.map(async (c) => ({ ...(await withWorkload(c)), ...operationOf(c) }))), cursor: page.cursor });
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
      const linted = (config: DiscoveryConfig) => lint(withExclusions(config, exclusions, now()), inventory);
      if (method === 'GET') {
        const stored = await d.store.getConfig();
        const config = stored?.config ?? defaultConfig(discoveryMode);
        return reply(200, { config, updatedAt: stored?.updatedAt ?? null, updatedBy: stored?.updatedBy ?? null, lint: linted(config) });
      }
      if (method === 'PUT') {
        need(identity, 'admin');
        const { config, errors } = validateConfig(bodyOf(event));
        if (!config) return reply(400, { error: 'bad_request', message: 'invalid configuration', errors });
        // Event-driven refresh creates roles and rules in the member accounts: audited with its accounts.
        const refresh = config.eventRefresh ? `, event-driven refresh ${config.eventRefresh.enabled ? `on for ${config.eventRefresh.accounts?.join(' ') ?? 'every ready account'}` : 'off'}` : '';
        const summary = `${plural(config.filters.length, 'filter')}, ${plural(config.globalExcludes.length, 'global exclude')}, regions ${config.regions.join(' ')}${refresh}`;
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
      const missing = (ids as string[]).filter((_, i) => !found[i] || !sees(identity, found[i]!.account, found[i]!.region));
      if (missing.length) throw new HttpError(404, 'not_found', `unknown candidates: ${missing.join(', ')}`);
      const at = new Date(now()).toISOString();
      return audited(identity, `discovery-${sub}`, (ids as string[]).join(' '), async () => {
        const updated = (found as Candidate[]).map((c) => {
          const { dismissed: _, ...rest } = c;
          return restatus(sub === 'dismiss' ? { ...rest, dismissed: { by: identity.email, at, ...(note ? { note } : {}) } } : rest, at);
        });
        await d.store.replaceCandidates(updated, found as Candidate[]);
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
    const changed = rescope(candidates, withExclusions(stored?.config ?? defaultConfig(discoveryMode), exclusions, now()), inventory ?? { accounts: [], ous: {} }, now());
    await d.store.replaceCandidates(changed, candidates);
    return changed.length;
  }

  // An expired exclusion no longer applies: the stored candidates are re-scoped once (no run needed), on the next read.
  async function settleExpired(d: DiscoveryApi): Promise<Exclusion[]> {
    const exclusions = await d.store.listExclusions();
    const lapsed = exclusions.filter((e) => e.expiresAt && Date.parse(e.expiresAt) <= now() && !e.lapsedAt);
    if (!lapsed.length) return exclusions;
    // Claimed first, by one caller each (the Discovery view reads /discovery and /exclusions at once): only the caller
    // that marks it lapsed re-scopes, so the counts move once.
    const at = new Date(now()).toISOString();
    const claimed: Exclusion[] = [];
    for (const e of lapsed) {
      let mine = false;
      await d.store.updateExclusion(e.id, (x) => {
        mine = !x.lapsedAt;
        return mine ? { ...x, lapsedAt: at } : x;
      });
      if (mine) claimed.push(e);
    }
    if (claimed.length) await rescoped(d, [...new Set(claimed.map((e) => e.target.account))]);
    return d.store.listExclusions();
  }



  async function exclusionsRoute(method: string, id: string | undefined, identity: Identity, event: ApiEvent, d: DiscoveryApi): Promise<ApiResponse | null> {
    if (method === 'GET' && !id) {
      const all = (await settleExpired(d)).filter((e) => sees(identity, e.target.account, e.target.region));
      const active = new Set(activeExclusions(all, now()).map((e) => e.id));
      // The workloads each one paused, by their names (from their summaries; the id is not for people).
      const named = async (p: NonNullable<Exclusion['paused']>[number]) => {
        const summary = fleet && p.account && p.region ? await fleet.getWorkload(p.account, p.region, p.workloadId).catch(() => null) : null;
        return summary?.name ? { ...p, name: summary.name } : p;
      };
      return reply(200, {
        exclusions: await Promise.all(all.map(async (e) => ({
          ...e, ...(e.paused ? { paused: await Promise.all(e.paused.map(named)) } : {}), expired: !e.liftedAt && !active.has(e.id), lifting: Boolean(e.liftedAt),
        }))),
      });
    }
    if (method === 'POST' && !id) {
      need(identity, 'operator');
      const body = bodyOf(event);
      const inventory = await d.store.getInventory();
      const target = exclusionTarget(body, (account) => inventory?.accounts.find((a) => a.id === account)?.name ?? account);
      if (!sees(identity, target.account, target.region)) throw new HttpError(404, 'not_found', `unknown target: ${targetText(target)}`);
      const reason = reasonIn(body, REASON_MAX - EXCLUDED.length);
      const expiresAt = aheadIn(body, 'expiresAt', now());
      const workload = body.workload as { router?: string; id?: string } | undefined;
      let hint: { id: string } | undefined;
      if (workload !== undefined) {
        const router = routers.find((r) => r.name === workload?.router);
        if (!router || !ID.test(String(workload?.id ?? '')) || target.kind !== 'target-group'
          || (router.account ?? managerAccount) !== target.account || router.region !== target.region) {
          throw new HttpError(400, 'bad_request', 'workload must name a registered router of the target group\'s account and region and a workload id, with a target group exclusion');
        }
        hint = { id: String(workload.id) };
      }
      const exclusion: Exclusion = { id: newId(), target, reason, by: identity.email, at: new Date(now()).toISOString(), ...(expiresAt ? { expiresAt } : {}) };
      if (!operations) throw new HttpError(503, 'unavailable', 'the operations workflow is not configured');
      return audited(identity, 'exclude', targetText(target), async () => {
        // Stored first: the exclusion stands even if a router cannot be reached. The workflow pauses its workloads
        // (scale design §6): the API answers at once, whatever their number.
        await d.store.putExclusion(exclusion);
        // The workflow pauses it in the routers of the target group's account and region (it knows installed routers by
        // another name). Without its operation nothing would pause its workloads: the exclusion is not kept, the caller
        // tries again (an operation that throws never started).
        let op: Operation;
        let candidates: number;
        try {
          candidates = await rescoped(d, [target.account]);
          op = await operations.create('exclude', { exclusionId: exclusion.id, ...(hint ? { hint: { workloadId: hint.id } } : {}) }, identity.email);
        } catch (err) {
          await d.store.deleteExclusion(exclusion.id);
          await rescoped(d, [target.account]).catch(() => 0);
          throw new HttpError(503, 'unavailable', `the operation pausing its workloads could not start (${(err as Error).message}): nothing excluded, try again`);
        }
        const result = [reason, ...(expiresAt ? [`until ${expiresAt}`] : []), `operation ${op.id}`].join('; ');
        return { result, response: reply(202, { exclusion, candidates, operation: op }) };
      });
    }
    if (method === 'DELETE' && id) {
      need(identity, 'operator');
      const exclusion = await d.store.getExclusion(decodeURIComponent(id));
      if (!exclusion || !sees(identity, exclusion.target.account, exclusion.target.region)) throw new HttpError(404, 'not_found', `unknown exclusion: ${id}`);
      if (!operations) throw new HttpError(503, 'unavailable', 'the operations workflow is not configured');
      return audited(identity, 'exclusion-lift', targetText(exclusion.target), async () => {
        // The operation first: one runs per exclusion at a time, and a lift refused meanwhile changes nothing. Then marked
        // lifted (it no longer applies; the operation marks it too); the operation resumes its workloads and deletes it
        // once all are resumed: until then it stays listed, and Lift again retries.
        let op: Operation;
        try {
          op = await operations.create('lift-exclusion', { exclusionId: exclusion.id }, identity.email);
        } catch (err) {
          const conflict = conflictOf(err);
          if (conflict) return conflict;
          throw err;
        }
        const at = new Date(now()).toISOString();
        await d.store.updateExclusion(exclusion.id, (x) => ({ ...x, liftedAt: x.liftedAt ?? at }));
        const candidates = await rescoped(d, [exclusion.target.account]);
        return { result: `${exclusion.reason}; operation ${op.id}`, response: reply(202, { candidates, operation: op }) };
      });
    }
    return null;
  }

  // --- Operations: onboard, offboard, install, upgrade and uninstall routers -------------------------------------------

  const ADMIN_TYPES = new Set(['install-router', 'upgrade-router', 'uninstall-router']);
  // The manager's updates are the administrators' (the Update page's), whatever the perimeter.
  const seesOperation = (identity: Identity, op: Operation) => (op.type === 'update-manager' ? RANK[identity.role] >= RANK.admin : sees(identity, op.target.account, op.target.region));
  async function operationsRoute(method: string, id: string | undefined, identity: Identity, event: ApiEvent, ops: OperationsApi): Promise<ApiResponse | null> {
    if (method === 'GET' && !id) {
      const shown = (await ops.list()).filter((op) => seesOperation(identity, op));
      // The running manager updates follow their requests (the install build does not write the records); as they are when
      // that fails (the next read tries again).
      const operations = update ? await update.refreshOperations(shown).catch((err: Error) => {
        console.error(JSON.stringify({ level: 'error', event: 'UpdateOperationsNotRefreshed', error: err.message }));
        return shown;
      }) : shown;
      return reply(200, { operations });
    }
    if (method === 'GET' && id) {
      const op = await ops.get(decodeURIComponent(id));
      if (!op || !seesOperation(identity, op)) throw new HttpError(404, 'not_found', `unknown operation: ${id}`);
      return reply(200, op);
    }
    if (method !== 'POST' || id) return null;
    const body = bodyOf(event);
    const type = String(body.type ?? '') as WorkflowType;
    if (!['onboard', 'offboard', ...ADMIN_TYPES].includes(type)) throw new HttpError(400, 'bad_request', 'type must be onboard, offboard, install-router, upgrade-router or uninstall-router');
    need(identity, ADMIN_TYPES.has(type) ? 'admin' : 'operator');
    let input: Record<string, unknown>;
    let target: string;
    if (type === 'onboard') {
      const name = nameOf(body.name, { required: false });
      const candidateId = String(body.candidateId ?? '');
      const c = await discovery?.store.getCandidate(candidateId);
      if (!c || !sees(identity, c.account, c.region)) throw new HttpError(400, 'bad_request', `unknown candidate: ${candidateId}`);
      await needCommandRole(c.account);
      if (body.settings !== undefined && (typeof body.settings !== 'object' || body.settings === null || Array.isArray(body.settings))) throw new HttpError(400, 'bad_request', 'settings must be an object');
      if (body.databases !== undefined && !Array.isArray(body.databases)) throw new HttpError(400, 'bad_request', 'databases must be a list');
      settingsOfFailures(body.settings as Record<string, unknown> | undefined);
      input = { candidateId, ...(name ? { name } : {}), settings: body.settings ?? {}, databases: body.databases ?? [] };
      target = name ? `${candidateId} as ${name}` : candidateId;
    } else if (type === 'install-router') {
      const account = String(body.account ?? '');
      const region = String(body.region ?? '');
      if (!ACCOUNT.test(account) || !REGION.test(region)) throw new HttpError(400, 'bad_request', 'account (12 digits) and region required');
      if (!sees(identity, account, region)) throw new HttpError(404, 'not_found', `unknown account or region: ${account}/${region}`);
      await needCommandRole(account);
      input = { account, region };
      target = `${account}/${region}`;
    } else {
      const router = routerOf(String(body.router ?? ''), identity);
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
        const conflict = conflictOf(err);
        if (conflict) return conflict;
        throw err;
      }
    });
  }

  // Refused before an operation starts where the last discovery run found the account's command role missing (packaging
  // design §3); an account never checked is let through (its operation fails as before).
  async function needCommandRole(account: string) {
    const command = (await discovery?.store.getAccountScan(account).catch(() => null))?.access?.command;
    if (command && !command.ok && command.discoveryOnly) {
      throw new HttpError(409, 'no_access', `account ${account} is set up for discovery only (its access has no command role): onboarding and router installs are not possible there`);
    }
    if (command && !command.ok) {
      throw new HttpError(409, 'no_access', `account ${account}: its command role ${accessRoles?.commandRole ?? 'DmtCommandRole'} cannot be assumed (${command.reason}); see the Organization access page`);
    }
  }

  // Another operation holds the same target: 409, with its id.
  function conflictOf(err: unknown): { result: string; response: ApiResponse } | null {
    if ((err as Error).name !== 'Conflict') return null;
    const operationId = (err as { operationId?: string }).operationId;
    return { result: `conflict: ${operationId}`, response: reply(409, { error: 'conflict', message: (err as Error).message, operationId }) };
  }

  return async function handler(event: ApiEvent): Promise<ApiResponse> {
    const method = event.requestContext.http.method;
    const parts = event.rawPath.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    try {
      if (method === 'GET' && parts.length === 1 && parts[0] === 'health') return reply(200, { status: 'ok', version });
      const identity = identityOf(event);
      if (!identity) throw new HttpError(401, 'unauthorized', 'sign in required');
      const isMe = method === 'GET' && parts.length === 1 && parts[0] === 'me';
      await applyMfa(identity, isMe, isMe && event.queryStringParameters?.fresh === '1');
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
