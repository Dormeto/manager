// One discovery run (spec section 3): lock, due check, organization inventory, accounts and pairs of the perimeter,
// one AssumeRole per account, scans in parallel, candidate statuses, lint, run record.
import { DEFAULT_CONFIG } from './config.js';
import { scanAccounts, targetPairs } from './filters.js';
import { nextCandidates } from './lifecycle.js';
import { lint } from './lint.js';
import { loadInventory, type OrganizationsPort } from './org.js';
import type { DiscoveryStore } from './store.js';
import type { Candidate, DiscoveryConfig, OrgInventory, PairResult, RunRecord, RunTarget, ScannedRule, Status } from './types.js';

const HOUR_MS = 3_600_000;

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
  enabledRegions(credentials: unknown): Promise<string[]>;
  scan(credentials: unknown, where: { account: string; region: string }): Promise<ScannedRule[]>;
  now?: () => number;
  concurrency?: number;
  log?: Logger;
}

const silent: Logger = { info() {}, warn() {}, error() {} };

// Run work on the items with at most `size` running at a time.
async function pool<T>(items: T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  }));
}

const errorText = (err: unknown) => `${(err as Error).name ?? 'Error'}: ${(err as Error).message ?? String(err)}`;

const usesAccountTags = (config: DiscoveryConfig) =>
  [...config.globalExcludes, ...config.filters.flatMap((f) => [...f.include, ...f.exclude])].some((c) => c.accountTags !== undefined);

function singleAccount(id: string): OrgInventory {
  return { accounts: [{ id, name: id, ouPath: [], tags: {} }], ous: {} };
}

export async function runDiscovery(deps: RunDeps, event: { source: 'schedule' | 'manual'; by?: string }): Promise<RunRecord> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? silent;
  const startedAt = new Date(now()).toISOString();
  const base = { startedAt, trigger: event.source, ...(event.by ? { by: event.by } : {}) };
  const record = (rest: Partial<RunRecord> & Pick<RunRecord, 'status'>): RunRecord => ({
    ...base, finishedAt: new Date(now()).toISOString(), targets: [], skipped: [], counts: {}, lint: [], ...rest,
  });
  const config = (await deps.store.getConfig())?.config ?? DEFAULT_CONFIG;

  if (event.source === 'schedule') {
    const last = await deps.store.lastRun({ completed: true });
    // A failed run is retried at the next tick; a successful one waits for the refresh period.
    if (last && last.status !== 'failed' && now() - Date.parse(last.startedAt) < config.refreshHours * HOUR_MS) {
      return record({ status: 'skipped', skippedReason: 'not due' });
    }
  }
  if (!(await deps.store.acquireLock(startedAt))) {
    const skipped = record({ status: 'skipped', skippedReason: 'another run is in progress' });
    if (event.source === 'manual') await deps.store.putRun(skipped);
    return skipped;
  }

  try {
    const run = await scanPerimeter(deps, config, now, log);
    const result = record(run);
    await deps.store.putRun(result);
    log.info('DiscoveryRun', { status: result.status, targets: result.targets.length, counts: result.counts });
    return result;
  } catch (err) {
    const failed = record({ status: 'failed', error: errorText(err) });
    log.error('DiscoveryRunFailed', { error: failed.error });
    await deps.store.putRun(failed);
    return failed;
  } finally {
    await deps.store.releaseLock(startedAt);
  }
}

async function scanPerimeter(deps: RunDeps, config: DiscoveryConfig, now: () => number, log: Logger): Promise<Pick<RunRecord, 'status' | 'targets' | 'skipped' | 'counts' | 'lint'>> {
  const concurrency = deps.concurrency ?? 8;
  const allRegions = config.regions.includes('*');
  const inventory = config.mode === 'organization'
    ? await loadInventory(requireOrganizations(deps), { tags: usesAccountTags(config) })
    : singleAccount(deps.managerAccount);

  // Credentials first, only for the accounts of the perimeter: never for an excluded one.
  const credentials = new Map<string, unknown>();
  const accountErrors = new Map<string, string>();
  const enabled: Record<string, string[]> = {};
  await pool(scanAccounts(config, inventory).filter((p) => p.scan), concurrency, async ({ account }) => {
    try {
      const c = await deps.assumeRole(account);
      credentials.set(account, c);
      if (allRegions) enabled[account] = await deps.enabledRegions(c);
    } catch (err) {
      const denied = (err as Error).name === 'AccessDenied' || /not authorized/i.test((err as Error).message ?? '');
      accountErrors.set(account, denied ? `no access: deploy ${deps.roleName ?? 'DmtDiscoveryRole'} to this account` : `assume role failed: ${errorText(err)}`);
      log.warn('DiscoveryAccountFailed', { account, error: accountErrors.get(account) });
    }
  });

  const pairs = targetPairs(config, inventory, enabled);
  const results: PairResult[] = [];
  for (const p of pairs) {
    const error = accountErrors.get(p.account);
    if (p.scan && error) results.push({ account: p.account, region: p.region, ok: false, error, rules: [], ms: 0 });
  }
  await pool(pairs.filter((p) => p.scan && credentials.has(p.account)), concurrency, async ({ account, region }) => {
    const started = now();
    try {
      const rules = await deps.scan(credentials.get(account), { account, region });
      results.push({ account, region, ok: true, rules, ms: now() - started });
    } catch (err) {
      results.push({ account, region, ok: false, error: errorText(err), rules: [], ms: now() - started });
      log.warn('DiscoveryPairFailed', { account, region, error: errorText(err) });
    }
  });

  const previous = new Map((await deps.store.listCandidates()).map((c) => [c.id, c]));
  // Earlier versions had one candidate per rule: a rule now inside a target group candidate is deleted, not gone.
  const grouped = new Set(results.flatMap((r) => r.rules.flatMap((c) => (c.rules ?? []).filter((x) => x.id !== c.id).map((x) => x.id))));
  const superseded = [...previous.keys()].filter((id) => grouped.has(id));
  for (const id of superseded) previous.delete(id);
  if (superseded.length) {
    await deps.store.deleteCandidates(superseded);
    log.info('DiscoveryCandidatesMerged', { count: superseded.length });
  }
  // With regions ["*"], an account without credentials has no known regions: its candidates' regions count as failed.
  const failedRegions = allRegions ? [...accountErrors.keys()].flatMap((account) => [...new Set([...previous.values()].filter((c) => c.account === account).map((c) => c.region))].map((region) => ({ account, region }))) : [];
  for (const { account, region } of failedRegions) results.push({ account, region, ok: false, error: accountErrors.get(account)!, rules: [], ms: 0 });

  const changed = nextCandidates({ previous, results, inventory, config, now: now() });
  await deps.store.putCandidates(changed);
  await deps.store.putInventory(inventory);

  const merged = new Map<string, Candidate>(previous);
  for (const c of changed) merged.set(c.id, c);
  const counts: Partial<Record<Status, number>> = {};
  for (const c of merged.values()) counts[c.status] = (counts[c.status] ?? 0) + 1;

  // Skipped pairs are summarized per reason: listing them all would not fit an item for a large organization.
  const skippedByReason = new Map<string, { accounts: Set<string>; pairs: number }>();
  for (const p of pairs.filter((p) => !p.scan)) {
    const entry = skippedByReason.get(p.reason) ?? { accounts: new Set<string>(), pairs: 0 };
    entry.accounts.add(p.account);
    entry.pairs += 1;
    skippedByReason.set(p.reason, entry);
  }
  const skipped = [...skippedByReason].map(([reason, e]) => ({ reason, accounts: e.accounts.size, pairs: e.pairs }));

  const targets: RunTarget[] = [
    ...(allRegions ? [...accountErrors].map(([account, error]): RunTarget => ({ account, region: '*', status: 'error', error })) : []),
    ...results.filter((r) => !failedRegions.some((f) => f.account === r.account && f.region === r.region)).map((r): RunTarget => (
      r.ok ? { account: r.account, region: r.region, status: 'ok', ms: r.ms, rules: r.rules.length } : { account: r.account, region: r.region, status: 'error', error: r.error!, ms: r.ms }
    )),
  ].sort((a, b) => a.account.localeCompare(b.account) || a.region.localeCompare(b.region));

  const errors = targets.filter((t) => t.status === 'error').length;
  const status = errors === 0 ? 'ok' : errors === targets.length ? 'failed' : 'partial';
  return { status, targets, skipped, counts, lint: lint(config, inventory, { rules: results.flatMap((r) => r.rules) }) };
}

function requireOrganizations(deps: RunDeps): OrganizationsPort {
  if (!deps.organizations) throw new Error('organization mode needs Organizations access');
  return deps.organizations;
}
