// The accounts an estimate reaches (vision docs/specs/2026-10-10-savings-estimate-design.md §4, decision 4): an
// organization's active accounts when the profile may list them, else its own account only, and why. The profile's own
// account uses its own credentials; the others a role given or supposed (OrganizationAccountAccessRole), assumed when an
// account's turn comes (the sessions last an hour) — a refusal lists the account apart with AWS's reason and the fix.
// Restricted to the accounts given with --accounts: one not reached is listed apart with why; none of them, refused.
// Several profiles (such as one SSO profile per account): each reaches its accounts, merged; an account a profile logs in
// to directly is reached with it, never through another's role; --accounts restricts the merged accounts.
import type { OrgInventory } from '@dormeto/discovery';
import type { Credentials } from '@dormeto/discovery/aws';
import { UsageError } from './options.js';

export interface AccountsPorts {
  whoami(): Promise<string>;
  organization(): Promise<string>;
  inventory(): Promise<OrgInventory>;
  assume(account: string, role: string): Promise<Credentials>;
}
// own: the profile's own account, with its own credentials (credentials() gives null); profile: the profile reaching it.
export interface ReachedAccount { account: string; name: string; credentials: () => Promise<Credentials | null>; own?: true; profile?: string }
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

// unreachable: where the accounts refusing their role are listed, as their turn comes (shared by several profiles).
export async function reachAccounts(ports: AccountsPorts, { role, only = null, now = Date.now, unreachable = [] }: { role: string; only?: string[] | null; now?: () => number; unreachable?: Unreachable[] }): Promise<Reached> {
  const self = await ports.whoami();
  const own = (name: string): ReachedAccount => ({ account: self, name, credentials: async () => null, own: true });
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

// The accounts several profiles reach, merged in their order: an account reached by several, with the profile whose own
// account it is when one is (and the name another knows); the organization when they share one; each profile's why. One
// profile: as reached alone.
export async function reachProfiles(profiles: { profile: string; ports: AccountsPorts }[], { role, only = null, now = Date.now }: { role: string; only?: string[] | null; now?: () => number }): Promise<Reached> {
  const tag = (accounts: ReachedAccount[], profile: string) => accounts.map((a) => ({ ...a, profile }));
  if (profiles.length === 1) {
    const [{ profile, ports }] = profiles as [{ profile: string; ports: AccountsPorts }];
    const reached = await reachAccounts(ports, { role, only, now });
    return { ...reached, accounts: tag(reached.accounts, profile) };
  }
  const unreachable: Unreachable[] = [];
  const each: { profile: string; reached: Reached }[] = [];
  for (const { profile, ports } of profiles) {
    try {
      each.push({ profile, reached: await reachAccounts(ports, { role, now, unreachable }) });
    } catch (err) {
      // Which profile failed, such as an expired SSO session
      (err as Error).message = `${profile}: ${(err as Error).message}`;
      throw err;
    }
  }
  const byId = new Map<string, ReachedAccount>();
  for (const { profile, reached } of each) {
    for (const account of tag(reached.accounts, profile)) {
      const known = byId.get(account.account);
      // A profile that cannot list its organization knows its own account by its id only: another may know its name
      if (!known || (!known.own && account.own)) byId.set(account.account, { ...account, name: account.name === account.account && known ? known.name : account.name });
    }
  }
  const organizations = [...new Set(each.map(({ reached }) => reached.organization).filter((o): o is string => Boolean(o)))];
  const whys = each.filter(({ reached }) => reached.why).map(({ profile, reached }) => `${profile}: ${reached.why}`);
  if (organizations.length > 1) whys.push(`the profiles are in several organizations: ${organizations.join(', ')}`);
  const names = profiles.map((p) => p.profile).join(', ');
  const none = `none of the profiles ${names} reaches it`;
  return restrict({ organization: organizations.length === 1 ? organizations[0]! : null, why: whys.length ? whys.join('; ') : null, accounts: [...byId.values()], unreachable }, only, {
    reason: none, fix: 'add a profile of this account to --profile, or use a profile of the management account, which reaches every account', refusal: () => none,
  });
}
