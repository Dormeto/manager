// A discovery run in steps (scale design §5): plan (lock, due check, organization inventory, the accounts of the
// perimeter), one step per account (its role assumed, its regions scanned 8 at a time, the candidates that changed
// written, its result recorded), finalize (accounts that left the perimeter, run record, lint, lock released). Step
// Functions runs the account steps in a Distributed Map; runDiscovery runs the three in process.
import { DEFAULT_CONFIG } from './config.js';
import { withExclusions } from './exclusions.js';
import { scanAccounts, targetPairs } from './filters.js';
import { nextCandidates } from './lifecycle.js';
import { lint, lintCounters, sumCounters, type LintCounters } from './lint.js';
import { loadInventory, type OrganizationsPort } from './org.js';
import type { DiscoveryStore } from './store.js';
import { SYNTHETIC_REGIONS, isSynthetic, syntheticInventory, syntheticRules } from './synthetic.js';
import type { AccessRow, AccessState, AccessSummary, AccountResult, AccountScan, Candidate, Connection, DiscoveryConfig, OrgInventory, PairResult, RunRecord, RunTarget, ScannedRule } from './types.js';

const HOUR_MS = 3_600_000;
// A region without any rule in EMPTY_RUNS successive scans is scanned once every SKIP_RUNS + 1 runs.
const EMPTY_RUNS = 3;
const SKIP_RUNS = 6;
const EMPTY_REASON = 'no load balancer in 3 runs: scanned every 7th run';
const UNFINISHED = 'the account step did not finish (timed out or failed)';
// A run still running after the state machine's time limit (and its lock's) never finishes: it is recorded as failed.
const RUN_LIMIT_MS = 3 * HOUR_MS;

export interface Logger {
  info(event: string, data?: object): void;
  warn(event: string, data?: object): void;
  error(event: string, data?: object): void;
}

export interface RunDeps {
  store: DiscoveryStore;
  organizations?: OrganizationsPort; // organization mode
  managerAccount: string;
  roleName?: string;
  assumeRole(account: string): Promise<unknown>; // credentials for the account's discovery role
  assumeCommand?(account: string): Promise<unknown>; // the account's command role, only to check it (packaging design §3)
  enabledRegions(credentials: unknown): Promise<string[]>;
  // Whether a CloudTrail trail logs the management writes of the region (event refresh, packaging design §5).
  trails?(credentials: unknown, region: string): Promise<boolean>;
  scan(credentials: unknown, where: { account: string; region: string }): Promise<ScannedRule[]>;
  now?: () => number;
  concurrency?: number; // regions of an account scanned at once (8)
  runLimitMs?: number; // a run not finished after this is abandoned (3 hours: the state machine's limit)
  synthetic?: { accounts: number }; // dev only: a synthetic organization added to the real one (acceptance at scale)
  log?: Logger;
}

export interface RunPlan {
  runId: string; // the run's start time
  status: 'planned' | 'skipped' | 'failed';
  trigger: 'schedule' | 'manual';
  by?: string;
  accounts: string[]; // to scan, one step each
  delegation?: 'ok' | 'missing'; // organization mode: the delegation policy answered
  skipped: NonNullable<RunRecord['skipped']>; // accounts not scanned, per reason
  record?: RunRecord; // when skipped or failed
}

const silent: Logger = { info() {}, warn() {}, error() {} };
const iso = (ms: number) => new Date(ms).toISOString();

// Run work on the items with at most `size` running at a time.
async function pool<T>(items: T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  }));
}

const errorText = (err: unknown) => `${(err as Error).name ?? 'Error'}: ${(err as Error).message ?? String(err)}`;
// Organization access (packaging design §3): a refusal means the role (or policy) is absent or does not trust the manager.
const denied = (err: unknown) => /^AccessDenied/.test((err as Error).name ?? '') || /not authorized|permissions to access/i.test((err as Error).message ?? '');
const ACCESS_DENIED = 'access denied: the role is missing or does not trust the manager';
const ORGANIZATION_ACCESS = 'organization access missing: the delegation policy of the management account (see the Organization access page)';
const accessOf = (err: unknown): AccessState => ({ ok: false, reason: denied(err) ? ACCESS_DENIED : errorText(err) });

const usesAccountTags = (config: DiscoveryConfig) =>
  [...config.globalExcludes, ...config.filters.flatMap((f) => [...f.include, ...f.exclude])].some((c) => c.accountTags !== undefined);

function singleAccount(id: string): OrgInventory {
  return { accounts: [{ id, name: id, ouPath: [], tags: {} }], ous: {} };
}

// Manual exclusions act as global excludes (an excluded account is never read).
async function currentConfig(deps: RunDeps, now: () => number): Promise<DiscoveryConfig> {
  return withExclusions((await deps.store.getConfig())?.config ?? DEFAULT_CONFIG, await deps.store.listExclusions(), now());
}

async function inventoryOf(deps: RunDeps, config: DiscoveryConfig): Promise<OrgInventory> {
  const inventory = config.mode === 'organization'
    ? await loadInventory(requireOrganizations(deps), { tags: usesAccountTags(config) })
    : singleAccount(deps.managerAccount);
  if (!deps.synthetic?.accounts) return inventory;
  const synthetic = syntheticInventory(deps.synthetic.accounts, Object.keys(inventory.ous).find((id) => inventory.ous[id]!.parent === null));
  return { accounts: [...inventory.accounts, ...synthetic.accounts], ous: { ...synthetic.ous, ...inventory.ous } };
}

// Reasons, with the accounts and account-regions each one concerns.
function bySkipReason(entries: { account: string; reason: string; pairs: number }[]): NonNullable<RunRecord['skipped']> {
  const out = new Map<string, { accounts: Set<string>; pairs: number }>();
  for (const e of entries) {
    const entry = out.get(e.reason) ?? { accounts: new Set<string>(), pairs: 0 };
    entry.accounts.add(e.account);
    entry.pairs += e.pairs;
    out.set(e.reason, entry);
  }
  return [...out].map(([reason, e]) => ({ reason, accounts: e.accounts.size, pairs: e.pairs }));
}

// A synthetic organization turned off (dev) leaves nothing behind: its candidates and scan states are deleted when a run
// starts, so that the index has caught up by the time the run counts the candidates at its end.
async function deleteSynthetic(deps: RunDeps) {
  for (const scan of (await deps.store.listAccountScans()).filter((x) => x.synthetic)) {
    await deps.store.deleteCandidates(await deps.store.accountCandidates(scan.account));
    await deps.store.deleteAccountScan(scan.account);
  }
}

export async function planRun(deps: RunDeps, event: { source: 'schedule' | 'manual'; by?: string }): Promise<RunPlan> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? silent;
  const runId = iso(now());
  const who = { trigger: event.source, ...(event.by ? { by: event.by } : {}) };
  const record = (rest: Partial<RunRecord> & Pick<RunRecord, 'status'>): RunRecord => ({
    startedAt: runId, ...who, finishedAt: iso(now()), targets: [], skipped: [], counts: {}, lint: [], ...rest,
  });
  const ended = (status: 'skipped' | 'failed', rec: RunRecord): RunPlan => ({ runId, status, ...who, accounts: [], skipped: [], record: rec });
  const config = await currentConfig(deps, now);
  let last = await deps.store.lastRun({ completed: true });
  // A run that never reached its end (state machine timed out or stopped, finalize lost): failed, so retried now.
  if (last?.status === 'running' && now() - Date.parse(last.startedAt) >= (deps.runLimitMs ?? RUN_LIMIT_MS)) {
    last = { ...last, status: 'failed', finishedAt: iso(now()), error: `the run did not finish within ${(deps.runLimitMs ?? RUN_LIMIT_MS) / HOUR_MS} hours` };
    await deps.store.putRun(last);
    log.warn('DiscoveryRunAbandoned', { runId: last.startedAt });
  }

  if (event.source === 'schedule') {
    // A failed run is retried at the next tick; a successful one waits for the refresh period.
    if (last && last.status !== 'failed' && now() - Date.parse(last.startedAt) < config.refreshHours * HOUR_MS) {
      return ended('skipped', record({ status: 'skipped', skippedReason: 'not due' }));
    }
  }
  if (!(await deps.store.acquireLock(runId))) {
    const skipped = record({ status: 'skipped', skippedReason: 'another run is in progress' });
    if (event.source === 'manual') await deps.store.putRun(skipped);
    return ended('skipped', skipped);
  }
  try {
    if (!deps.synthetic?.accounts) await deleteSynthetic(deps);
    let inventory: OrgInventory;
    try {
      inventory = await inventoryOf(deps, config);
    } catch (err) {
      // Without the delegation policy, organization mode cannot list the accounts.
      if (config.mode === 'organization' && denied(err)) throw Object.assign(new Error(ORGANIZATION_ACCESS), { delegation: 'missing' as const });
      throw err;
    }
    const delegation = config.mode === 'organization' ? { delegation: 'ok' as const } : {};
    await deps.store.putInventory(inventory);
    const plans = scanAccounts(config, inventory);
    const pairsOf = config.regions.includes('*') ? 1 : config.regions.length;
    const skipped = bySkipReason(plans.filter((p) => !p.scan).map((p) => ({ account: p.account, reason: p.reason, pairs: pairsOf })));
    const accounts = plans.filter((p) => p.scan).map((p) => p.account);
    await deps.store.putRun(record({ status: 'running', finishedAt: runId, skipped, ...delegation }));
    log.info('DiscoveryPlanned', { runId, accounts: accounts.length });
    return { runId, status: 'planned', ...who, accounts, skipped, ...delegation };
  } catch (err) {
    const missing = (err as { delegation?: 'missing' }).delegation;
    const failed = record({ status: 'failed', error: missing ? ORGANIZATION_ACCESS : errorText(err), ...(missing ? { delegation: missing } : {}) });
    // The Organization access panel says so at once, with the accounts of the last complete run.
    if (missing) {
      const prior = await deps.store.getAccess().catch(() => null);
      await deps.store.putAccess({ counts: { ready: 0, discoveryMissing: 0, commandMissing: 0, unchecked: 0 }, accounts: [], ...prior, delegation: missing, checkedAt: runId })
        .catch((e) => log.warn('AccessNotStored', { error: errorText(e) }));
    }
    log.error('DiscoveryRunFailed', { error: failed.error });
    await deps.store.putRun(failed);
    await deps.store.releaseLock(runId);
    return ended('failed', failed);
  }
}

// Candidates compared without the time they were last seen (the account scan state keeps it per region).
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((k) => k !== 'lastSeenAt' && (value as Record<string, unknown>)[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// One account of a run: its role, its regions (8 at a time, an empty one every 7th run only), the candidates that
// changed written, its result recorded with its scan state. A failed account changes none of its candidates.
// only: a refresh of these regions (forwarded events, packaging design §5): the access checks, the run's result and the
// other regions are kept, and the counts move with the candidates.
export async function scanAccount(deps: RunDeps, { runId, account, only }: { runId: string; account: string; only?: string[] }): Promise<{ account: string; ok: boolean; written: number }> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? silent;
  const at = iso(now());
  const config = await currentConfig(deps, now);
  const inventory = (await deps.store.getInventory()) ?? singleAccount(deps.managerAccount);
  const state = await deps.store.getAccountScan(account);
  const allRegions = config.regions.includes('*');
  const synthetic = isSynthetic(account);

  let credentials: unknown = null;
  let discoveryAccess: AccessState = { ok: true };
  let error: string | undefined;
  let enabled: string[] = [];
  try {
    if (!synthetic) credentials = await deps.assumeRole(account);
    if (allRegions) enabled = synthetic ? SYNTHETIC_REGIONS : await deps.enabledRegions(credentials);
  } catch (err) {
    discoveryAccess = credentials ? { ok: true } : accessOf(err);
    error = denied(err) ? `no access: deploy ${deps.roleName ?? 'DmtDiscoveryRole'} to this account` : `assume role failed: ${errorText(err)}`;
    log.warn('DiscoveryAccountFailed', { account, error });
  }
  // The command role, only assumed: onboarding, router installs and forwarders need it (packaging design §3).
  let access: AccountScan['access'] = only ? state?.access : undefined;
  if (!only && !synthetic && deps.assumeCommand) {
    // A check that does not answer is no verdict: the last one stands (none: the account stays unchecked).
    const command = await deps.assumeCommand(account).then((): AccessState => ({ ok: true }), (err) => ((err as { unavailable?: boolean }).unavailable ? state?.access?.command : accessOf(err)));
    if (command) access = { discovery: discoveryAccess, command, checkedAt: at };
    else log.warn('AccessCheckUnavailable', { account });
  }

  const regions = { ...(state?.regions ?? {}) };
  const results: PairResult[] = [];
  const skipped: { reason: string; pairs: number }[] = [];
  const skip = (reason: string) => {
    const entry = skipped.find((x) => x.reason === reason);
    if (entry) entry.pairs += 1;
    else skipped.push({ reason, pairs: 1 });
  };
  const toScan: string[] = [];
  const own = { accounts: inventory.accounts.filter((a) => a.id === account), ous: inventory.ous };
  const perimeter: string[] = [];
  for (const p of targetPairs(config, own, { [account]: enabled })) {
    if (!p.scan) {
      skip(p.reason);
      continue;
    }
    perimeter.push(p.region);
    if (only) {
      // An event says something changed: scanned even where empty runs were skipping it.
      if (only.includes(p.region) && !error) toScan.push(p.region);
      continue;
    }
    if (error) {
      results.push({ account, region: p.region, ok: false, error, rules: [], ms: 0 });
      continue;
    }
    const prior = regions[p.region];
    if (prior && prior.emptyRuns >= EMPTY_RUNS && (prior.skippedRuns ?? 0) < SKIP_RUNS) {
      regions[p.region] = { ...prior, skippedRuns: (prior.skippedRuns ?? 0) + 1 };
      skip(EMPTY_REASON);
      continue;
    }
    toScan.push(p.region);
  }
  // The trails of the perimeter's regions, where event refresh is on for the account (packaging design §5).
  const refresh = config.eventRefresh;
  if (!only && access && credentials && deps.trails && refresh?.enabled && (!refresh.accounts || refresh.accounts.includes(account))) {
    const trails: Record<string, boolean> = {};
    let trailsError: string | undefined;
    for (const region of perimeter) {
      try {
        trails[region] = await deps.trails(credentials, region);
      } catch (err) {
        trails[region] = false;
        trailsError ??= `cannot read CloudTrail: ${errorText(err)}`;
      }
    }
    access = { ...access, trails, ...(trailsError ? { trailsError } : {}) };
  }

  await pool(toScan, deps.concurrency ?? 8, async (region) => {
    const started = now();
    try {
      const rules = synthetic ? syntheticRules(account, region) : await deps.scan(credentials, { account, region });
      results.push({ account, region, ok: true, rules, ms: now() - started });
      regions[region] = { scannedAt: at, emptyRuns: rules.length ? 0 : (regions[region]?.emptyRuns ?? 0) + 1, skippedRuns: 0 };
    } catch (err) {
      results.push({ account, region, ok: false, error: errorText(err), rules: [], ms: now() - started });
      log.warn('DiscoveryPairFailed', { account, region, error: errorText(err) });
    }
  });

  const stored = new Map((await deps.store.accountCandidates(account)).filter((c) => !only || only.includes(c.region)).map((c) => [c.id, c]));
  const previous = new Map(stored);
  // A rule candidate (earlier versions, or a rule that rejoined a target group) now inside a target group candidate is
  // merged into it: its dismissal, first seen date and history carry over, and it is deleted rather than gone.
  const groupOf = new Map(results.flatMap((r) => r.rules.flatMap((c) => (c.rules ?? []).filter((x) => x.id !== c.id).map((x) => [x.id, c.id] as const))));
  const superseded = [...previous.keys()].filter((id) => groupOf.has(id));
  for (const [group, merged] of Map.groupBy(superseded.map((id) => previous.get(id)!), (c) => groupOf.get(c.id)!)) {
    if (!previous.has(group)) previous.set(group, mergedCandidate(group, merged));
  }
  const supersededCandidates = superseded.map((id) => previous.get(id)!);
  for (const id of superseded) previous.delete(id);
  // With regions ["*"], an account without credentials has no known regions: its candidates' regions count as failed.
  const reported = [...results];
  if (allRegions && error) {
    for (const region of new Set([...previous.values()].map((c) => c.region))) results.push({ account, region, ok: false, error, rules: [], ms: 0 });
  }

  const next = nextCandidates({ previous, results, inventory, config, now: now() });
  const changed = next.filter((c) => {
    const before = stored.get(c.id);
    return !before || canonical(before) !== canonical(c);
  });
  if (only) await deps.store.replaceCandidates(changed, [...stored.values()]);
  else await deps.store.putCandidates(changed);
  if (superseded.length) {
    await deps.store.deleteCandidates(supersededCandidates);
    log.info('DiscoveryCandidatesMerged', { account, count: superseded.length });
  }
  const result: AccountResult = {
    pairs: reported.map((r) => ({ region: r.region, ok: r.ok, ...(r.error ? { error: r.error } : {}), rules: r.rules.length, ms: r.ms })),
    skipped,
    ...(error ? { error } : {}),
    lint: lintCounters(config, inventory, results.flatMap((r) => r.rules)),
    written: changed.length,
  };
  if (only && state) await deps.store.putAccountScan({ ...state, regions });
  else await deps.store.putAccountScan({ account, scannedAt: at, regions, runId, result, ...(synthetic ? { synthetic: true } : {}), ...(access ? { access } : {}) });
  return { account, ok: !error && results.every((r) => r.ok), written: changed.length };
}

// The account-regions forwarded events name (packaging design §5), each rescanned once per batch. While a run is active
// the refresh is skipped (the run covers them); while another refresh holds its lease, or past the batch's time, the
// events are given back (retry: their ids) rather than dropped (R5c review I1, I2). Events of accounts or regions the last
// run did not scan are ignored.
const REFRESH_LEASE = 15 * 60_000; // the discovery Lambda's timeout
const REFRESH_MARGIN = 120_000; // an account's rescan, at most
export async function refreshAccounts(deps: RunDeps, events: { id?: string; account?: unknown; region?: unknown }[], { deadline = Number.POSITIVE_INFINITY }: { deadline?: number } = {}): Promise<{ skipped: boolean; pairs: string[]; retry: string[] }> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? silent;
  const byAccount = new Map<string, { regions: Set<string>; ids: string[] }>();
  for (const e of events) {
    if (typeof e?.account !== 'string' || !/^\d{12}$/.test(e.account) || typeof e.region !== 'string' || !/^[a-z]{2}(-[a-z]+)+-\d{1,2}$/.test(e.region)) continue;
    const entry = byAccount.get(e.account) ?? { regions: new Set<string>(), ids: [] };
    entry.regions.add(e.region);
    if (e.id) entry.ids.push(e.id);
    byAccount.set(e.account, entry);
  }
  const all = [...byAccount.values()].flatMap((e) => e.ids);
  if (await deps.store.runActive()) {
    log.info('DiscoveryRefreshSkipped', { accounts: byAccount.size, reason: 'a run is active: it covers them' });
    return { skipped: true, pairs: [], retry: [] };
  }
  const id = `refresh ${iso(now())} ${Math.random().toString(36).slice(2, 8)}`;
  if (!(await deps.store.acquireRefresh(id, REFRESH_LEASE))) {
    log.info('DiscoveryRefreshDeferred', { accounts: byAccount.size, reason: 'another refresh runs' });
    return { skipped: false, pairs: [], retry: all };
  }
  const pairs: string[] = [];
  const retry: string[] = [];
  try {
    await pool([...byAccount.entries()], 4, async ([account, { regions, ids }]) => {
      if (now() > deadline - REFRESH_MARGIN) {
        retry.push(...ids);
        return;
      }
      try {
        const state = await deps.store.getAccountScan(account);
        // Only the accounts and regions the last run scanned: the perimeter as it is.
        if (!state || state.retiredAt) return;
        const known = [...regions].filter((r) => r in (state.regions ?? {}));
        if (!known.length) return;
        await scanAccount(deps, { runId: state.runId ?? '', account, only: known });
        pairs.push(...known.map((r) => `${account}/${r}`));
      } catch (err) {
        log.warn('DiscoveryRefreshFailed', { account, error: errorText(err) });
        retry.push(...ids);
      }
    });
    log.info('DiscoveryRefresh', { pairs, retried: retry.length });
    return { skipped: false, pairs, retry: retry.sort() };
  } finally {
    await deps.store.releaseRefresh(id);
  }
}

// The connections a run decides (packaging design §5): on, the ready accounts with a trail (all, or those listed),
// connected where they are not yet or in fewer regions; the connected accounts left, unlisted, or all when off.
const CONNECTION_BACKOFF = 24 * 3_600_000;
async function connectionsOf(deps: RunDeps, config: DiscoveryConfig, plan: RunPlan, scans: AccountScan[], inventory: OrgInventory, at: number) {
  const setting = config.eventRefresh;
  const wanted = (account: string) => Boolean(setting?.enabled && (!setting.accounts || setting.accounts.includes(account)));
  const connected = new Map<string, Connection>();
  for (const c of await deps.store.listConnections()) {
    // Gone from the organization: nothing can reach its forwarder any more, and the bus refuses its events (R5c review I5).
    if (!inventory.accounts.some((a) => a.id === c.account)) {
      await deps.store.deleteConnection(c.account);
      (deps.log ?? silent).info('ConnectionForgotten', { account: c.account, reason: 'not in the organization' });
      continue;
    }
    connected.set(c.account, c);
  }
  // A connect or disconnect that failed is not created again for a day (it would fail at every run, unseen).
  const failing = (c: Connection | undefined) => Boolean(c?.failedAt && at - Date.parse(c.failedAt) < CONNECTION_BACKOFF);
  const nameOf = (account: string) => inventory.accounts.find((a) => a.id === account)?.name ?? account;
  const failed = [...connected.values()].filter(failing).map((c) => ({ account: c.account, name: nameOf(c.account), reason: c.lastError ?? 'failed' }));
  const inRun = new Set(plan.accounts);
  const connect: { account: string; regions: string[] }[] = [];
  const impossible: { account: string; name: string; reason: string }[] = [];
  let connectedCount = 0;
  for (const s of [...scans].sort((a, b) => a.account.localeCompare(b.account))) {
    if (s.synthetic || !wanted(s.account)) continue;
    const name = inventory.accounts.find((a) => a.id === s.account)?.name ?? s.account;
    const regions = Object.entries(s.access?.trails ?? {}).filter(([, on]) => on).map(([r]) => r).sort();
    const current = connected.get(s.account);
    if (failing(current)) continue;
    if (!s.access?.command.ok) impossible.push({ account: s.account, name, reason: 'no command role' });
    else if (s.access.trailsError) impossible.push({ account: s.account, name, reason: s.access.trailsError });
    else if (!regions.length) impossible.push({ account: s.account, name, reason: 'no CloudTrail trail logging management events in its regions' });
    else if (!current || current.status === 'connecting' || regions.some((r) => !current.regions.includes(r))) connect.push({ account: s.account, regions: [...new Set([...(current?.regions ?? []), ...regions])].sort() });
    else connectedCount += 1;
  }
  const disconnect = [...connected.values()].filter((c) => (!wanted(c.account) || !inRun.has(c.account)) && !failing(c)).map((c) => c.account).sort();
  return { connections: { connect, disconnect }, forwarders: setting?.enabled || failed.length ? { connected: connectedCount, connecting: connect.length, impossible, ...(failed.length ? { failed } : {}) } : undefined };
}

// Organization access of a run's accounts (packaging design §3): counted, those not ready listed; an account without a
// check in this run (a synthetic one, or a step that did not finish) is unchecked.
function accessSummary(plan: RunPlan, scans: AccountScan[], inventory: OrgInventory, at: string): AccessSummary {
  const byAccount = new Map(scans.filter((s) => s.access).map((s) => [s.account, s.access!]));
  const counts = { ready: 0, discoveryMissing: 0, commandMissing: 0, unchecked: 0 };
  const accounts: AccessRow[] = [];
  for (const account of [...plan.accounts].sort()) {
    const access = byAccount.get(account);
    if (!access) {
      counts.unchecked += 1;
      continue;
    }
    if (access.discovery.ok && access.command.ok) {
      counts.ready += 1;
      continue;
    }
    if (!access.discovery.ok) counts.discoveryMissing += 1;
    if (!access.command.ok) counts.commandMissing += 1;
    accounts.push({ account, name: inventory.accounts.find((a) => a.id === account)?.name ?? account, discovery: access.discovery, command: access.command });
  }
  return { counts, accounts, delegation: plan.delegation ?? null, checkedAt: at };
}

// The end of a run: the candidates of accounts that left the perimeter decided again (once), the run record from the
// account results (an account without one did not finish), the counts from the index, the lint, the lock released.
export async function finalizeRun(deps: RunDeps, plan: RunPlan): Promise<RunRecord> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? silent;
  if (plan.status !== 'planned') return plan.record!;
  const who = { trigger: plan.trigger, ...(plan.by ? { by: plan.by } : {}) };
  try {
    const config = await currentConfig(deps, now);
    const inventory = (await deps.store.getInventory()) ?? singleAccount(deps.managerAccount);
    const scans = await deps.store.listAccountScans();
    const inRun = new Set(plan.accounts);
    for (const left of scans.filter((s) => !inRun.has(s.account) && !s.retiredAt)) {
      const previous = new Map((await deps.store.accountCandidates(left.account)).map((c) => [c.id, c]));
      // A synthetic account the run's start deleted, still on the index: deleted again, never written back.
      if (left.synthetic) {
        await deps.store.deleteCandidates([...previous.values()]);
        await deps.store.deleteAccountScan(left.account);
        continue;
      }
      await deps.store.putCandidates(nextCandidates({ previous, results: [], inventory, config, now: now() }));
      await deps.store.putAccountScan({ ...left, retiredAt: plan.runId });
    }

    const ofRun = (await deps.store.getAccountScans(plan.accounts)).filter((s) => s.runId === plan.runId);
    const results = new Map(ofRun.filter((s) => s.result).map((s) => [s.account, s.result!]));
    const targets: RunTarget[] = [];
    const skippedPairs: { account: string; reason: string; pairs: number }[] = [];
    const counters: LintCounters[] = [];
    let emptyPairs = 0;
    for (const account of plan.accounts) {
      const r = results.get(account);
      if (!r) {
        targets.push({ account, region: '*', status: 'error', error: UNFINISHED });
        continue;
      }
      if (r.error && !r.pairs.length) targets.push({ account, region: '*', status: 'error', error: r.error });
      for (const p of r.pairs) {
        if (!p.ok) targets.push({ account, region: p.region, status: 'error', error: p.error ?? 'failed', ms: p.ms });
        else if (p.rules) targets.push({ account, region: p.region, status: 'ok', ms: p.ms, rules: p.rules });
        else emptyPairs += 1;
      }
      for (const s of r.skipped) skippedPairs.push({ account, ...s });
      counters.push(r.lint);
    }
    targets.sort((a, b) => a.account.localeCompare(b.account) || a.region.localeCompare(b.region));
    const errors = targets.filter((t) => t.status === 'error').length;
    const status = errors === 0 ? 'ok' : errors === targets.length + emptyPairs ? 'failed' : 'partial';
    const skipped = [...plan.skipped, ...bySkipReason(skippedPairs)];
    const { connections, forwarders } = await connectionsOf(deps, config, plan, ofRun, inventory, now());
    const record: RunRecord = {
      startedAt: plan.runId, ...who, finishedAt: iso(now()), status, targets, skipped, emptyPairs,
      counts: await deps.store.countCandidates(), lint: lint(config, inventory, { counters: sumCounters(counters) }),
      ...(plan.delegation ? { delegation: plan.delegation } : {}),
      ...(connections.connect.length || connections.disconnect.length || config.eventRefresh ? { connections } : {}),
    };
    await deps.store.putRun(record);
    await deps.store.putCounts(record.counts);
    await deps.store.putAccess({ ...accessSummary(plan, ofRun, inventory, iso(now())), ...(forwarders ? { forwarders } : {}) });
    log.info('DiscoveryRun', { status, accounts: plan.accounts.length, errors, counts: record.counts });
    return record;
  } catch (err) {
    const failed: RunRecord = { startedAt: plan.runId, ...who, finishedAt: iso(now()), status: 'failed', error: errorText(err), targets: [], skipped: plan.skipped, counts: {}, lint: [] };
    log.error('DiscoveryRunFailed', { error: failed.error });
    await deps.store.putRun(failed);
    return failed;
  } finally {
    await deps.store.releaseLock(plan.runId);
  }
}

// A run whose finalize failed (timed out, crashed): recorded as failed with the error, its lock released.
export async function abandonRun(deps: RunDeps, plan: RunPlan, error: string): Promise<RunRecord> {
  const now = deps.now ?? Date.now;
  const record: RunRecord = {
    startedAt: plan.runId, trigger: plan.trigger, ...(plan.by ? { by: plan.by } : {}), finishedAt: iso(now()), status: 'failed',
    error: `finalize failed: ${error}`, targets: [], skipped: plan.skipped, counts: {}, lint: [],
  };
  try {
    await deps.store.putRun(record);
  } finally {
    await deps.store.releaseLock(plan.runId);
  }
  (deps.log ?? silent).error('DiscoveryRunFailed', { runId: plan.runId, error: record.error });
  return record;
}

// The three steps in process, the accounts one after another.
export async function runDiscovery(deps: RunDeps, event: { source: 'schedule' | 'manual'; by?: string }): Promise<RunRecord> {
  const plan = await planRun(deps, event);
  if (plan.status !== 'planned') return plan.record!;
  for (const account of plan.accounts) await scanAccount(deps, { runId: plan.runId, account });
  return finalizeRun(deps, plan);
}

// The previous record of a target group candidate built from the rule candidates merged into it.
function mergedCandidate(id: string, merged: Candidate[]): Candidate {
  const oldest = [...merged].sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt))[0]!;
  const dismissed = merged.find((c) => c.dismissed)?.dismissed;
  const history = merged.flatMap((c) => c.history).sort((a, b) => a.at.localeCompare(b.at)).slice(-20);
  const { dismissed: _, ...rest } = oldest;
  return { ...rest, id, history, ...(dismissed ? { dismissed } : {}) };
}

function requireOrganizations(deps: RunDeps): OrganizationsPort {
  if (!deps.organizations) throw new Error('organization mode needs Organizations access');
  return deps.organizations;
}

// What the state machine carries after a run: small, whatever the organization (Step Functions' payloads are at most
// 256 KB); the connections are counted, and the operations read their lists from the run record (R5c review I3).
export function runSummary(run: RunRecord) {
  return {
    startedAt: run.startedAt,
    status: run.status,
    ...(run.skippedReason ? { skippedReason: run.skippedReason } : {}),
    ...(run.error ? { error: run.error } : {}),
    counts: run.counts,
    errors: run.targets.filter((t) => t.status === 'error').length,
    connections: { connect: run.connections?.connect.length ?? 0, disconnect: run.connections?.disconnect.length ?? 0 },
  };
}
