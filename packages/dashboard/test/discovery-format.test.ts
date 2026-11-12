import { describe, expect, it } from 'vitest';
import { BACKEND_KINDS, DIMENSIONS, STATUSES, visibleStatuses, cursorPages, readCursor, firstStatus, latestOnly, idleColor, idleShare, idleText, ruleLines, statusChanges, statusColor, statusHelp, statusLabel, statusTransitions, targetText } from '../src/discovery';

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

describe('Discovery view paging', () => {
  it('starts with the first status people act on that has candidates', () => {
    expect(firstStatus({ ineligible: 3, 'pending-offboarding': 1 })).toBe('pending-offboarding');
    expect(firstStatus({ 'pending-onboarding': 2, ineligible: 3 })).toBe('pending-onboarding');
    expect(firstStatus({})).toBe('pending-onboarding');
  });

  it('keeps the answer of the last request only: an earlier one arriving later is dropped', async () => {
    const latest = latestOnly();
    let release!: (v: string) => void;
    const slow = latest(() => new Promise<string>((r) => { release = r; }));
    const fast = latest(async () => 'second');
    expect(await fast).toEqual({ value: 'second' });
    release('first');
    expect(await slow).toBeNull();
  });

  it('pages with cursors: forward from each page\'s cursor, back to any page seen', () => {
    const pages = cursorPages();
    expect([pages.cursor(0), pages.hasNext(0)]).toEqual([null, false]);
    pages.loaded(0, 'c1');
    pages.loaded(1, 'c2');
    expect([pages.cursor(1), pages.cursor(2), pages.hasNext(1), pages.hasNext(2)]).toEqual(['c1', 'c2', true, false]);
    // Page 1 again, now the last one (a candidate moved): page 2 is forgotten.
    pages.loaded(1, null);
    expect([pages.hasNext(1), pages.cursor(2)]).toEqual([false, null]);
    pages.reset();
    expect([pages.cursor(1), pages.hasNext(0)]).toEqual([null, false]);
  });

  // An export or a search reads a list by its cursor (tables design §5): bounded, one page at a time.
  it('reads a list by its cursor one page at a time: to its end, to a limit, to a cursor given twice, or to ceil(limit / page) + 25 requests', async () => {
    let inFlight = 0;
    let most = 0;
    const asked: (string | null)[] = [];
    const list = (pages: { rows: number[]; cursor: string | null }[]) => async (cursor: string | null) => {
      asked.push(cursor);
      inFlight += 1;
      most = Math.max(most, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return pages[cursor === null ? 0 : Number(cursor)]!;
    };
    // To its end.
    expect(await readCursor(list([{ rows: [1, 2], cursor: '1' }, { rows: [], cursor: '2' }, { rows: [3], cursor: null }]), 10, 2)).toEqual({ rows: [1, 2, 3], requests: 3, end: 'list' });
    expect([asked, most]).toEqual([[null, '1', '2'], 1]);
    // To the limit: the rows beyond it dropped.
    expect(await readCursor(list([{ rows: [1, 2], cursor: '1' }, { rows: [3, 4], cursor: '2' }, { rows: [5], cursor: null }]), 3, 2)).toEqual({ rows: [1, 2, 3], requests: 2, end: 'limit' });
    // A cursor given twice.
    expect(await readCursor(async (cursor) => ({ rows: cursor ? [] : [1], cursor: 'again' }), 10, 2)).toEqual({ rows: [1], requests: 2, end: 'cursor' });
    // Pages empty without end: ceil(10 / 2) + 25 = 30 requests.
    let n = 0;
    expect(await readCursor(async () => ({ rows: [], cursor: String(++n) }), 10, 2)).toEqual({ rows: [], requests: 30, end: 'requests' });
  });

});

describe('Discovery status filters', () => {
  it('lists the statuses that have candidates, in their order, and the one shown even when it has none', () => {
    expect(visibleStatuses({ 'pending-onboarding': 1, managed: 6, ineligible: 6, gone: 10, dismissed: 0 }, 'pending-onboarding'))
      .toEqual(['pending-onboarding', 'managed', 'ineligible', 'gone']);
    expect(visibleStatuses({ managed: 6 }, 'dismissed')).toEqual(['managed', 'dismissed']);
    expect(visibleStatuses({}, null)).toEqual([]);
  });

  it('takes every backend kind of the discovery package, Kubernetes included', () => {
    expect(BACKEND_KINDS).toEqual(['instance', 'asg', 'ecs', 'k8s']);
    expect(DIMENSIONS.find((d) => d.key === 'backendKinds')!.hint).toContain('k8s');
  });

  it('words the criteria\'s hints for both clouds', () => {
    const hint = (key: string) => DIMENSIONS.find((d) => d.key === key)!.hint;
    expect(DIMENSIONS.find((d) => d.key === 'ouIds')!.label).toBe('OUs or folders');
    expect(hint('ouIds')).toContain('folders/<n>');
    expect(hint('ouIds')).toContain('organizations/<n>');
    expect(hint('accountIds')).toContain('project');
    expect(hint('regions')).toContain('europe-west2');
    expect(hint('regions')).toContain('global');
    expect(hint('loadBalancers')).toContain('projects/');
    expect(hint('resourceTags')).toContain('backend service');
  });

  it('says a Google Cloud candidate\'s idle share is of its backend service, estimated from sampled metrics', () => {
    const text = idleText({ idleHours7d: 154, requests7d: 1234 }, 'gcp');
    expect(text.detail).toBe('154 of 168 hours without any request to its backend service (1,234 requests in 7 days).');
  });
});
