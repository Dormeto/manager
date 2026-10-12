// The estimate command's options (vision docs/specs/2026-10-10-savings-estimate-design.md §3).
import { describe, expect, it } from 'vitest';
import { UsageError, parseOptions } from '../src/options.js';

describe('the estimate command\'s options', () => {
  it('a profile alone: every account reached, every enabled region, the supposed role, 24/7, no discount, the cache as it is, here, a 1-hour window', () => {
    expect(parseOptions(['--profile', 'prospect'])).toEqual({
      profile: 'prospect', accounts: null, regions: null, excludeTags: [], role: 'OrganizationAccountAccessRole', baseline: { kind: 'always' },
      discounts: { compute: 0, databases: 0 }, refresh: null, out: process.cwd(), window: 60,
    });
  });

  it('every option given', () => {
    expect(parseOptions([
      '--profile', 'prospect', '--accounts', '222222222222, 333333333333,222222222222', '--regions', 'eu-west-1,eu-west-3',
      '--exclude-tags', 'env=dev|test, team=web', '--exclude-tags', 'dormeto:ignore', '--role', 'ReadOnlyAudit', '--baseline', 'business-hours',
      '--timezone', 'Europe/Paris', '--discount-compute', '20', '--discount-databases', '30', '--refresh', 'metrics', '--out', '/tmp/reports', '--window', '30',
    ])).toEqual({
      profile: 'prospect', accounts: ['222222222222', '333333333333'], regions: ['eu-west-1', 'eu-west-3'],
      // Each --exclude-tags a criterion (any of them excludes): every key in it (and), one of a key's values (or).
      excludeTags: [{ env: ['dev', 'test'], team: ['web'] }, { 'dormeto:ignore': [] }], role: 'ReadOnlyAudit', baseline: { kind: 'business-hours', timeZone: 'Europe/Paris' },
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
      [['--profile', 'p', '--accounts', ','], '--accounts: one AWS account id or more, such as 111111111111,222222222222'],
      [['--profile', 'p', '--accounts', '111111111111,12345'], '--accounts: not an AWS account id: 12345'],
      [['--profile', 'p', '--exclude-tags', ' , '], '--exclude-tags: one tag or more, such as env=dev|test,team=web'],
      [['--profile', 'p', '--exclude-tags', 'env=dev,=web'], '--exclude-tags: a tag without its key: =web'],
      [['--profile', 'p', '--exclude-tags', 'env=dev,env=test'], '--exclude-tags: env twice in one criterion: env=dev|test for either'],
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
