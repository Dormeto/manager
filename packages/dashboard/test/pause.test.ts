import { describe, expect, it } from 'vitest';
import { mdiClockAlertOutline, mdiCloudOffOutline, mdiLanDisconnect } from '@mdi/js';
import { exclusionTargets, exclusionText, healthColor, healthIcon, healthText, pauseLabel, pauseLine, pausesText, routerStatus, untilFrom, workloadsText } from '../src/pause';
import type { Pause, RouterInfo } from '../src/types';

const now = Date.parse('2026-10-05T12:00:00Z');
const pause = (over: Partial<Pause> = {}): Pause => ({ scope: 'workload', by: 'ops@example.com', at: '2026-10-05T11:00:00.000Z', reason: 'load test', until: null, keepAsleep: false, ...over });

describe('pauses', () => {
  it('labels a workload paused, or excluded when an exclusion paused it', () => {
    expect(pauseLabel([])).toBeNull();
    expect(pauseLabel([pause(), pause({ scope: 'router' })])).toBe('paused');
    expect(pauseLabel([pause({ reason: 'excluded: migration', exclusionId: 'x1' }), pause()])).toBe('excluded');
  });

  it('describes who paused, when, why and the automatic resume', () => {
    expect(pauseLine(pause(), now)).toBe('Paused by ops@example.com 1 h ago: load test');
    expect(pauseLine(pause({ scope: 'router', until: '2026-10-05T14:00:00.000Z', keepAsleep: true }), now))
      .toBe('Router paused by ops@example.com 1 h ago: load test; resumes in 2 h; asleep workloads left asleep');
    expect(pauseLine(pause({ reason: 'excluded: migration', exclusionId: 'x1' }), now)).toBe('Excluded by ops@example.com 1 h ago: migration');
  });

  it('turns the automatic resume choice into a date', () => {
    expect(untilFrom('none', now)).toBeUndefined();
    expect(untilFrom('1h', now)).toBe('2026-10-05T13:00:00.000Z');
    expect(untilFrom('7d', now)).toBe('2026-10-12T12:00:00.000Z');
    expect(untilFrom('date', now, '2026-10-06T08:30')).toBe(new Date('2026-10-06T08:30').toISOString());
    expect(untilFrom('date', now, '')).toBeUndefined();
  });

  it('colors the router health', () => {
    expect([healthColor('ok'), healthColor('warning'), healthColor('error'), healthColor(undefined)]).toEqual(['success', 'warning', 'error', 'grey']);
  });

  it('says the pauses for an export, their dates as ISO 8601', () => {
    expect(pausesText([pause({ scope: 'router', until: '2026-10-05T14:00:00.000Z' })])).toBe('Router paused by ops@example.com at 2026-10-05T11:00:00.000Z: load test; resumes at 2026-10-05T14:00:00.000Z');
    expect(pausesText([pause({ reason: 'excluded: migration', exclusionId: 'x1' }), pause({ keepAsleep: true })]))
      .toBe('Excluded by ops@example.com at 2026-10-05T11:00:00.000Z: migration · Paused by ops@example.com at 2026-10-05T11:00:00.000Z: load test; asleep workloads left asleep');
    expect(pausesText([])).toBe('');
    expect(pausesText(undefined)).toBe('');
  });
});

// A router's Health and Workloads cells in words (Routers' exports and search, tables design §5).
describe('a router in words', () => {
  const r: RouterInfo = { name: 'dmtr-a', region: 'eu-west-3' };
  it('says its health: the status, each problem (its level when it differs), an open alert, unreachable, not reporting', () => {
    expect(healthText({ ...r, health: { status: 'ok', problems: [] } })).toBe('ok');
    expect(healthText({ ...r, health: { status: 'error', problems: [{ level: 'error', text: 'idle check late' }, { level: 'warning', text: 'controller: 2 errors in 24 hours' }] } }))
      .toBe('error: idle check late; controller: 2 errors in 24 hours (warning)');
    expect(healthText({ ...r, error: 'timed out', reporting: false })).toBe('unreachable: timed out');
    expect(healthText({ ...r })).toBe('no health report: upgrade to 0.16 for health');
    expect(healthText({ ...r, reporting: false, health: { status: 'warning', problems: [{ level: 'warning', text: 'drift' }] } }, { level: 'warning', since: '2026-10-05T09:00:00.000Z' }))
      .toBe('warning: drift · alert since 2026-10-05T09:00:00.000Z · not reporting');
  });

  // The paused ones are among the states' counts: said apart, so the counts do not read as a sum.
  it('says its workloads by state, then how many of them are paused', () => {
    expect(workloadsText({ ...r, workloads: 5, workloadStates: { AWAKE: 3, ASLEEP: 1, FAILED: 1 }, paused: 1 })).toBe('3 awake, 1 asleep, 1 failed; 1 of them paused');
    expect(workloadsText({ ...r, workloads: 5, workloadStates: { ASLEEP: 5 }, paused: 0 })).toBe('5 asleep');
    // No workload: 0, not an empty cell.
    expect(workloadsText({ ...r, workloads: 0, workloadStates: {}, paused: 0 })).toBe('0');
    // A router known by its count only: its count, and its paused ones all the same.
    expect(workloadsText({ ...r, workloads: 4 })).toBe('4');
    expect(workloadsText({ ...r, workloads: 3, paused: 1 })).toBe('3; 1 of them paused');
    expect(workloadsText({ ...r })).toBe('');
  });
});

describe('exclusions', () => {
  const TG = 'arn:aws:elasticloadbalancing:eu-west-1:121014831971:targetgroup/dmt-dev-asg-app/73e2d6bc24d8a067';
  const LB = 'arn:aws:elasticloadbalancing:eu-west-1:121014831971:loadbalancer/app/dmt-dev/50dc6c495c0c9188';

  it('offers the target group, the load balancer and the account of a candidate', () => {
    expect(exclusionTargets({ targetGroupArn: TG, targetGroup: 'dmt-dev-asg-app', loadBalancerArn: LB, loadBalancer: 'dmt-dev', account: '121014831971', accountName: 'dormeto' })).toEqual([
      { kind: 'target-group', arn: TG, label: 'Target group dmt-dev-asg-app' },
      { kind: 'load-balancer', arn: LB, label: 'Load balancer dmt-dev (every rule on it)' },
      { kind: 'account', account: '121014831971', label: 'Account dormeto, 121014831971 (never read again)' },
    ]);
    expect(exclusionTargets({ targetGroupArn: null, targetGroup: null, loadBalancerArn: LB, loadBalancer: 'dmt-dev', account: '1', accountName: '1' }).map((t) => t.kind)).toEqual(['load-balancer', 'account']);
  });

  it('describes an exclusion target', () => {
    expect(exclusionText({ kind: 'target-group', arn: TG, account: '121014831971', region: 'eu-west-1', name: 'dmt-dev-asg-app' })).toBe('target group dmt-dev-asg-app · 121014831971 · eu-west-1');
    expect(exclusionText({ kind: 'account', account: '038606077307', name: 'ligoj' })).toBe('account ligoj · 038606077307');
  });

  it('offers the backend service, the URL map and the project of a Google Cloud candidate, by their paths', () => {
    const c = {
      targetGroupArn: null, targetGroup: 'shop-bs', loadBalancerArn: '', loadBalancer: 'shop-lb', account: 'dormeto-dev', accountName: 'dormeto-dev',
      id: 'projects/dormeto-dev/global/backendServices/shop-bs', backendService: 'projects/dormeto-dev/global/backendServices/shop-bs', urlMap: 'projects/dormeto-dev/global/urlMaps/shop-lb',
    };
    expect(exclusionTargets(c)).toEqual([
      { kind: 'target-group', path: 'projects/dormeto-dev/global/backendServices/shop-bs', label: 'Backend service shop-bs' },
      { kind: 'load-balancer', path: 'projects/dormeto-dev/global/urlMaps/shop-lb', label: 'URL map shop-lb (every backend service it names)' },
      { kind: 'account', account: 'dormeto-dev', label: 'Project dormeto-dev (never read again)' },
    ]);
  });

  it('reads a Google Cloud candidate without AWS\'s fields as one stored with them null and empty', () => {
    const base = { targetGroup: 'shop-bs', loadBalancer: 'shop-lb', account: 'dormeto-dev', accountName: 'dormeto-dev', id: 'projects/dormeto-dev/global/backendServices/shop-bs', backendService: 'projects/dormeto-dev/global/backendServices/shop-bs', urlMap: 'projects/dormeto-dev/global/urlMaps/shop-lb' };
    const stored = exclusionTargets({ ...base, targetGroupArn: null, loadBalancerArn: '' });
    expect(stored.map((t) => t.kind)).toEqual(['target-group', 'load-balancer', 'account']);
    expect(exclusionTargets({ ...base })).toEqual(stored);
  });

  it('describes a Google Cloud exclusion target in its own words', () => {
    expect(exclusionText({ kind: 'target-group', path: 'projects/dormeto-dev/global/backendServices/shop-bs', account: 'dormeto-dev', region: 'global', name: 'shop-bs' })).toBe('backend service shop-bs · dormeto-dev · global');
    expect(exclusionText({ kind: 'load-balancer', path: 'projects/dormeto-dev/global/urlMaps/shop-lb', account: 'dormeto-dev', region: 'global', name: 'shop-lb' })).toBe('URL map shop-lb · dormeto-dev · global');
    expect(exclusionText({ kind: 'account', account: 'dormeto-dev', name: 'dormeto-dev' })).toBe('project dormeto-dev · dormeto-dev');
  });
});

describe('routerStatus', () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  const base = { name: 'r', region: 'eu-west-3', checkSchedule: 'rate(5 minutes)', lastScheduledCheckAt: '2026-10-06T11:59:00Z' };
  it('a router that does not report, known by its list only, is "not reporting" — never "ok" from its schedule alone', () => {
    expect(routerStatus({ ...base, reporting: false }, now)).toEqual({ color: 'warning', icon: mdiCloudOffOutline, text: 'not reporting', detail: 'no report from its idle checks for 3 periods of its schedule' });
  });
  it('else its health, unreachable, a late check or ok, each with the icon its mark shows (the word is its name)', () => {
    expect(routerStatus({ ...base, reporting: false, health: { status: 'error', problems: [{ level: 'error', text: 'idle check late' }] } }, now)).toEqual({ color: healthColor('error'), icon: healthIcon('error'), text: 'error', detail: 'idle check late' });
    expect(routerStatus({ ...base, error: 'timed out' }, now)).toEqual({ color: 'error', icon: mdiLanDisconnect, text: 'unreachable', detail: 'timed out' });
    expect(routerStatus({ ...base, reporting: true, lastScheduledCheckAt: '2026-10-06T10:00:00Z' }, now)).toMatchObject({ color: 'warning', icon: mdiClockAlertOutline, text: 'idle check late' });
    expect(routerStatus({ ...base, reporting: true }, now)).toMatchObject({ color: 'success', icon: healthIcon('ok'), text: 'ok' });
  });
});
