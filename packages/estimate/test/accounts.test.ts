// The accounts an estimate reaches (spec §4, decision 4): an organization's active accounts, the profile's own with its
// own credentials, the others through a role given or supposed, assumed when an account's turn comes.
import { describe, expect, it } from 'vitest';
import { reachAccounts, type AccountsPorts } from '../src/accounts.js';

const SELF = '111111111111';
const CREDS = { accessKeyId: 'AKIA', secretAccessKey: 's', sessionToken: 't' };
const named = (id: string, name: string) => ({ id, name, ouPath: ['r-root'], tags: {} });
const awsError = (name: string, message: string) => Object.assign(new Error(message), { name });

function ports({ organization = 'o-abc123' as string | Error, inventory = [named(SELF, 'management'), named('222222222222', 'prod'), named('333333333333', 'staging')] as ReturnType<typeof named>[] | Error, refuse = new Set<string>(), expiration = undefined as (() => Date) | undefined } = {}) {
  const assumed: [string, string][] = [];
  const p: AccountsPorts = {
    whoami: async () => SELF,
    organization: async () => { if (organization instanceof Error) throw organization; return organization; },
    inventory: async () => { if (inventory instanceof Error) throw inventory; return { accounts: inventory, ous: {} }; },
    assume: async (account, role) => {
      assumed.push([account, role]);
      if (refuse.has(account)) throw awsError('AccessDenied', `User: arn:aws:iam::${SELF}:user/me is not authorized to perform: sts:AssumeRole on resource: arn:aws:iam::${account}:role/${role}`);
      return expiration ? { ...CREDS, expiration: expiration() } : CREDS;
    },
  };
  return { p, assumed };
}

describe('the accounts an estimate reaches', () => {
  it('an organization: its active accounts, the profile\'s own with its own credentials, the others when their turn comes', async () => {
    const { p, assumed } = ports();
    const reached = await reachAccounts(p, { role: 'OrganizationAccountAccessRole' });
    expect(reached).toMatchObject({ organization: 'o-abc123', why: null, unreachable: [] });
    expect(reached.accounts.map((a) => [a.account, a.name])).toEqual([[SELF, 'management'], ['222222222222', 'prod'], ['333333333333', 'staging']]);
    // Nothing assumed until an account's turn; the management account never.
    expect(assumed).toEqual([]);
    expect(await reached.accounts[0]!.credentials()).toBeNull();
    expect(await reached.accounts[1]!.credentials()).toEqual(CREDS);
    await reached.accounts[1]!.credentials();
    expect(assumed).toEqual([['222222222222', 'OrganizationAccountAccessRole']]);
  });

  it('a profile that cannot list the organization: its own account only, and why', async () => {
    const { p } = ports({ inventory: awsError('AccessDeniedException', 'You don\'t have permissions to access this resource.') });
    const reached = await reachAccounts(p, { role: 'OrganizationAccountAccessRole' });
    expect(reached.accounts.map((a) => a.account)).toEqual([SELF]);
    expect(reached.organization).toBe('o-abc123');
    expect(reached.why).toBe(`this profile cannot list the organization's accounts (AccessDeniedException: You don't have permissions to access this resource.): only its account ${SELF} is estimated; a profile of the management account or of a delegated administrator estimates every account`);
  });

  it('an account outside any organization: its own account only', async () => {
    const { p } = ports({ organization: awsError('AWSOrganizationsNotInUseException', 'Your account is not a member of an organization.') });
    const reached = await reachAccounts(p, { role: 'OrganizationAccountAccessRole' });
    expect(reached).toMatchObject({ organization: null, why: `not in an organization: only the account ${SELF} is estimated` });
    expect(reached.accounts.map((a) => a.account)).toEqual([SELF]);
  });

  it('a profile that may not describe its organization: its own account only, and why', async () => {
    const { p } = ports({ organization: awsError('AccessDeniedException', 'You are not authorized to perform: organizations:DescribeOrganization') });
    const reached = await reachAccounts(p, { role: 'OrganizationAccountAccessRole' });
    expect(reached).toMatchObject({ organization: null, why: `this profile cannot describe its organization (AccessDeniedException: You are not authorized to perform: organizations:DescribeOrganization): only its account ${SELF} is estimated` });
    expect(reached.accounts.map((a) => a.account)).toEqual([SELF]);
  });

  it('a role\'s credentials are assumed again when they are about to expire (sessions last an hour)', async () => {
    let t = Date.parse('2026-10-10T12:00:00.000Z');
    const { p, assumed } = ports({ expiration: () => new Date(t + 3_600_000) });
    const reached = await reachAccounts(p, { role: 'OrganizationAccountAccessRole', now: () => t });
    await reached.accounts[1]!.credentials();
    t += 30 * 60_000;
    await reached.accounts[1]!.credentials();
    expect(assumed).toHaveLength(1);
    // Five minutes from expiring: assumed again.
    t += 26 * 60_000;
    await reached.accounts[1]!.credentials();
    expect(assumed).toHaveLength(2);
  });

  it('a role that cannot be assumed: the account is listed apart, with AWS\'s reason and the fix', async () => {
    const { p } = ports({ refuse: new Set(['333333333333']) });
    const reached = await reachAccounts(p, { role: 'OrganizationAccountAccessRole' });
    await expect(reached.accounts[2]!.credentials()).rejects.toThrow('not authorized to perform: sts:AssumeRole');
    expect(reached.unreachable).toEqual([{
      account: '333333333333', name: 'staging',
      reason: `User: arn:aws:iam::${SELF}:user/me is not authorized to perform: sts:AssumeRole on resource: arn:aws:iam::333333333333:role/OrganizationAccountAccessRole`,
      fix: 'create a role this profile may assume, with read access, and name it with --role (tried OrganizationAccountAccessRole)',
    }]);
    // Asked again, the same refusal, said once.
    await expect(reached.accounts[2]!.credentials()).rejects.toThrow();
    expect(reached.unreachable).toHaveLength(1);
  });
});
