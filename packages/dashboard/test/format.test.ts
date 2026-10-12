import { describe, expect, it } from 'vitest';
import { backendArn, checkHealth, concurrencyText, nameRule, duration, listSourceHref, percent, refreshLabel, relative, routeColor, routeLabel, ruleText, shortId, stateColor } from '../src/format';

describe('format', () => {
  const now = Date.parse('2026-10-04T12:00:00Z');
  it('shows relative times in the past and the future', () => {
    expect(relative('2026-10-04T11:59:30Z', now)).toBe('30 s ago');
    expect(relative('2026-10-04T11:15:00Z', now)).toBe('45 min ago');
    expect(relative('2026-10-04T14:00:00Z', now)).toBe('in 2 h');
    expect(relative(null, now)).toBe('—');
  });
  it('shows durations, percentages, short ids and state colors', () => {
    expect(duration(42)).toBe('42 s');
    expect(duration(754)).toBe('12 min 34 s');
    expect(duration(1800)).toBe('30 min');
    expect(duration(7200)).toBe('2 h');
    expect(percent(144, 168)).toBe('86 %');
    expect(shortId('arn:aws:ecs:eu-west-1:1:service/dmt-dev/dmt-dev-demo-ecs')).toBe('dmt-dev-demo-ecs');
    expect(shortId('i-0123')).toBe('i-0123');
    expect(stateColor('ASLEEP')).toBe('info');
    expect(stateColor('UNKNOWN')).toBe('grey');
  });
  it('describes rule conditions like the router admin page', () => {
    expect(ruleText({ headers: [{ name: 'x-dormeto-e2e', value: 'no-wake' }] })).toBe('header x-dormeto-e2e = no-wake');
    expect(ruleText({ pathPrefixes: ['/api/'], sourceIps: ['198.51.100.0/24'] })).toBe('source 198.51.100.0/24, path /api/*');
  });
});

describe('checkHealth', () => {
  const now = Date.parse('2026-10-04T12:00:00Z');
  it('is late after 3 periods of the check schedule, or when no scheduled check was recorded', () => {
    expect(checkHealth({ checkSchedule: 'rate(5 minutes)', lastScheduledCheckAt: '2026-10-04T11:56:00Z' }, now)).toEqual({ late: false, text: 'idle check 4 min ago' });
    expect(checkHealth({ checkSchedule: 'rate(5 minutes)', lastScheduledCheckAt: '2026-10-04T11:40:00Z' }, now)).toEqual({ late: true, text: 'idle check late: last run 20 min ago' });
    expect(checkHealth({ checkSchedule: 'rate(1 hour)', lastScheduledCheckAt: '2026-10-04T10:30:00Z' }, now).late).toBe(false);
    expect(checkHealth({ checkSchedule: null, lastScheduledCheckAt: null }, now)).toEqual({ late: true, text: 'no scheduled idle check recorded' });
  });
});

describe('refreshLabel', () => {
  it('counts down to the next refresh, or says it is off or running', () => {
    const now = 1_000_000;
    expect(refreshLabel({ seconds: 10, nextAt: now + 7_200, loading: false }, now)).toBe('Refreshing in 8 s');
    expect(refreshLabel({ seconds: 10, nextAt: now - 500, loading: false }, now)).toBe('Refreshing in 0 s');
    expect(refreshLabel({ seconds: 300, nextAt: now + 125_000, loading: false }, now)).toBe('Refreshing in 2 min 5 s');
    expect(refreshLabel({ seconds: 10, nextAt: now + 3_000, loading: true }, now)).toBe('Refreshing…');
    expect(refreshLabel({ seconds: 0, nextAt: null, loading: false }, now)).toBe('Auto-refresh off');
  });
});

describe('listSourceHref', () => {
  it('links http(s) lists directly and S3 lists to the console object page', () => {
    expect(listSourceHref('https://ip-ranges.amazonaws.com/ip-ranges.json')).toBe('https://ip-ranges.amazonaws.com/ip-ranges.json');
    expect(listSourceHref('s3://dmt-dev-ip-lists-1/scanners/censys.txt')).toBe('https://s3.console.aws.amazon.com/s3/object/dmt-dev-ip-lists-1?prefix=scanners%2Fcensys.txt');
    expect(listSourceHref('javascript:alert(1)')).toBeNull();
    expect(listSourceHref(null)).toBeNull();
  });
});

describe('route', () => {
  it('names the route of a workload over all its rules', () => {
    expect(routeLabel('app')).toBe('application');
    expect(routeLabel('waker')).toBe('waker');
    expect(routeLabel('mixed')).toBe('mixed: the rules disagree (repaired at the next idle check)');
    expect(routeLabel('unknown')).toBe('unknown: a rule is missing or changed');
    expect([routeColor('app'), routeColor('waker'), routeColor('mixed')]).toEqual(['success', 'info', 'warning']);
  });
});

describe('backendArn', () => {
  const where = { account: '121014831971', region: 'eu-west-1' };
  it('gives the ARN discovery recorded, or the one an older scan left to rebuild', () => {
    expect(backendArn({ kind: 'asg', id: 'web-asg', arn: 'arn:aws:autoscaling:eu-west-1:121014831971:autoScalingGroup:1:autoScalingGroupName/web-asg' }, where))
      .toBe('arn:aws:autoscaling:eu-west-1:121014831971:autoScalingGroup:1:autoScalingGroupName/web-asg');
    expect(backendArn({ kind: 'instance', id: 'i-0f30c85bc47412bf3' }, where)).toBe('arn:aws:ec2:eu-west-1:121014831971:instance/i-0f30c85bc47412bf3');
    expect(backendArn({ kind: 'instance', id: 'i-1' }, { account: '1', region: 'cn-north-1' })).toBe('arn:aws-cn:ec2:cn-north-1:1:instance/i-1');
    expect(backendArn({ kind: 'ecs', id: 'arn:aws:ecs:eu-west-1:121014831971:service/main/api' }, where)).toBe('arn:aws:ecs:eu-west-1:121014831971:service/main/api');
    expect(backendArn({ kind: 'asg', id: 'web-asg' }, where)).toBeNull();
  });
});

describe('nameRule', () => {
  it('accepts a workload name of at most 64 characters without control characters, empty meaning the default', () => {
    expect([nameRule('Shop (front)'), nameRule(''), nameRule('x'.repeat(64))]).toEqual([true, true, true]);
    expect([nameRule('x'.repeat(65)), nameRule('a\tb')]).toEqual(['at most 64 characters', 'no control characters']);
  });
});

describe('concurrencyText', () => {
  it('shows the limit, what the router used and its worst case (information only)', () => {
    expect(concurrencyText({ limit: 1000, needed: 20, worstCase: 7513 })).toBe('limit 1,000, used up to 20 in 24 hours; 7,513 if every workload not awake woke at once');
    expect(concurrencyText({ error: 'AccessDenied' })).toBe('AccessDenied');
    expect(concurrencyText(null)).toBe('—');
    // Routers before 0.22.3 give the worst case as the need.
    expect(concurrencyText({ limit: 10, needed: 18 })).toBe('limit 10, needs up to 18');
  });
});
