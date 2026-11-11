import { describe, expect, it } from 'vitest';
import { accessHelp, accessLine, accessStatus, chipLabel, countsLine, forwardersLine, onboardRefusal, PROCEDURE_URL, procedureLink, type AccessReport } from '../src/access';

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

describe('organization access status', () => {
  const report = (over: Partial<AccessReport> = {}): AccessReport => ({
    counts: { ready: 2, discoveryMissing: 0, commandMissing: 0, unchecked: 0 }, accounts: [], cursor: null, delegation: 'ok',
    checkedAt: '2026-10-07T06:00:00.000Z', forwarders: { connected: 2, connecting: 0, impossible: [] }, ...over,
  });

  it('is ok when every account is ready and no forwarder is impossible or failed', () => {
    expect(accessStatus(report())).toBe('ok');
    expect(accessStatus(report({ forwarders: { connected: 1, connecting: 1, impossible: [] } }))).toBe('ok');
    expect(accessStatus(report({ forwarders: undefined }))).toBe('ok');
  });

  it('needs attention when a role is missing, an account is not checked yet, or a forwarder is not possible or failed', () => {
    expect(accessStatus(report({ counts: { ready: 1, discoveryMissing: 0, commandMissing: 1, unchecked: 0 } }))).toBe('warning');
    expect(accessStatus(report({ counts: { ready: 1, discoveryMissing: 1, commandMissing: 0, unchecked: 0 } }))).toBe('warning');
    expect(accessStatus(report({ counts: { ready: 1, discoveryMissing: 0, commandMissing: 0, unchecked: 1 } }))).toBe('warning');
    expect(accessStatus(report({ forwarders: { connected: 1, connecting: 0, impossible: [{ account: '222222222222', name: 'shop', reason: 'no trail' }] } }))).toBe('warning');
    expect(accessStatus(report({ forwarders: { connected: 1, connecting: 0, impossible: [], failed: [{ account: '222222222222', name: 'shop', reason: 'AccessDenied' }] } }))).toBe('warning');
  });

  it('is an error without the delegation policy', () => {
    expect(accessStatus(report({ delegation: 'missing' }))).toBe('error');
  });

  it('explains the counts and event-driven refresh, on or off', () => {
    const [roles, refresh] = accessHelp(report());
    expect(roles).toContain('2 ready.');
    expect(roles).toMatch(/each discovery run checks them again/);
    expect(refresh).toContain('Event-driven refresh: 2 accounts connected.');
    expect(refresh).toMatch(/within about 5 minutes/);
    expect(accessHelp(report({ forwarders: undefined }))[1]).toMatch(/Event-driven refresh is off/);
  });
});

describe('organization access of a Google Cloud project', () => {
  const COMMAND = 'dormeto gcp connect --project dormeto-dev --profile dormeto --env dev';
  const project = (discovery: boolean, command: boolean) => ({
    account: 'shop-prod', name: 'shop-prod',
    discovery: discovery ? { ok: true as const } : { ok: false as const, reason: `the discovery service account cannot read shop-prod: ${COMMAND}` },
    command: command ? { ok: true as const } : { ok: false as const, reason: `the command service account cannot act in shop-prod: ${COMMAND}` },
  });

  it('shows the verdict\'s reason as the API gives it, which names the connect command, without an AWS role\'s words', () => {
    expect(accessLine(project(false, true))).toBe(`the discovery service account cannot read shop-prod: ${COMMAND}`);
    expect(accessLine(project(true, false))).toBe(`the command service account cannot act in shop-prod: ${COMMAND}`);
    expect(accessLine(project(false, false))).toBe(`the discovery service account cannot read shop-prod: ${COMMAND}; the command service account cannot act in shop-prod: ${COMMAND}`);
  });

  it('names the service accounts, not roles, in its chips and in the counts of a report that lists projects', () => {
    expect([chipLabel(project(false, true), 'discovery'), chipLabel(project(false, true), 'command')]).toEqual(['Discovery account: missing access', 'Command account: has access']);
    expect([chipLabel(row(false, true), 'discovery'), chipLabel(row(false, true), 'command')]).toEqual(['Discovery role: missing', 'Command role: assumed']);
    const counts = { ready: 1, discoveryMissing: 1, commandMissing: 2, unchecked: 0 };
    expect(countsLine(counts, ['gcp'])).toBe('1 ready, 1 without the discovery account, 2 without the command account.');
    expect(countsLine(counts, ['aws', 'gcp'])).toBe('1 ready, 1 without the discovery role or account, 2 without the command role or account.');
    expect(countsLine(counts, ['aws'])).toBe(countsLine(counts));
    const report: AccessReport = { counts, accounts: [project(false, false)], cursor: null, delegation: 'ok', checkedAt: null };
    expect(accessHelp(report)[0]).toContain('1 without the discovery account, 2 without the command account.');
  });

  it('links to the Google Cloud page\'s connection for a project', () => {
    expect(procedureLink('gcp')).toBe('https://dormeto.com/configuration.html#connection');
    expect(procedureLink('aws')).toBe(PROCEDURE_URL);
  });

  it('says why onboarding is not possible in a project before trying', () => {
    const report = { counts: { ready: 0, discoveryMissing: 0, commandMissing: 1, unchecked: 0 }, accounts: [project(true, false)], cursor: null, delegation: 'ok' as const, checkedAt: null };
    expect(onboardRefusal(report, 'shop-prod')).toBe(`Its project cannot be acted in: the command service account cannot act in shop-prod: ${COMMAND}. See Organization access.`);
  });
});
