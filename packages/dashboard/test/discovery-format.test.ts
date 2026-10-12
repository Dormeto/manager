import { describe, expect, it } from 'vitest';
import { STATUSES, idleColor, idleShare, idleText, ruleLines, statusChanges, statusColor, statusHelp, statusLabel, statusTransitions, targetText } from '../src/discovery';

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

  it('names the pending statuses shortly, and tells for each status what it means and how it changes', () => {
    expect(statusLabel('pending-onboarding')).toBe('To onboard');
    expect(statusLabel('pending-offboarding')).toBe('To offboard');
    expect(statusTransitions('pending-onboarding')).toEqual([
      { action: 'Onboard', to: 'Managed' }, { action: 'Dismiss', to: 'Dismissed' }, { action: 'Exclude', to: 'Excluded' },
    ]);
    expect(statusTransitions('managed')).toEqual([{ action: 'Offboard', to: 'To onboard' }, { action: 'Exclude', to: 'To offboard, kept awake until offboarded' }]);
    expect(statusTransitions('dismissed')).toEqual([{ action: 'Restore', to: 'its status again' }]);
    expect(statusChanges('ineligible')).toBe('To onboard at the next discovery run once its reason is fixed.');
    for (const s of STATUSES) {
      expect(statusHelp(s), s).toMatch(/\.$/);
      expect(statusTransitions(s).length + (statusChanges(s) ? 1 : 0), s).toBeGreaterThan(0);
    }
  });

  it('explains the idle share and colors it from red (busy) to green (idle)', () => {
    expect(idleText({ idleHours7d: 154, requests7d: 1234 })).toEqual({
      title: 'Idle 92 % of the last 7 days',
      detail: '154 of 168 hours without any request to its target group (1,234 requests in 7 days).',
    });
    expect(idleText({ idleHours7d: 168, requests7d: 0 }).detail).toBe('168 of 168 hours without any request to its target group (no request in 7 days).');
    expect([idleColor(0), idleColor(84), idleColor(168)]).toEqual(['hsl(0 70% 42%)', 'hsl(60 70% 42%)', 'hsl(120 70% 42%)']);
  });

  it('gives the idle share of the last 7 days', () => {
    expect(idleShare({ idleHours7d: 154 })).toBe('92 %');
    expect(idleShare({ idleHours7d: null })).toBeNull();
  });
});

describe('rules of a candidate', () => {
  it('lists each rule by priority with its listener and conditions', () => {
    const rule = (priority: string, conditions: string) => ({ id: `r${priority}`, listener: 'HTTPS:443', priority, conditions, hosts: [], managed: false });
    expect(ruleLines([rule('10', 'host saas.ligoj.io, path /logout.html'), rule('50', 'host saas.ligoj.io, path *')])).toEqual([
      'priority 10 · HTTPS:443 · host saas.ligoj.io, path /logout.html',
      'priority 50 · HTTPS:443 · host saas.ligoj.io, path *',
    ]);
  });
});
