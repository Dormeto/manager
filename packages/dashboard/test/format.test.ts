import { describe, expect, it } from 'vitest';
import { duration, percent, relative, ruleText, shortId, stateColor } from '../src/format';

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
