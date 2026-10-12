// The accounts an estimate reaches (vision docs/specs/2026-10-10-savings-estimate-design.md §4, decision 4): an
// organization's active accounts when the profile may list them, else its own account only, and why. The profile's own
// account uses its own credentials; the others a role given or supposed (OrganizationAccountAccessRole), assumed when an
// account's turn comes (the sessions last an hour) — a refusal lists the account apart with AWS's reason and the fix.
import type { OrgInventory } from '@dormeto/discovery';
import type { Credentials } from '@dormeto/discovery/aws';

export interface AccountsPorts {
  whoami(): Promise<string>;
  organization(): Promise<string>;
  inventory(): Promise<OrgInventory>;
  assume(account: string, role: string): Promise<Credentials>;
}
export interface ReachedAccount { account: string; name: string; credentials: () => Promise<Credentials | null> }
export interface Unreachable { account: string; name: string; reason: string; fix: string }
export interface Reached { organization: string | null; why: string | null; accounts: ReachedAccount[]; unreachable: Unreachable[] }

const said = (err: unknown) => `${(err as Error).name}: ${(err as Error).message}`;

export async function reachAccounts(ports: AccountsPorts, { role }: { role: string }): Promise<Reached> {
  const self = await ports.whoami();
  const unreachable: Unreachable[] = [];
  const own = (name: string): ReachedAccount => ({ account: self, name, credentials: async () => null });
  let organization: string | null;
  try {
    organization = await ports.organization();
  } catch (err) {
    if ((err as Error).name !== 'AWSOrganizationsNotInUseException') throw err;
    return { organization: null, why: `not in an organization: only the account ${self} is estimated`, accounts: [own(self)], unreachable };
  }
  let inventory: OrgInventory;
  try {
    inventory = await ports.inventory();
  } catch (err) {
    return {
      organization, unreachable, accounts: [own(self)],
      why: `this profile cannot list the organization's accounts (${said(err)}): only its account ${self} is estimated; a profile of the management account or of a delegated administrator estimates every account`,
    };
  }
  const accounts = inventory.accounts.map((a): ReachedAccount => {
    if (a.id === self) return own(a.name);
    let assumed: Promise<Credentials> | undefined;
    return {
      account: a.id, name: a.name,
      credentials: () => (assumed ??= ports.assume(a.id, role).catch((err: unknown) => {
        unreachable.push({ account: a.id, name: a.name, reason: (err as Error).message, fix: `create a role this profile may assume, with read access, and name it with --role (tried ${role})` });
        throw err;
      })),
    };
  });
  return { organization, why: null, accounts, unreachable };
}
