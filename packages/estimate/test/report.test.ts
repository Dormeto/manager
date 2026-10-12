// The estimate's reports (spec §8): a Markdown readable as it is, a JSON with every figure, the terminal's summary.
import { describe, expect, it } from 'vitest';
import type { Estimate } from '../src/estimate.js';
import { jsonReport, markdownReport, summaryLines } from '../src/report.js';

const workload = (name: string, usd15: number, recommended = 30) => ({
  workload: { account: '111111111111', region: 'eu-west-1', loadBalancer: 'web', loadBalancerArn: 'arn:lb', targetGroup: name, targetGroupArn: `arn:tg/${name}`, hosts: [`${name}.example.com`], backend: { kind: 'asg' as const, id: `${name}-asg` }, stopped: [], tags: {} },
  quiet: name === 'docs', actualMonth: usd15 * 2, atWindow: { usdMonth: usd15, wakesPerDay: 2, asleepHours: 20 }, recommended: { minutes: recommended, usdMonth: usd15 - 1, wakesPerDay: 1 },
});
const E: Estimate = {
  generatedAt: '2026-10-10T12:00:30.000Z', organization: 'o-abc123', why: null,
  options: { accounts: null, regions: ['eu-west-1'], excludeTags: [], role: 'OrganizationAccountAccessRole', baseline: { kind: 'always' }, discounts: { compute: 20, databases: 0 }, refresh: null, window: 60 },
  accounts: 2, accountsListed: 2, accountNames: { '111111111111': 'prod', '333333333333': 'sandbox' },
  dormeto: {
    manager: { count: 1, unitMonth: 5, usdMonth: 5 },
    routers: { count: 2, unitMonth: 0.26, usdMonth: 0.52, where: [{ account: '111111111111', region: 'eu-west-1' }, { account: '111111111111', region: 'eu-west-3' }] },
    workloads: { count: 12, unitMonth: 0.13, usdMonth: 1.56 },
    usdMonth: 7.08,
  },
  totals: { workloads: 12, actualMonth: 400, usdMonthWindow: 180.5, usdMonthRecommended: 168.5, dormetoMonth: 7.08, withDormetoMonth: 226.58 },
  byAccount: { '111111111111': { workloads: 12, actualMonth: 400, usdMonthWindow: 180.5, usdMonthRecommended: 168.5, dormetoMonth: 1.82, withDormetoMonth: 221.32 } },
  byRegion: { 'eu-west-1': { workloads: 12, actualMonth: 400, usdMonthWindow: 180.5, usdMonthRecommended: 168.5, dormetoMonth: 1.82, withDormetoMonth: 221.32 } },
  workloads: Array.from({ length: 12 }, (_, i) => (i === 5 ? { ...workload('napping', 15), workload: { ...workload('napping', 15).workload, managed: true as const } } : workload(i === 3 ? 'docs' : `app${i}`, 10 + i))),
  leftOut: [{ workload: workload('gpu', 0).workload, reason: 'what it stops has no AWS list price' }],
  excluded: [],
  ineligible: [{ account: '111111111111', region: 'eu-west-1', loadBalancer: 'web', targetGroup: 'shared', hosts: [], reason: 'its target group is shared' }],
  unreachable: [{ account: '333333333333', name: 'sandbox', reason: 'not authorized to perform: sts:AssumeRole', fix: 'create a role this profile may assume, with read access, and name it with --role (tried OrganizationAccountAccessRole)' }],
  failedRegions: [{ account: '111111111111', region: 'eu-west-3', error: 'opt-in region not enabled' }],
  assumptions: ['Every request counts as activity and as a wake.'],
};

describe('the estimate\'s reports', () => {
  it('the Markdown: the target, the totals, every workload, what was left out and why, the options and the assumptions', () => {
    const md = markdownReport(E);
    for (const heading of ['# Dormeto savings estimate', '## Totals', '### By account', '### Dormeto\'s cost', '## Workloads', '## Left out', '## Not eligible', '## Accounts not reached', '## Regions that failed', '## Options', '## Assumptions']) expect(md).toContain(heading);
    expect(md).toContain('Organization o-abc123, 2 accounts');
    expect(md).toContain('$180.50');
    expect(md).toContain('$173.42'); // net at the report's window
    expect(md).toContain('with a 1-hour idle window');
    expect(md).not.toContain('### By region');
    expect(md).toContain('docs.example.com (no request in 14 days)');
    expect(md).toContain('napping.example.com (managed by Dormeto)');
    expect(md).toContain('what it stops has no AWS list price');
    expect(md).toContain('create a role this profile may assume');
    expect(md).toContain('compute 20%, databases 0%');
    expect(md).toContain('- Accounts: every account reached');
    expect(md).toContain('Every request counts');
  });

  it('restricted to the accounts given: how many of the organization\'s, in the target and the summary; the options name them', () => {
    const restricted: Estimate = { ...E, accountsListed: 28, options: { ...E.options, accounts: ['111111111111', '222222222222'] } };
    const md = markdownReport(restricted);
    expect(md).toContain('Organization o-abc123, 2 of its 28 accounts (--accounts), estimated');
    expect(md).toContain('- Accounts: 111111111111, 222222222222 (--accounts)');
    expect(summaryLines(restricted)[0]).toContain('for 12 workloads in 2 of the organization\'s 28 accounts;');
  });

  it('the accounts: a row each and the total, their actual cost, their cost with Dormeto enabled and the savings', () => {
    expect(markdownReport(E)).toContain([
      '| Account | Name | Workloads | Actual monthly cost | Cost with Dormeto enabled | Savings |',
      '|---|---|---|---|---|---|',
      '| 111111111111 | prod | 12 | $400.00 | $221.32 | 45% |',
      '| **Total** | | **12** | **$400.00** | **$226.58** | **43%** |',
      '',
      'Cost with Dormeto enabled: at a 1-hour idle window, Dormeto\'s cost included; the total includes the manager ($5.00), once per installation.',
    ].join('\n'));
  });

  it('Dormeto\'s cost by part, each with its computation, and the cost with Dormeto applied', () => {
    expect(markdownReport(E)).toContain([
      '| Part | Computation | A month |',
      '|---|---|---|',
      '| Manager | 1 × $5.00: one per installation, whatever the number of accounts and workloads | $5.00 |',
      '| Routers | 2 × $0.26: one per account and region with workloads (111111111111 eu-west-1, 111111111111 eu-west-3) | $0.52 |',
      '| Workloads | 12 × $0.13: each workload\'s naps, wakes and idle checks | $1.56 |',
      '| **Dormeto\'s cost** | | **$7.08** |',
      '| Actual cost | what naps would stop in the 12 workloads, running 24/7 | $400.00 |',
      '| Savings | at a 1-hour idle window | -$180.50 |',
      '| **Cost with Dormeto applied** | $400.00 - $180.50 + $7.08 | **$226.58** |',
    ].join('\n'));
    const paris = markdownReport({ ...E, options: { ...E.options, baseline: { kind: 'business-hours', timeZone: 'Europe/Paris' } } });
    expect(paris).toContain('| Actual cost | what naps would stop in the 12 workloads, running in business hours (Europe/Paris) | $400.00 |');
  });

  it('the workloads excluded by their tags: listed with the criterion that matched, counted in the summary; the options name the criteria', () => {
    const tagged: Estimate = {
      ...E, options: { ...E.options, excludeTags: [{ env: ['dev', 'test'], team: ['web'] }, { 'dormeto:ignore': [] }] },
      excluded: [{ workload: workload('legacy', 0).workload, criterion: 'env=dev|test, team=web' }],
    };
    const md = markdownReport(tagged);
    expect(md).toContain([
      '## Excluded by tags', '',
      '| Account | Region | Load balancer | Target group | Hosts | Tags matched |', '|---|---|---|---|---|---|',
      '| 111111111111 | eu-west-1 | web | legacy | legacy.example.com | env=dev\\|test, team=web |',
    ].join('\n'));
    expect(md).toContain('- Excluded tags: env=dev|test, team=web; or dormeto:ignore');
    expect(summaryLines(tagged)).toContain('Excluded by tags: 1 workload (see the report)');
    expect(markdownReport(E)).not.toContain('## Excluded by tags');
    expect(markdownReport(E)).toContain('- Excluded tags: none');
    expect(summaryLines(E).join('\n')).not.toContain('Excluded by tags');
  });

  it('many routers: their count, not each account and region', () => {
    const where = Array.from({ length: 7 }, (_, i) => ({ account: `11111111111${i}`, region: 'eu-west-1' }));
    const md = markdownReport({ ...E, dormeto: { ...E.dormeto, routers: { count: 7, unitMonth: 0.26, usdMonth: 1.82, where } } });
    expect(md).toContain('| Routers | 7 × $0.26: one per account and region with workloads | $1.82 |');
  });

  // The visual: the actual cost against the cost with Dormeto, a month, in dollars and percent of the actual cost.
  const VISUAL = [
    'Monthly cost of the 12 workloads estimated, at a 1-hour idle window:',
    `  Actual cost   ${'█'.repeat(40)}  $400.00  100%`,
    `  With Dormeto  ${'█'.repeat(22)}▋${' '.repeat(17)}  $226.58   57%`,
    '  Saved: $173.42 a month, 43% of the actual cost',
  ];

  it('the visual, in the report under the totals and in the terminal under the summary', () => {
    expect(markdownReport(E)).toContain(['```text', ...VISUAL, '```'].join('\n'));
    const lines = summaryLines(E);
    expect(lines.slice(1, 1 + VISUAL.length + 1)).toEqual(['', ...VISUAL]);
  });

  it('the visual when Dormeto would cost more than it saves', () => {
    const lines = summaryLines({ ...E, totals: { ...E.totals, actualMonth: 10, usdMonthWindow: 4, withDormetoMonth: 13.09 } });
    expect(lines).toContain(`  Actual cost   ${'█'.repeat(30)}▌${' '.repeat(9)}  $10.00  100%`);
    expect(lines).toContain(`  With Dormeto  ${'█'.repeat(40)}  $13.09  131%`);
    expect(lines).toContain('  Dormeto would cost $3.09 a month more than it saves, 31% of the actual cost');
  });

  it('the JSON parses back to the estimate', () => {
    expect(JSON.parse(jsonReport(E))).toEqual(E);
  });

  it('the terminal\'s summary: the two tables of the totals, aligned as text, with borders', () => {
    const lines = summaryLines(E);
    const table = (title: string) => {
      const from = lines.indexOf(title);
      expect(from, title).toBeGreaterThan(0);
      const rows: string[] = [];
      for (let i = from + 1; i < lines.length && /^ {2}[┌│├└]/.test(lines[i]!); i += 1) rows.push(lines[i]!);
      return rows;
    };
    const cells = (rows: string[]) => rows.filter((l) => l.startsWith('  │')).map((l) => l.split('│').slice(1, -1).map((c) => c.trim()));
    const joints = (l: string) => [...l].flatMap((c, i) => ('┬┼┴│┐┤┘'.includes(c) && i > 2 ? [i] : []));
    const aligned = (rows: string[]) => {
      expect(new Set(rows.map((l) => l.length)).size).toBe(1);
      for (const l of rows) expect(joints(l)).toEqual(joints(rows[1]!));
    };
    const accounts = table('By account:');
    // Borders: around the table, under the heading, above the total.
    expect(accounts.map((l) => l[2])).toEqual(['┌', '│', '├', '│', '├', '│', '└']);
    expect(accounts[0]).toMatch(/^ {2}┌─+┬[─┬]+┐$/);
    expect(accounts[2]).toMatch(/^ {2}├─+┼[─┼]+┤$/);
    expect(accounts[6]).toMatch(/^ {2}└─+┴[─┴]+┘$/);
    expect(cells(accounts)).toEqual([
      ['Account', 'Name', 'Workloads', 'Actual monthly cost', 'Cost with Dormeto enabled', 'Savings'],
      ['111111111111', 'prod', '12', '$400.00', '$221.32', '45%'],
      ['Total', '', '12', '$400.00', '$226.58', '43%'],
    ]);
    // Aligned: every line as long, the figures right-aligned under their headings, the columns' borders in line.
    aligned(accounts);
    expect(accounts[3]!.indexOf('$221.32 │') + '$221.32'.length).toBe(accounts[1]!.indexOf('Cost with Dormeto enabled │') + 'Cost with Dormeto enabled'.length);
    expect(lines[lines.indexOf(accounts[6]!) + 1]).toBe('  Cost with Dormeto enabled: at a 1-hour idle window, Dormeto\'s cost included; the total includes the manager ($5.00), once per installation.');
    const cost = table('Dormeto\'s cost:');
    // A rule under the heading, above Dormeto's cost, above the actual cost, above the cost with Dormeto applied.
    expect(cost.map((l) => l[2])).toEqual(['┌', '│', '├', '│', '│', '│', '├', '│', '├', '│', '│', '├', '│', '└']);
    expect(cells(cost)).toEqual([
      ['Part', 'Computation', 'A month'],
      ['Manager', '1 × $5.00: one per installation, whatever the number of accounts and workloads', '$5.00'],
      ['Routers', '2 × $0.26: one per account and region with workloads (111111111111 eu-west-1, 111111111111 eu-west-3)', '$0.52'],
      ['Workloads', '12 × $0.13: each workload\'s naps, wakes and idle checks', '$1.56'],
      ['Dormeto\'s cost', '', '$7.08'],
      ['Actual cost', 'what naps would stop in the 12 workloads, running 24/7', '$400.00'],
      ['Savings', 'at a 1-hour idle window', '-$180.50'],
      ['Cost with Dormeto applied', '$400.00 - $180.50 + $7.08', '$226.58'],
    ]);
    aligned(cost);
  });

  it('the terminal\'s accounts: the ten saving the most, the others counted', () => {
    const byAccount = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`1000000000${String(i).padStart(2, '0')}`, { workloads: 1, actualMonth: 2 * i, usdMonthWindow: i, usdMonthRecommended: i, dormetoMonth: 0.39, withDormetoMonth: i + 0.39 }]));
    const lines = summaryLines({ ...E, byAccount });
    const from = lines.indexOf('By account:');
    expect(lines[from + 4]).toMatch(/^ {2}│ 100000000011 /);
    expect(lines.slice(from).find((l) => l.includes('100000000001'))).toBeUndefined();
    expect(lines).toContain('  And 2 more accounts: see the report.');
  });

  it('the terminal\'s summary: the totals, the ten workloads saving the most, what was left out', () => {
    const lines = summaryLines(E);
    expect(lines[0]).toBe('About $180.50 a month at a 1-hour idle window ($168.50 at the recommended windows) for 12 workloads in 2 accounts; Dormeto costs about $7.08 a month: net about $173.42.');
    const top = lines.filter((l) => l.includes('.example.com'));
    expect(top).toHaveLength(10);
    expect(top[0]).toContain('app11.example.com');
    expect(lines.join('\n')).toContain('Left out: 1 workload');
    expect(lines.join('\n')).toContain('Not reached: 1 account');
  });
});
