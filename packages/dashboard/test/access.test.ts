import { describe, expect, it } from 'vitest';
import { accessLine, countsLine, forwardersLine, onboardRefusal, PROCEDURE_URL, procedureLink } from '../src/access';

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
  it('says why onboarding is not possible in an account, before trying: discovery only, or the command role missing', () => {
    const report = { counts: { ready: 0, discoveryMissing: 0, commandMissing: 1, unchecked: 0 }, accounts: [row(true, false)], cursor: null, delegation: 'ok' as const, checkedAt: null, discoveryOnly: ['333333333333'] };
    expect(onboardRefusal(report, '333333333333')).toBe('Its account is set up for discovery only (no command role): onboarding is not possible there.');
    expect(onboardRefusal(report, '222222222222')).toBe(`Its account has no command role: ${DENIED}. See Organization access.`);
    expect(onboardRefusal(report, '111111111111')).toBeNull();
    expect(onboardRefusal(null, '222222222222')).toBeNull();
  });

  it('counts the accounts ready, missing a role, set up for discovery only, or not checked yet', () => {
    expect(countsLine({ ready: 3, discoveryMissing: 0, commandMissing: 0, unchecked: 0 })).toBe('3 ready.');
    expect(countsLine({ ready: 3, discoveryMissing: 1, commandMissing: 2, discoveryOnly: 4, unchecked: 1 }))
      .toBe('3 ready, 1 without the discovery role, 2 without the command role, 4 for discovery only, 1 not checked yet.');
  });

  it('counts the forwarders of event-driven refresh, and says where one is not possible and why', () => {
    expect(forwardersLine(undefined)).toBeNull();
    expect(forwardersLine({ connected: 2, connecting: 1, impossible: [] })).toBe('Event-driven refresh: 2 accounts connected, 1 being connected.');
    expect(forwardersLine({ connected: 0, connecting: 0, impossible: [{ account: '222222222222', name: 'shop', reason: 'no command role' }] }))
      .toBe('Event-driven refresh: 0 accounts connected, 1 not possible (refreshed daily).');
    // A connect or disconnect that failed: tried again a day later, its error shown (R5c review I5).
    expect(forwardersLine({ connected: 1, connecting: 0, impossible: [], failed: [{ account: '222222222222', name: 'shop', reason: 'AccessDenied' }] }))
      .toBe('Event-driven refresh: 1 account connected, 1 failed (tried again within a day).');
  });

  it('links to the procedure page (a static page: the panel lists the accounts to set up)', () => {
    expect(procedureLink()).toBe(PROCEDURE_URL);
  });
});
