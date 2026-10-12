// The estimate command's options (vision docs/specs/2026-10-10-savings-estimate-design.md §3).
import { describe, expect, it } from 'vitest';
import { UsageError, parseOptions } from '../src/options.js';

describe('the estimate command\'s options', () => {
  it('a profile alone: every enabled region, the supposed role, 24/7, no discount, the cache as it is, here, a 1-hour window', () => {
    expect(parseOptions(['--profile', 'prospect'])).toEqual({
      profile: 'prospect', regions: null, role: 'OrganizationAccountAccessRole', baseline: { kind: 'always' },
      discounts: { compute: 0, databases: 0 }, refresh: null, out: process.cwd(), window: 60,
    });
  });

  it('every option given', () => {
    expect(parseOptions([
      '--profile', 'prospect', '--regions', 'eu-west-1,eu-west-3', '--role', 'ReadOnlyAudit', '--baseline', 'business-hours',
      '--timezone', 'Europe/Paris', '--discount-compute', '20', '--discount-databases', '30', '--refresh', 'metrics', '--out', '/tmp/reports', '--window', '30',
    ])).toEqual({
      profile: 'prospect', regions: ['eu-west-1', 'eu-west-3'], role: 'ReadOnlyAudit', baseline: { kind: 'business-hours', timeZone: 'Europe/Paris' },
      discounts: { compute: 20, databases: 30 }, refresh: 'metrics', out: '/tmp/reports', window: 30,
    });
    expect(parseOptions(['--profile', 'p', '--baseline', 'business-hours']).baseline).toEqual({ kind: 'business-hours', timeZone: 'UTC' });
  });

  it('refuses what it cannot use, saying why', () => {
    const refused: [string[], string][] = [
      [[], '--profile is required'],
      [['--profile'], '--profile needs a value'],
      [['--profile', 'p', '--baseline', 'nightly'], '--baseline: always or business-hours'],
      [['--profile', 'p', '--timezone', 'Mars/Olympus'], '--timezone: unknown time zone Mars/Olympus'],
      [['--profile', 'p', '--discount-compute', '91'], '--discount-compute: a whole number from 0 to 90'],
      [['--profile', 'p', '--discount-databases', '2.5'], '--discount-databases: a whole number from 0 to 90'],
      [['--profile', 'p', '--refresh', 'all'], '--refresh: discovery or metrics'],
      [['--profile', 'p', '--regions', ''], '--regions: one region or more, such as eu-west-1,us-east-1'],
      [['--profile', 'p', '--regions', 'eu-west-1,mars'], '--regions: unknown region mars'],
      [['--profile', 'p', '--window', '4'], '--window: whole minutes from 5 to 1440'],
      [['--profile', 'p', '--window', '90.5'], '--window: whole minutes from 5 to 1440'],
      [['--profile', 'p', '--verbose'], 'unknown option: --verbose'],
    ];
    for (const [argv, message] of refused) {
      expect(() => parseOptions(argv), argv.join(' ')).toThrow(UsageError);
      expect(() => parseOptions(argv), argv.join(' ')).toThrow(message);
    }
  });
});
