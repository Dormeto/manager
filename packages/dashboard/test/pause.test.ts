import { describe, expect, it } from 'vitest';
import { exclusionTargets, exclusionText, healthColor, pauseLabel, pauseLine, untilFrom } from '../src/pause';
import type { Pause } from '../src/types';

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
});
