// The estimate's reports (vision docs/specs/2026-10-10-savings-estimate-design.md §8): a Markdown readable as it is (to
// paste into a proposal), a JSON with every figure, and the terminal's summary.
import type { Estimate, Totals } from './estimate.js';

const usd = (v: number) => v.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const n = (v: number, one: string, many = `${one}s`) => `${v} ${v === 1 ? one : many}`;
const day = (v: number) => (Math.round(v * 10) / 10).toString();
const cell = (s: string) => s.replace(/\|/g, '\\|');
const net = (t: Totals) => t.usdMonth15 - t.dormetoMonth;
const target = (e: Estimate) => (e.organization ? `Organization ${e.organization}, ${n(e.accounts, 'account')}` : `Account ${e.workloads[0]?.workload.account ?? ''}`.trim());

export function summaryLines(e: Estimate): string[] {
  const t = e.totals;
  const lines = [
    `About ${usd(t.usdMonth15)} a month at a 15-minute idle window (${usd(t.usdMonthRecommended)} at the recommended windows) for ${n(t.workloads, 'workload')} in ${n(e.accounts, 'account')}; Dormeto costs about ${usd(t.dormetoMonth)} a month: net about ${usd(net(t))}.`,
  ];
  if (e.why) lines.push(e.why);
  const top = [...e.workloads].sort((a, b) => b.at15.usdMonth - a.at15.usdMonth).slice(0, 10);
  if (top.length) {
    lines.push('Workloads that would save the most:');
    for (const x of top) {
      const w = x.workload;
      lines.push(`  ${usd(x.at15.usdMonth).padStart(10)}  ${w.hosts[0] ?? w.targetGroup} (${w.loadBalancer}, ${w.region}, ${w.account})${x.quiet ? ', no request in 14 days' : ''}; recommended ${x.recommended.minutes} min: ${usd(x.recommended.usdMonth)}`);
    }
  }
  if (e.leftOut.length) lines.push(`Left out: ${n(e.leftOut.length, 'workload')} (see the report for why)`);
  if (e.unreachable.length) lines.push(`Not reached: ${n(e.unreachable.length, 'account')} (see the report for how to include them)`);
  if (e.failedRegions.length) lines.push(`Regions that failed: ${e.failedRegions.map((r) => `${r.account}/${r.region}`).join(', ')}`);
  return lines;
}

const totalsRow = (label: string, t: Totals) => `| ${label} | ${t.workloads} | ${usd(t.usdMonth15)} | ${usd(t.usdMonthRecommended)} | ${usd(t.dormetoMonth)} |`;

export function markdownReport(e: Estimate): string {
  const t = e.totals;
  const o = e.options;
  const out = [
    '# Dormeto savings estimate', '',
    `${target(e)}, estimated ${e.generatedAt.slice(0, 16).replace('T', ' ')} UTC from the last 14 days of requests.`, '',
    ...(e.why ? [`> ${e.why}`, ''] : []),
    '## Totals', '',
    `Dormeto would save about **${usd(t.usdMonth15)} a month** with its default 15-minute idle window (${usd(t.usdMonthRecommended)} with each workload's recommended window), for ${n(t.workloads, 'workload')}. Dormeto itself costs about ${usd(t.dormetoMonth)} a month: **net about ${usd(net(t))}**.`, '',
    '### By account', '',
    '| Account | Workloads | At 15 minutes | At the recommended windows | Dormeto |', '|---|---|---|---|---|',
    ...Object.entries(e.byAccount).map(([account, a]) => totalsRow(account, a)), '',
    '### By region', '',
    '| Region | Workloads | At 15 minutes | At the recommended windows | Dormeto |', '|---|---|---|---|---|',
    ...Object.entries(e.byRegion).map(([region, r]) => totalsRow(region, r)), '',
    '## Workloads', '',
    '| Account | Region | Load balancer | Hosts | Backend | At 15 minutes | Wakes a day | Recommended | Saving | Wakes a day |', '|---|---|---|---|---|---|---|---|---|---|',
    ...[...e.workloads].sort((a, b) => b.at15.usdMonth - a.at15.usdMonth).map((x) => {
      const w = x.workload;
      const hosts = `${w.hosts.join(', ') || w.targetGroup}${x.quiet ? ' (no request in 14 days)' : ''}${w.managed ? ' (managed by Dormeto)' : ''}`;
      return `| ${w.account} | ${w.region} | ${cell(w.loadBalancer)} | ${cell(hosts)} | ${w.backend.kind} ${cell(w.backend.id.split('/').at(-1) ?? w.backend.id)} | ${usd(x.at15.usdMonth)} | ${day(x.at15.wakesPerDay)} | ${x.recommended.minutes} min | ${usd(x.recommended.usdMonth)} | ${day(x.recommended.wakesPerDay)} |`;
    }), '',
    '## Left out', '',
    ...(e.leftOut.length
      ? ['| Account | Region | Load balancer | Target group | Why |', '|---|---|---|---|---|', ...e.leftOut.map((l) => `| ${l.workload.account} | ${l.workload.region} | ${cell(l.workload.loadBalancer)} | ${cell(l.workload.targetGroup)} | ${cell(l.reason)} |`)]
      : ['None.']), '',
    '## Not eligible', '',
    ...(e.ineligible.length
      ? ['| Account | Region | Load balancer | Target group | Why |', '|---|---|---|---|---|', ...e.ineligible.map((i) => `| ${i.account} | ${i.region} | ${cell(i.loadBalancer)} | ${cell(i.targetGroup ?? '')} | ${cell(i.reason)} |`)]
      : ['None.']), '',
    '## Accounts not reached', '',
    ...(e.unreachable.length
      ? ['| Account | Name | Why | To include it |', '|---|---|---|---|', ...e.unreachable.map((u) => `| ${u.account} | ${cell(u.name)} | ${cell(u.reason)} | ${cell(u.fix)} |`)]
      : ['None.']), '',
    '## Regions that failed', '',
    ...(e.failedRegions.length ? e.failedRegions.map((r) => `- ${r.account} ${r.region}: ${r.error}`) : ['None.']), '',
    '## Options', '',
    `- Regions: ${o.regions ? o.regions.join(', ') : 'each account\'s enabled regions'}`,
    `- Role in member accounts: ${o.role}`,
    `- Baseline: ${o.baseline.kind === 'always' ? '24/7' : `business hours, ${o.baseline.timeZone}`}`,
    `- Discounts: compute ${o.discounts.compute}%, databases ${o.discounts.databases}%`, '',
    '## Assumptions', '',
    ...e.assumptions.map((a) => `- ${a}`), '',
  ];
  return out.join('\n');
}

export const jsonReport = (e: Estimate): string => `${JSON.stringify(e, null, 2)}\n`;
