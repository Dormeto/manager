import { describe, expect, it } from 'vitest';
import { accessLine, forwardersLine, PROCEDURE_URL, procedureLink } from '../src/access';

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
  it('counts the forwarders of event-driven refresh, and says where one is not possible and why', () => {
    expect(forwardersLine(undefined)).toBeNull();
    expect(forwardersLine({ connected: 2, connecting: 1, impossible: [] })).toBe('Event-driven refresh: 2 accounts connected, 1 being connected.');
    expect(forwardersLine({ connected: 0, connecting: 0, impossible: [{ account: '222222222222', name: 'shop', reason: 'no command role' }] }))
      .toBe('Event-driven refresh: 0 accounts connected, 1 not possible (refreshed daily).');
  });

  it('links to the procedure page (a static page: the panel lists the accounts to set up)', () => {
    expect(procedureLink()).toBe(PROCEDURE_URL);
  });
});
