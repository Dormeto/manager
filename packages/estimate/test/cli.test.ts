// The estimate command (spec §3, §8): its exit codes, a run writing both reports and printing the summary, a second run
// from the cache asking AWS nothing but who the profile is and its organization.
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ScannedRule } from '@dormeto/discovery';
import type { Discounts } from '@dormeto/fleet';
import { main, type EstimateAws } from '../src/cli.js';

const A = '111111111111';
const R = 'eu-west-1';
const NOW = Date.parse('2026-10-10T12:00:30.000Z');
const LB = `arn:aws:elasticloadbalancing:${R}:${A}:loadbalancer/app/web/0123456789abcdef`;
const TG = `arn:aws:elasticloadbalancing:${R}:${A}:targetgroup/shop/fedcba9876543210`;
const RULE: ScannedRule = {
  id: TG, account: A, region: R, loadBalancer: 'web', loadBalancerArn: LB, listener: 'HTTPS:443', priority: '10', conditions: 'host shop.example.com',
  hosts: ['shop.example.com'], targetGroup: 'shop', targetGroupArn: TG, backend: { kind: 'instance', id: 'i-1' }, tags: {}, rules: [], eligibility: 'eligible', idleHours7d: 150, requests7d: 20,
};

const B = '222222222222';
const member = (id: string) => ({ id, name: id === A ? 'management' : 'prod', ouPath: ['r-root'], tags: {} });

function fakeAws({ whoami = async () => A, organization = null, tags = {} }: { whoami?: () => Promise<string>; organization?: string | null; tags?: Record<string, string[]> } = {}) {
  const calls = { scans: 0, metrics: 0, regions: 0, assumed: 0, discounts: [] as Discounts[] };
  const aws: EstimateAws = {
    accounts: {
      whoami, organization: async () => { if (organization) return organization; throw Object.assign(new Error('Your account is not a member of an organization.'), { name: 'AWSOrganizationsNotInUseException' }); },
      inventory: async () => ({ accounts: organization ? [member(A), member(B)] : [], ous: {} }), assume: async () => { calls.assumed += 1; return { accessKeyId: 'a', secretAccessKey: 's', sessionToken: 't' }; },
    },
    regionsOf: async () => { calls.regions += 1; return [R]; },
    portsOf: () => ({
      scan: async () => { calls.scans += 1; return [{ ...RULE, tags }]; },
      autoscaling: { describeAutoScalingGroups: async () => ({ AutoScalingGroups: [] }) },
      elbv2: { describeRules: async () => ({ Rules: [] }) },
      ec2: { describeInstances: async () => ({ Reservations: [{ Instances: [{ InstanceId: 'i-1', InstanceType: 't3.medium', PlatformDetails: 'Linux/UNIX' }] }] }) },
      ecs: { describeServices: async () => ({ services: [] }), describeTaskDefinition: async () => ({}) },
    }),
    cloudwatchOf: () => ({
      getMetricData: async (input) => {
        calls.metrics += 1;
        const from = input.StartTime.getTime();
        return { MetricDataResults: input.MetricDataQueries.map((q) => ({ Id: q.Id, Timestamps: Array.from({ length: 14 }, (_, d) => new Date(from + (600 + d * 1440) * 60_000)), Values: Array(14).fill(2), StatusCode: 'Complete' })) };
      },
    }),
    prices: () => ({ hourly: async (_region, item, discounts) => { calls.discounts.push(discounts); return item.kind === 'ec2' ? 0.0456 : null; } }),
  };
  return { aws, calls };
}

function deps(aws: EstimateAws) {
  const out: string[] = [];
  const errors: string[] = [];
  const cacheRoot = mkdtempSync(join(tmpdir(), 'dormeto-estimate-cache-'));
  return { out, errors, cacheRoot, deps: { now: () => NOW, cacheRoot, log: (l: string) => out.push(l), error: (l: string) => errors.push(l), aws: () => aws } };
}

describe('the estimate command', () => {
  it('a bad option: its message and the usage, exit code 2', async () => {
    const d = deps(fakeAws().aws);
    expect(await main(['--profile', 'p', '--refresh', 'all'], d.deps)).toBe(2);
    expect(d.errors[0]).toBe('--refresh: discovery or metrics');
    expect(d.errors[1]).toContain('Usage: npm run estimate -- --profile <profile>');
  });

  it('credentials that do not work: AWS\'s message, exit code 1', async () => {
    const { aws } = fakeAws({ whoami: async () => { throw Object.assign(new Error('The security token included in the request is expired'), { name: 'ExpiredTokenException' }); } });
    const d = deps(aws);
    expect(await main(['--profile', 'p'], d.deps)).toBe(1);
    expect(d.errors).toEqual(['ExpiredTokenException: The security token included in the request is expired']);
  });

  it('writes both reports and prints the summary; the discounts reach the prices; a second run asks AWS only who it is', async () => {
    const { aws, calls } = fakeAws();
    const d = deps(aws);
    const out = mkdtempSync(join(tmpdir(), 'dormeto-estimate-out-'));
    expect(await main(['--profile', 'p', '--discount-compute', '20', '--out', out], d.deps)).toBe(0);
    expect(readdirSync(out).sort()).toEqual(['estimate-2026-10-10.json', 'estimate-2026-10-10.md']);
    expect(JSON.parse(readFileSync(join(out, 'estimate-2026-10-10.json'), 'utf8')).totals.workloads).toBe(1);
    expect(readFileSync(join(out, 'estimate-2026-10-10.md'), 'utf8')).toContain('shop.example.com');
    expect(d.out.join('\n')).toContain('for 1 workload in 1 account');
    expect(d.out.join('\n')).toContain(join(out, 'estimate-2026-10-10.md'));
    expect(calls.discounts[0]).toEqual({ compute: 20, databases: 0 });
    // The cache is the account's (no organization).
    expect(readdirSync(d.cacheRoot)).toEqual([A]);
    const before = { ...calls };
    expect(await main(['--profile', 'p', '--out', out], d.deps)).toBe(0);
    expect([calls.scans, calls.metrics, calls.regions, calls.assumed]).toEqual([before.scans, before.metrics, before.regions, before.assumed]);
  });

  it('restricted to accounts of the organization (--accounts): only those, and how many of its accounts', async () => {
    const { aws, calls } = fakeAws({ organization: 'o-abc123' });
    const d = deps(aws);
    const out = mkdtempSync(join(tmpdir(), 'dormeto-estimate-out-'));
    expect(await main(['--profile', 'p', '--accounts', A, '--out', out], d.deps)).toBe(0);
    expect(d.out[0]).toBe(`Estimating the organization o-abc123 (1 of its 2 accounts, --accounts); cache ${join(d.cacheRoot, 'o-abc123')}`);
    // The other account is never reached.
    expect([calls.assumed, calls.regions]).toEqual([0, 1]);
    expect(JSON.parse(readFileSync(join(out, 'estimate-2026-10-10.json'), 'utf8'))).toMatchObject({ accounts: 1, accountsListed: 2, options: { accounts: [A] } });
  });

  it('accounts given that cannot be estimated: why, exit code 2', async () => {
    const d = deps(fakeAws({ organization: 'o-abc123' }).aws);
    // A temporary --out: a run that went on would write nothing in the repository.
    expect(await main(['--profile', 'p', '--accounts', '999999999999', '--out', mkdtempSync(join(tmpdir(), 'dormeto-estimate-out-'))], d.deps)).toBe(2);
    expect(d.errors).toEqual(['--accounts: 999999999999: not an active account of the organization o-abc123']);
  });

  it('workloads excluded by their tags (--exclude-tags): not estimated, their requests never read, listed in the report', async () => {
    const { aws, calls } = fakeAws({ tags: { env: ['dev'], team: ['shop'] } });
    const d = deps(aws);
    const out = mkdtempSync(join(tmpdir(), 'dormeto-estimate-out-'));
    expect(await main(['--profile', 'p', '--exclude-tags', 'env=prod', '--exclude-tags', 'env=dev|test,team=shop', '--out', out], d.deps)).toBe(0);
    expect(calls.metrics).toBe(0);
    const json = JSON.parse(readFileSync(join(out, 'estimate-2026-10-10.json'), 'utf8'));
    expect(json.totals.workloads).toBe(0);
    expect(json.excluded).toMatchObject([{ workload: { targetGroup: 'shop' }, criterion: 'env=dev|test, team=shop' }]);
    expect(d.out).toContain('Excluded by tags: 1 workload (see the report)');
  });
});
