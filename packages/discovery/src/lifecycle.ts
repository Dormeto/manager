// Candidate statuses (spec section 5): computed from the scope decision, the eligibility, a dismissal and absence from
// the last successful scan; history of status changes; a failed pair changes nothing.
import { decide } from './filters.js';
import type { Account, Candidate, DiscoveryConfig, OrgInventory, PairResult, Status } from './types.js';

const HISTORY = 20;

type StatusInput = Pick<Candidate, 'scope' | 'scopeReason' | 'eligibility'> & Partial<Pick<Candidate, 'reason' | 'dismissed' | 'goneAt' | 'workloadId' | 'backend'>>;

export function computeStatus(c: StatusInput): { status: Status; statusReason: string } {
  const managed = c.eligibility === 'managed';
  if (c.goneAt) return { status: 'gone', statusReason: managed ? 'managed rule not found in the last scan: offboard it' : 'not found in the last scan' };
  if (managed) {
    if (c.scope !== 'in') return { status: 'pending-offboarding', statusReason: c.scopeReason };
    // A managed rule with an eligibility issue (its action or target group changed) waits for offboarding too.
    if (c.reason) return { status: 'pending-offboarding', statusReason: `ineligible: ${c.reason}` };
    return { status: 'managed', statusReason: `managed as workload ${c.workloadId ?? '?'}` };
  }
  if (c.dismissed) return { status: 'dismissed', statusReason: `dismissed by ${c.dismissed.by}${c.dismissed.note ? `: ${c.dismissed.note}` : ''}` };
  if (c.scope === 'excluded') return { status: 'excluded', statusReason: c.scopeReason };
  if (c.scope === 'out') return { status: 'out-of-scope', statusReason: c.scopeReason };
  if (c.eligibility === 'ineligible') return { status: 'ineligible', statusReason: c.reason ?? 'ineligible' };
  return { status: 'pending-onboarding', statusReason: c.backend ? `eligible: ${c.backend.kind} ${c.backend.id}` : 'eligible' };
}

// Status, reason and history from the previous version of the candidate.
function settle(next: Omit<Candidate, 'status' | 'statusReason' | 'history'>, previous: Candidate | undefined, at: string): Candidate {
  const { status, statusReason } = computeStatus(next);
  const history = previous?.history ?? [];
  const changed = !previous || previous.status !== status || previous.statusReason !== statusReason;
  return { ...next, status, statusReason, history: changed ? [...history, { at, status, reason: statusReason }].slice(-HISTORY) : history };
}

// A candidate that no scan can reach any more: its account left the organization (or the account mode), or its region left
// an explicit region list. Without this, it would keep its last status forever.
function outsidePerimeter(c: Candidate, accounts: Map<string, Account>, config: DiscoveryConfig): { scope: 'out'; reason: string } | null {
  if (!accounts.has(c.account)) return { scope: 'out', reason: `out of scope: ${config.mode === 'account' ? 'not the account of the account mode' : 'account no longer in the organization'}` };
  if (!config.regions.includes('*') && !config.regions.includes(c.region)) return { scope: 'out', reason: `out of scope: region ${c.region} is no longer in the perimeter` };
  return null;
}

const differs = (a: Candidate, b: Candidate) => a.status !== b.status || a.statusReason !== b.statusReason || a.scope !== b.scope || a.scopeReason !== b.scopeReason;
const pairKey = (account: string, region: string) => `${account}/${region}`;

export function nextCandidates({ previous, results, inventory, config, now }: {
  previous: Map<string, Candidate>;
  results: PairResult[];
  inventory: OrgInventory;
  config: DiscoveryConfig;
  now: number;
}): Candidate[] {
  const at = new Date(now).toISOString();
  const accounts = new Map(inventory.accounts.map((a) => [a.id, a]));
  const accountOf = (id: string, fallback?: Candidate): Account => accounts.get(id) ?? { id, name: fallback?.accountName ?? id, ouPath: fallback?.ouPath ?? [], tags: {} };
  const attempted = new Set(results.map((r) => pairKey(r.account, r.region)));
  const out: Candidate[] = [];
  const seen = new Set<string>();

  for (const result of results.filter((r) => r.ok)) {
    for (const rule of result.rules) {
      seen.add(rule.id);
      const prev = previous.get(rule.id);
      const account = accountOf(rule.account, prev);
      const decision = decide(config, account, rule, inventory);
      const { goneAt: _gone, ...kept } = prev ?? ({} as Partial<Candidate>);
      out.push(settle({
        ...rule,
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
  for (const prev of previous.values()) {
    if (seen.has(prev.id)) continue;
    const key = pairKey(prev.account, prev.region);
    if (succeeded.has(key)) {
      // Scanned without it: deleted (or no longer an application load balancer rule).
      if (prev.goneAt) continue;
      const { status: _s, statusReason: _r, history: _h, ...rest } = prev;
      out.push(settle({ ...rest, goneAt: at }, prev, at));
    } else if (!attempted.has(key)) {
      // Not scanned at all (perimeter change): decide again from what the last scan saw.
      const account = accountOf(prev.account, prev);
      const decision = outsidePerimeter(prev, accounts, config) ?? decide(config, account, prev, inventory);
      const { status: _s, statusReason: _r, history: _h, ...rest } = prev;
      const next = settle({ ...rest, scope: decision.scope, scopeReason: decision.reason }, prev, at);
      if (differs(next, prev)) out.push(next);
    }
    // Attempted and failed: unchanged.
  }
  return out;
}

// A stored candidate whose dismissal changed (API dismiss and restore): status and history again, no scan needed.
export function restatus(candidate: Omit<Candidate, 'dismissed'> & { dismissed?: Candidate['dismissed'] }, at: string): Candidate {
  const { status: _s, statusReason: _r, history: _h, ...rest } = candidate;
  return settle(rest, candidate as Candidate, at);
}
