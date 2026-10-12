// The accounts an estimate reaches (vision docs/specs/2026-10-10-savings-estimate-design.md §4, decision 4): an
// organization's active accounts when the profile may list them, else its own account only, and why. The profile's own
// account uses its own credentials; the others a role given or supposed (OrganizationAccountAccessRole), assumed when an
// account's turn comes (the sessions last an hour) — a refusal lists the account apart with AWS's reason and the fix.
// Restricted to the accounts given with --accounts: one not reached is listed apart with why; none of them, refused.
import type { OrgInventory } from '@dormeto/discovery';
import type { Credentials } from '@dormeto/discovery/aws';
import { UsageError } from './options.js';

export interface AccountsPorts {
  whoami(): Promise<string>;
  organization(): Promise<string>;
  inventory(): Promise<OrgInventory>;
  assume(account: string, role: string): Promise<Credentials>;
}
export interface ReachedAccount { account: string; name: string; credentials: () => Promise<Credentials | null> }
export interface Unreachable { account: string; name: string; reason: string; fix: string }
// listed: the accounts reached before --accounts restricted them.
export interface Reached { organization: string | null; why: string | null; accounts: ReachedAccount[]; unreachable: Unreachable[]; listed: number }

const said = (err: unknown) => `${(err as Error).name}: ${(err as Error).message}`;

// A role's credentials are assumed again this close to their expiry (sessions last an hour; a big organization's run
// lasts longer).
const RENEW_MS = 5 * 60_000;

const EVERY = 'a profile of the management account or of a delegated administrator estimates every account';

// The accounts given among those reached, in their order; the others listed apart (reason, fix), or refused when none is.
function restrict(reached: Omit<Reached, 'listed'>, only: string[] | null | undefined, missing: { reason: string; fix: string; refusal: (ids: string[]) => string }): Reached {
  const listed = reached.accounts.length;
  if (!only) return { ...reached, listed };
  const accounts = reached.accounts.filter((a) => only.includes(a.account));
  const absent = only.filter((id) => !reached.accounts.some((a) => a.account === id));
  if (!accounts.length) throw new UsageError(`--accounts: ${absent.join(', ')}: ${missing.refusal(absent)}`);
  reached.unreachable.push(...absent.map((account) => ({ account, name: '', reason: missing.reason, fix: missing.fix })));
  return { ...reached, accounts, listed };
}

export async function reachAccounts(ports: AccountsPorts, { role, only = null, now = Date.now }: { role: string; only?: string[] | null; now?: () => number }): Promise<Reached> {
  const self = await ports.whoami();
  const unreachable: Unreachable[] = [];
  const own = (name: string): ReachedAccount => ({ account: self, name, credentials: async () => null });
  // Its own account only, and why.
  const alone = (organization: string | null, why: string, reason: string, fix: string) =>
    restrict({ organization, why, accounts: [own(self)], unreachable }, only, { reason, fix, refusal: () => why });
  let organization: string | null;
  try {
    organization = await ports.organization();
  } catch (err) {
    if ((err as Error).name === 'AWSOrganizationsNotInUseException') return alone(null, `not in an organization: only the account ${self} is estimated`, 'not in an organization', 'estimate it with a profile of its own');
    // Not allowed to describe it (a narrow read role): its own account, and why; anything else is the profile's failure.
    if (!/AccessDenied/.test((err as Error).name)) throw err;
    return alone(null, `this profile cannot describe its organization (${said(err)}): only its account ${self} is estimated`, 'this profile cannot describe its organization', EVERY);
  }
  let inventory: OrgInventory;
  try {
    inventory = await ports.inventory();
  } catch (err) {
    return alone(organization, `this profile cannot list the organization's accounts (${said(err)}): only its account ${self} is estimated; ${EVERY}`, 'this profile cannot list the organization\'s accounts', EVERY);
  }
  const accounts = inventory.accounts.map((a): ReachedAccount => {
    if (a.id === self) return own(a.name);
    let assumed: Promise<Credentials> | undefined;
    let until = Infinity;
    let refused = false;
    return {
      account: a.id, name: a.name,
      credentials: () => {
        // Kept until five minutes before they expire; a refusal is said once and kept.
        if (assumed && (refused || now() < until - RENEW_MS)) return assumed;
        assumed = ports.assume(a.id, role).then((c) => {
          until = c.expiration ? new Date(c.expiration).getTime() : Infinity;
          return c;
        }, (err: unknown) => {
          refused = true;
          unreachable.push({ account: a.id, name: a.name, reason: (err as Error).message, fix: `create a role this profile may assume, with read access, and name it with --role (tried ${role})` });
          throw err;
        });
        return assumed;
      },
    };
  });
  return restrict({ organization, why: null, accounts, unreachable }, only, {
    reason: `not an active account of the organization ${organization}`,
    fix: 'check the id given with --accounts: the organization\'s active accounts are estimated',
    refusal: (ids) => `${ids.length === 1 ? 'not an active account' : 'not active accounts'} of the organization ${organization}`,
  });
}
