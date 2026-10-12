// The estimate's reports (spec §8): a Markdown readable as it is, a JSON with every figure, the terminal's summary.
import { describe, expect, it } from 'vitest';
import type { Estimate } from '../src/estimate.js';
import { jsonReport, markdownReport, summaryLines } from '../src/report.js';

const workload = (name: string, usd15: number, recommended = 30) => ({
  workload: { account: '111111111111', region: 'eu-west-1', loadBalancer: 'web', loadBalancerArn: 'arn:lb', targetGroup: name, targetGroupArn: `arn:tg/${name}`, hosts: [`${name}.example.com`], backend: { kind: 'asg' as const, id: `${name}-asg` }, stopped: [] },
  quiet: name === 'docs', at15: { usdMonth: usd15, wakesPerDay: 2, asleepHours: 20 }, recommended: { minutes: recommended, usdMonth: usd15 - 1, wakesPerDay: 1 },
});
const E: Estimate = {
  generatedAt: '2026-10-10T12:00:30.000Z', organization: 'o-abc123', why: null,
  options: { regions: ['eu-west-1'], role: 'OrganizationAccountAccessRole', baseline: { kind: 'always' }, discounts: { compute: 20, databases: 0 }, refresh: null },
  accounts: 2,
  totals: { workloads: 12, usdMonth15: 180.5, usdMonthRecommended: 168.5, dormetoMonth: 7.08 },
  byAccount: { '111111111111': { workloads: 12, usdMonth15: 180.5, usdMonthRecommended: 168.5, dormetoMonth: 1.82 } },
  byRegion: { 'eu-west-1': { workloads: 12, usdMonth15: 180.5, usdMonthRecommended: 168.5, dormetoMonth: 1.82 } },
  workloads: Array.from({ length: 12 }, (_, i) => (i === 5 ? { ...workload('napping', 15), workload: { ...workload('napping', 15).workload, managed: true as const } } : workload(i === 3 ? 'docs' : `app${i}`, 10 + i))),
  leftOut: [{ workload: workload('gpu', 0).workload, reason: 'what it stops has no AWS list price' }],
  ineligible: [{ account: '111111111111', region: 'eu-west-1', loadBalancer: 'web', targetGroup: 'shared', hosts: [], reason: 'its target group is shared' }],
  unreachable: [{ account: '333333333333', name: 'sandbox', reason: 'not authorized to perform: sts:AssumeRole', fix: 'create a role this profile may assume, with read access, and name it with --role (tried OrganizationAccountAccessRole)' }],
  failedRegions: [{ account: '111111111111', region: 'eu-west-3', error: 'opt-in region not enabled' }],
  assumptions: ['Every request counts as activity and as a wake.'],
};

describe('the estimate\'s reports', () => {
  it('the Markdown: the target, the totals, every workload, what was left out and why, the options and the assumptions', () => {
    const md = markdownReport(E);
    for (const heading of ['# Dormeto savings estimate', '## Totals', '### By account', '### By region', '## Workloads', '## Left out', '## Not eligible', '## Accounts not reached', '## Regions that failed', '## Options', '## Assumptions']) expect(md).toContain(heading);
    expect(md).toContain('Organization o-abc123, 2 accounts');
    expect(md).toContain('$180.50');
    expect(md).toContain('$173.42'); // net at 15 minutes
    expect(md).toContain('docs.example.com (no request in 14 days)');
    expect(md).toContain('napping.example.com (managed by Dormeto)');
    expect(md).toContain('what it stops has no AWS list price');
    expect(md).toContain('create a role this profile may assume');
    expect(md).toContain('compute 20%, databases 0%');
    expect(md).toContain('Every request counts');
  });

  it('the JSON parses back to the estimate', () => {
    expect(JSON.parse(jsonReport(E))).toEqual(E);
  });

  it('the terminal\'s summary: the totals, the ten workloads saving the most, what was left out', () => {
    const lines = summaryLines(E);
    expect(lines[0]).toBe('About $180.50 a month at a 15-minute idle window ($168.50 at the recommended windows) for 12 workloads in 2 accounts; Dormeto costs about $7.08 a month: net about $173.42.');
    const top = lines.filter((l) => l.includes('.example.com'));
    expect(top).toHaveLength(10);
    expect(top[0]).toContain('app11.example.com');
    expect(lines.join('\n')).toContain('Left out: 1 workload');
    expect(lines.join('\n')).toContain('Not reached: 1 account');
  });
});
