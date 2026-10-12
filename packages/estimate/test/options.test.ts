// The estimate command's options (vision docs/specs/2026-10-10-savings-estimate-design.md §3).
import { describe, expect, it } from 'vitest';
import { UsageError, parseOptions } from '../src/options.js';

describe('the estimate command\'s options', () => {
  it('a profile alone: every account reached, every enabled region, the supposed role, 24/7, no discount, the cache as it is, here, a 1-hour window', () => {
    expect(parseOptions(['--profile', 'prospect'])).toEqual({
      profiles: ['prospect'], accounts: null, regions: null, excludeTags: [], ec2Uptime: false, ecsUptime: false, rdsUptime: false, role: 'OrganizationAccountAccessRole', baseline: { kind: 'always' },
      discounts: { compute: 0, databases: 0 }, refresh: null, out: process.cwd(), window: 60, maxWakes: 3, minSaving: 1, parallel: 5, maxWakesRds: 2,
    });
  });

  it('every option given', () => {
    expect(parseOptions([
      '--profile', 'prospect', '--accounts', '222222222222, 333333333333,222222222222', '--regions', 'eu-west-1,eu-west-3',
      '--exclude-tags', 'env=dev|test, team=web', '--exclude-tags', 'dormeto:ignore', '--ec2-uptime', '--role', 'ReadOnlyAudit', '--baseline', 'business-hours',
      '--timezone', 'Europe/Paris', '--discount-compute', '20', '--discount-databases', '30', '--refresh', 'metrics', '--out', '/tmp/reports', '--window', '30', '--max-wakes', '5', '--min-saving', '2.5', '--parallel', '2', '--max-wakes-rds', '1.5',
    ])).toEqual({
      profiles: ['prospect'], accounts: ['222222222222', '333333333333'], regions: ['eu-west-1', 'eu-west-3'],
      // Each --exclude-tags a criterion (any of them excludes): every key in it (and), one of a key's values (or).
      excludeTags: [{ env: ['dev', 'test'], team: ['web'] }, { 'dormeto:ignore': [] }], ec2Uptime: true, ecsUptime: false, rdsUptime: false, role: 'ReadOnlyAudit', baseline: { kind: 'business-hours', timeZone: 'Europe/Paris' },
      discounts: { compute: 20, databases: 30 }, refresh: 'metrics', out: '/tmp/reports', window: 30, maxWakes: 5, minSaving: 2.5, parallel: 2, maxWakesRds: 1.5,
    });
    expect(parseOptions(['--profile', 'p', '--baseline', 'business-hours']).baseline).toEqual({ kind: 'business-hours', timeZone: 'UTC' });
    // A flag, anywhere: it takes no value.
    expect(parseOptions(['--ec2-uptime', '--profile', 'p'])).toMatchObject({ profiles: ['p'], ec2Uptime: true });
  });

  it('--max-wakes: the workloads waking more than that a day left out (3 by default; a decimal; none keeps them all)', () => {
    expect(parseOptions(['--profile', 'p', '--max-wakes', '0.5']).maxWakes).toBe(0.5);
    expect(parseOptions(['--profile', 'p', '--max-wakes', 'none']).maxWakes).toBeNull();
    for (const bad of ['-1', 'many', '']) expect(() => parseOptions(['--profile', 'p', '--max-wakes', bad])).toThrow(UsageError);
  });

  it('--min-saving: the workloads saving less than that a month left out ($1 by default; none or 0 keeps them all)', () => {
    expect(parseOptions(['--profile', 'p', '--min-saving', '0.5']).minSaving).toBe(0.5);
    expect(parseOptions(['--profile', 'p', '--min-saving', 'none']).minSaving).toBeNull();
    expect(parseOptions(['--profile', 'p', '--min-saving', '0']).minSaving).toBe(0);
    for (const bad of ['-1', '$1', '']) expect(() => parseOptions(['--profile', 'p', '--min-saving', bad])).toThrow(UsageError);
  });

  it('--max-wakes-rds: companion databases of workloads waking more than that a day left out (2 by default; none keeps them)', () => {
    expect(parseOptions(['--profile', 'p', '--max-wakes-rds', '0.5']).maxWakesRds).toBe(0.5);
    expect(parseOptions(['--profile', 'p', '--max-wakes-rds', 'none']).maxWakesRds).toBeNull();
    for (const bad of ['-1', 'few']) expect(() => parseOptions(['--profile', 'p', '--max-wakes-rds', bad])).toThrow(UsageError);
  });

  it('--parallel: how many accounts are discovered at once (5 by default, 1 to 50)', () => {
    expect(parseOptions(['--profile', 'p', '--parallel', '1']).parallel).toBe(1);
    expect(parseOptions(['--profile', 'p', '--parallel', '50']).parallel).toBe(50);
    for (const bad of ['0', '51', '-2', '2.5', 'all']) expect(() => parseOptions(['--profile', 'p', '--parallel', bad])).toThrow(UsageError);
  });

  it('--ecs-uptime measures the ECS services, --ec2-uptime the instances, --uptime both', () => {
    expect(parseOptions(['--profile', 'p', '--ecs-uptime'])).toMatchObject({ ec2Uptime: false, ecsUptime: true });
    expect(parseOptions(['--profile', 'p', '--uptime'])).toMatchObject({ ec2Uptime: true, ecsUptime: true, rdsUptime: true });
    expect(parseOptions(['--profile', 'p', '--rds-uptime'])).toMatchObject({ ec2Uptime: false, ecsUptime: false, rdsUptime: true });
    expect(parseOptions(['--profile', 'p', '--uptime', '--ec2-uptime'])).toMatchObject({ ec2Uptime: true, ecsUptime: true });
  });

  it('several profiles, such as one SSO profile per account: in their order, once each', () => {
    expect(parseOptions(['--profile', 'qal, prd,qal,pilot']).profiles).toEqual(['qal', 'prd', 'pilot']);
  });

  it('refuses what it cannot use, saying why', () => {
    const refused: [string[], string][] = [
      [[], '--profile is required'],
      [['--profile'], '--profile needs a value'],
      [['--profile', ' , '], '--profile: one AWS profile or more, such as qal,prod'],
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
      [['--profile', 'p', '--ec2-uptime', 'yes'], 'unknown option: yes'],
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
