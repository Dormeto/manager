// Candidate statuses (spec section 5): computed from the scope decision, the eligibility, a dismissal and absence from
// the last successful scan; history of status changes; a failed pair changes nothing.
import { cloudOf, type Cloud } from '@dormeto/fleet/clouds';
import { decide } from './filters.js';
import { isStandalone, type Account, type AnyCandidate, type DiscoveryConfig, type OrgInventory, type PairResult, type Status } from './types.js';

const HISTORY = 20;

// A Google Cloud project out of the perimeter (the review's §6.4): the connection removed (`dormeto gcp disconnect`), or the
// project no longer at the scopes of the connection still there.
export const GOOGLE_DISCONNECTED = 'out of scope: the Google Cloud connection was removed';
const GOOGLE_SCOPES_LEFT = 'out of scope: project no longer at the connection\'s scopes';

type StatusInput = Pick<AnyCandidate, 'scope' | 'scopeReason' | 'eligibility'> & Partial<Pick<AnyCandidate, 'reason' | 'dismissed' | 'goneAt' | 'workloadId' | 'backend' | 'account'>> & { cloud?: Cloud; kind?: string };

// A Google Cloud candidate, by its cloud, or by its project when an earlier build stored it without one.
const onGoogle = (c: Pick<StatusInput, 'account' | 'cloud'>) => c.cloud === 'gcp' || (c.account !== undefined && cloudOf(c.account) === 'gcp');

export function computeStatus(c: StatusInput): { status: Status; statusReason: string } {
  const managed = c.eligibility === 'managed';
  if (c.goneAt) return { status: 'gone', statusReason: managed ? `managed ${c.kind === 'standalone' ? 'resource' : onGoogle(c) ? 'backend service' : 'rule'} not found in the last scan: offboard it` : 'not found in the last scan' };
  if (managed) {
    // Without the Google Cloud connection the manager can't offboard: the workload stays on its router, run by the CLI.
    if (c.scope === 'out' && c.scopeReason === GOOGLE_DISCONNECTED) return { status: 'out-of-scope', statusReason: c.scopeReason };
    if (c.scope !== 'in') return { status: 'pending-offboarding', statusReason: c.scopeReason };
    // A managed rule with an eligibility issue (its action or target group changed) waits for offboarding too.
    if (c.reason) return { status: 'pending-offboarding', statusReason: `ineligible: ${c.reason}` };
    // The dashboard shows the workload's name (the id is not for people).
    return { status: 'managed', statusReason: 'managed' };
  }
  if (c.dismissed) return { status: 'dismissed', statusReason: `dismissed by ${c.dismissed.by}${c.dismissed.note ? `: ${c.dismissed.note}` : ''}` };
  if (c.scope === 'excluded') return { status: 'excluded', statusReason: c.scopeReason };
  if (c.scope === 'out') return { status: 'out-of-scope', statusReason: c.scopeReason };
  if (c.eligibility === 'ineligible') return { status: 'ineligible', statusReason: c.reason ?? 'ineligible' };
  return { status: 'pending-onboarding', statusReason: 'eligible' };
}

// Status, reason and history from the previous version of the candidate.
type Unsettled = AnyCandidate extends infer C ? C extends AnyCandidate ? Omit<C, 'status' | 'statusReason' | 'history'> : never : never;
function settle(next: Unsettled, previous: AnyCandidate | undefined, at: string): AnyCandidate {
  const { status, statusReason } = computeStatus(next);
  const history = previous?.history ?? [];
  const changed = !previous || previous.status !== status || previous.statusReason !== statusReason;
  return { ...next, status, statusReason, history: changed ? [...history, { at, status, reason: statusReason }].slice(-HISTORY) : history } as AnyCandidate;
}

// A candidate that no scan can reach any more: its account left the organization (or the account mode), its project the
// connection's scopes (or the connection was removed), or its region left an explicit region list. Without this, it would
// keep its last status forever.
function outsidePerimeter(c: AnyCandidate, accounts: Map<string, Account>, config: DiscoveryConfig, inventory: OrgInventory): { scope: 'out'; reason: string } | null {
  if (!accounts.has(c.account) && onGoogle(c)) return { scope: 'out', reason: inventory.google?.connected === false ? GOOGLE_DISCONNECTED : GOOGLE_SCOPES_LEFT };
  if (!accounts.has(c.account)) return { scope: 'out', reason: `out of scope: ${config.mode === 'account' ? 'not the account of the account mode' : 'account no longer in the organization'}` };
  if (!config.regions.includes('*') && !config.regions.includes(c.region)) return { scope: 'out', reason: `out of scope: region ${c.region} is no longer in the perimeter` };
  return null;
}

const differs = (a: AnyCandidate, b: AnyCandidate) => a.status !== b.status || a.statusReason !== b.statusReason || a.scope !== b.scope || a.scopeReason !== b.scopeReason;
const pairKey = (account: string, region: string) => `${account}/${region}`;

// C: the kind of candidates the caller holds (HTTP only, or both).
export function nextCandidates<C extends AnyCandidate = AnyCandidate>({ previous, results, inventory, config, now }: {
  previous: Map<string, C>;
  results: PairResult[];
  inventory: OrgInventory;
  config: DiscoveryConfig;
  now: number;
}): C[] {
  const at = new Date(now).toISOString();
  const accounts = new Map(inventory.accounts.map((a) => [a.id, a]));
  const accountOf = (id: string, fallback?: AnyCandidate): Account => accounts.get(id) ?? { id, name: fallback?.accountName ?? id, ouPath: fallback?.ouPath ?? [], tags: {} };
  const attempted = new Set(results.map((r) => pairKey(r.account, r.region)));
  const out: AnyCandidate[] = [];
  const seen = new Set<string>();

  for (const result of results.filter((r) => r.ok)) {
    for (const rule of result.rules) {
      seen.add(rule.id);
      const prev = previous.get(rule.id);
      const account = accountOf(rule.account, prev);
      const decision = decide(config, account, rule, inventory);
      const { goneAt: _gone, ...kept } = prev ?? ({} as Partial<AnyCandidate>);
      out.push(settle({
        ...rule as Unsettled,
        accountName: account.name,
        ouPath: account.ouPath,
        scope: decision.scope,
        scopeReason: decision.reason,
        firstSeenAt: kept.firstSeenAt ?? at,
        lastSeenAt: at,
        ...(kept.dismissed ? { dismissed: kept.dismissed } : {}),
      }, prev, at));
    }
  }

  const succeeded = new Set(results.filter((r) => r.ok).map((r) => pairKey(r.account, r.region)));
  // The kinds a standalone scan could not read, by pair: their stored candidates stay as they were.
  const unread = new Map(results.filter((r) => r.ok && r.unread?.length).map((r) => [pairKey(r.account, r.region), r.unread!]));
  for (const prev of (previous as Map<string, AnyCandidate>).values()) {
    if (seen.has(prev.id)) continue;
    const key = pairKey(prev.account, prev.region);
    if (isStandalone(prev) && unread.get(key)?.includes(prev.backend.kind)) continue;
    // The standalone scan turned off looks for none: decided again (out of scope), never gone.
    if (succeeded.has(key) && !(isStandalone(prev) && config.standalone !== 'on')) {
      // Scanned without it: deleted (or no longer an application load balancer rule).
      if (prev.goneAt) continue;
      const { status: _s, statusReason: _r, history: _h, ...rest } = prev;
      out.push(settle({ ...rest, goneAt: at }, prev, at));
    } else if (!attempted.has(key) || succeeded.has(key)) {
      // Not scanned at all (perimeter change), or a standalone candidate while the standalone scan is off: decide again
      // from what the last scan saw.
      const account = accountOf(prev.account, prev);
      const decision = outsidePerimeter(prev, accounts, config, inventory) ?? decide(config, account, prev, inventory);
      const { status: _s, statusReason: _r, history: _h, ...rest } = prev;
      const next = settle({ ...rest, scope: decision.scope, scopeReason: decision.reason }, prev, at);
      if (differs(next, prev)) out.push(next);
    }
    // Attempted and failed: unchanged.
  }
  return out as C[];
}

// Stored candidates decided again without a scan (an exclusion created or lifted): the changed ones, with history.
export function rescope<C extends AnyCandidate>(candidates: C[], config: DiscoveryConfig, inventory: OrgInventory, now: number): C[] {
  const at = new Date(now).toISOString();
  const accounts = new Map(inventory.accounts.map((a) => [a.id, a]));
  return (candidates as AnyCandidate[]).flatMap((c) => {
    const account = accounts.get(c.account) ?? { id: c.account, name: c.accountName, ouPath: c.ouPath, tags: {} };
    const decision = outsidePerimeter(c, accounts, config, inventory) ?? decide(config, account, c, inventory);
    const { status: _s, statusReason: _r, history: _h, ...rest } = c;
    const next = settle({ ...rest, scope: decision.scope, scopeReason: decision.reason }, c, at);
    return differs(next, c) ? [next as C] : [];
  });
}

// A stored candidate whose dismissal changed (API dismiss and restore): status and history again, no scan needed.
export function restatus<C extends AnyCandidate>(candidate: Omit<C, 'dismissed'> & { dismissed?: C['dismissed'] }, at: string): C {
  const { status: _s, statusReason: _r, history: _h, ...rest } = candidate;
  return settle(rest as unknown as Unsettled, candidate as unknown as AnyCandidate, at) as C;
}
