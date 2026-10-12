import { describe, expect, it } from 'vitest';
import { accessLine, PROCEDURE_URL, procedureLink } from '../src/access';

const DENIED = 'access denied: the role is missing or does not trust the manager';
const row = (discovery: boolean, command: boolean) => ({
  account: '222222222222', name: 'shop',
  discovery: discovery ? { ok: true as const } : { ok: false as const, reason: DENIED },
  command: command ? { ok: true as const } : { ok: false as const, reason: DENIED },
});

describe('organization access', () => {
  it('says which role an account misses, why, and what it stops', () => {
    expect(accessLine(row(false, true))).toBe(`no discovery role (${DENIED}): the account is not scanned`);
    expect(accessLine(row(true, false))).toBe(`no command role (${DENIED}): onboarding and router installs are refused`);
    expect(accessLine(row(false, false))).toBe(`no discovery role, no command role (${DENIED}): the account is not scanned, onboarding and router installs are refused`);
  });
  it('links to the procedure with the accounts to set up, at most 40', () => {
    expect(procedureLink([])).toBe(PROCEDURE_URL);
    expect(procedureLink(['111111111111', '222222222222'])).toBe(`${PROCEDURE_URL}#accounts=111111111111,222222222222`);
    expect(procedureLink(Array.from({ length: 50 }, (_, i) => String(100000000000 + i))).split(',')).toHaveLength(40);
  });
});
