import { describe, expect, it } from 'vitest';
import { STATUSES, idleShare, statusColor, statusLabel, targetText } from '../src/discovery';

describe('discovery format', () => {
  it('has a label and a color for every status, pending ones first', () => {
    expect(STATUSES.slice(0, 2)).toEqual(['pending-onboarding', 'pending-offboarding']);
    expect(STATUSES).toHaveLength(8);
    for (const s of STATUSES) {
      expect(statusLabel(s)).toMatch(/^[A-Z]/);
      expect(statusColor(s)).toMatch(/\w/);
    }
    expect(statusLabel('out-of-scope')).toBe('Out of scope');
    expect(statusColor('pending-offboarding')).toBe('warning');
  });

  it('describes run targets', () => {
    expect(targetText({ account: '121014831971', region: 'eu-west-1', status: 'ok', rules: 6, ms: 812 })).toBe('121014831971 · eu-west-1: 6 rules in 0.8 s');
    expect(targetText({ account: '038606077307', region: 'eu-west-3', status: 'error', error: 'no access: deploy DmtDiscoveryRole to this account' }))
      .toBe('038606077307 · eu-west-3: no access: deploy DmtDiscoveryRole to this account');
    expect(targetText({ account: '532105290256', region: '*', status: 'skipped', reason: 'no filter includes this account' })).toBe('532105290256 · all regions: no filter includes this account');
  });

  it('gives the idle share of the last 7 days', () => {
    expect(idleShare({ idleHours7d: 154 })).toBe('92 %');
    expect(idleShare({ idleHours7d: null })).toBeNull();
  });
});
