// The estimate's reports (vision docs/specs/2026-10-10-savings-estimate-design.md §8): a Markdown readable as it is (to
// paste into a proposal), a JSON with every figure, and the terminal's summary.
import type { Estimate, Totals } from './estimate.js';

const usd = (v: number) => v.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const n = (v: number, one: string, many = `${one}s`) => `${v} ${v === 1 ? one : many}`;
const day = (v: number) => (Math.round(v * 10) / 10).toString();
const cell = (s: string) => s.replace(/\|/g, '\\|');
const net = (t: Totals) => t.usdMonthWindow - t.dormetoMonth;
// The report's window in words: "1-hour" or "15-minute" before a noun, "1 hour" or "15 minutes" alone.
const hours = (m: number) => m % 60 === 0;
const windowAdjective = (m: number) => (hours(m) ? `${m / 60}-hour` : `${m}-minute`);
const windowWords = (m: number) => (hours(m) ? n(m / 60, 'hour') : n(m, 'minute'));
// Restricted by --accounts: how many of the organization's accounts.
const restricted = (e: Estimate) => Boolean(e.organization && e.options.accounts);
const target = (e: Estimate) => (e.organization
  ? `Organization ${e.organization}, ${restricted(e) ? `${e.accounts} of its ${n(e.accountsListed, 'account')} (--accounts)` : n(e.accounts, 'account')}`
  : `Account ${e.workloads[0]?.workload.account ?? ''}`.trim());

export function summaryLines(e: Estimate): string[] {
  const t = e.totals;
  const lines = [
    `About ${usd(t.usdMonthWindow)} a month at a ${windowAdjective(e.options.window)} idle window (${usd(t.usdMonthRecommended)} at the recommended windows) for ${n(t.workloads, 'workload')} in ${restricted(e) ? `${e.accounts} of the organization's ${n(e.accountsListed, 'account')}` : n(e.accounts, 'account')}; Dormeto costs about ${usd(t.dormetoMonth)} a month: net about ${usd(net(t))}.`,
  ];
  if (e.why) lines.push(e.why);
  if (t.workloads) {
    const accounts = accountsTable(e, TERMINAL_ACCOUNTS);
    lines.push('', 'By account:', ...textTable(accounts));
    if (accounts.more) lines.push(`  And ${n(accounts.more, 'more account')}: see the report.`);
    lines.push('', 'Dormeto\'s cost:', ...textTable(costTable(e)), '');
  }
  const top = [...e.workloads].sort((a, b) => b.atWindow.usdMonth - a.atWindow.usdMonth).slice(0, 10);
  if (top.length) {
    lines.push('Workloads that would save the most:');
    for (const x of top) {
      const w = x.workload;
      lines.push(`  ${usd(x.atWindow.usdMonth).padStart(10)}  ${w.hosts[0] ?? w.targetGroup} (${w.loadBalancer}, ${w.region}, ${w.account})${x.quiet ? ', no request in 14 days' : ''}; recommended ${x.recommended.minutes} min: ${usd(x.recommended.usdMonth)}`);
    }
  }
  if (e.leftOut.length) lines.push(`Left out: ${n(e.leftOut.length, 'workload')} (see the report for why)`);
  if (e.unreachable.length) lines.push(`Not reached: ${n(e.unreachable.length, 'account')} (see the report for how to include them)`);
  if (e.failedRegions.length) lines.push(`Regions that failed: ${e.failedRegions.map((r) => `${r.account}/${r.region}`).join(', ')}`);
  return lines;
}

// A table of the totals, as Markdown in the report and as aligned text in the terminal: its heading, which columns are
// figures (right-aligned as text), its rows, its total row and a note.
interface Table { head: string[]; figures: boolean[]; rows: string[][]; total: string[]; note: string | null }

const markdownTable = (t: Table) => {
  const row = (cells: string[]) => `|${cells.map((c) => (c ? ` ${c} ` : ' ')).join('|')}|`;
  return [
    row(t.head), `|${t.head.map(() => '---').join('|')}|`, ...t.rows.map((r) => row(r.map(cell))),
    row(t.total.map((c) => (c ? `**${c}**` : ''))), ...(t.note ? ['', t.note] : []),
  ];
};

const textTable = (t: Table) => {
  const all = [t.head, ...t.rows, t.total];
  const widths = t.head.map((_, i) => Math.max(...all.map((r) => r[i]!.length)));
  const line = (r: string[]) => `  ${r.map((c, i) => (t.figures[i] ? c.padStart(widths[i]!) : c.padEnd(widths[i]!))).join('  ')}`;
  return [...all.map(line), ...(t.note ? [`  ${t.note}`] : [])];
};

// The accounts' totals, a row each (at most `limit`, those saving the most), and the total (the manager in its
// Dormeto cost).
function accountsTable(e: Estimate, limit = Infinity): Table & { more: number } {
  const at = `At ${windowWords(e.options.window)}`;
  const name = (account: string) => (e.accountNames[account] && e.accountNames[account] !== account ? e.accountNames[account]! : '');
  const t = e.totals;
  const accounts = Object.entries(e.byAccount);
  const shown = limit < accounts.length ? [...accounts].sort((a, b) => b[1].usdMonthWindow - a[1].usdMonthWindow).slice(0, limit) : accounts;
  return {
    head: ['Account', 'Name', 'Workloads', at, 'At the recommended windows', 'Dormeto', `Net ${at.toLowerCase()}`],
    figures: [false, false, true, true, true, true, true],
    rows: shown.map(([account, a]) => [account, name(account), String(a.workloads), usd(a.usdMonthWindow), usd(a.usdMonthRecommended), usd(a.dormetoMonth), usd(net(a))]),
    total: ['Total', '', String(t.workloads), usd(t.usdMonthWindow), usd(t.usdMonthRecommended), usd(t.dormetoMonth), usd(net(t))],
    note: e.dormeto.manager.count ? `The total includes the manager (${usd(e.dormeto.manager.usdMonth)}), once per installation.` : null,
    more: accounts.length - shown.length,
  };
}

// Each account and region with a router, while they are few enough to read.
const ROUTERS_LISTED = 6;
// Dormeto's cost by part, each with its computation, and the total.
function costTable(e: Estimate): Table {
  const { manager, routers, workloads } = e.dormeto;
  const times = (p: { count: number; unitMonth: number }) => `${p.count} × ${usd(p.unitMonth)}`;
  const where = routers.where.length && routers.where.length <= ROUTERS_LISTED ? ` (${routers.where.map((w) => `${w.account} ${w.region}`).join(', ')})` : '';
  return {
    head: ['Part', 'Computation', 'A month'],
    figures: [false, false, true],
    rows: [
      ['Manager', `${times(manager)}: one per installation, whatever the number of accounts and workloads`, usd(manager.usdMonth)],
      ['Routers', `${times(routers)}: one per account and region with workloads${where}`, usd(routers.usdMonth)],
      ['Workloads', `${times(workloads)}: each workload's naps, wakes and idle checks`, usd(workloads.usdMonth)],
    ],
    total: ['Total', '', usd(e.dormeto.usdMonth)],
    note: null,
  };
}

// The terminal's accounts: those saving the most.
const TERMINAL_ACCOUNTS = 10;

export function markdownReport(e: Estimate): string {
  const t = e.totals;
  const o = e.options;
  const out = [
    '# Dormeto savings estimate', '',
    `${target(e)}, estimated ${e.generatedAt.slice(0, 16).replace('T', ' ')} UTC from the last 14 days of requests.`, '',
    ...(e.why ? [`> ${e.why}`, ''] : []),
    '## Totals', '',
    `Dormeto would save about **${usd(t.usdMonthWindow)} a month** with a ${windowAdjective(o.window)} idle window (${usd(t.usdMonthRecommended)} with each workload's recommended window), for ${n(t.workloads, 'workload')}. Dormeto itself costs about ${usd(t.dormetoMonth)} a month: **net about ${usd(net(t))}**.`, '',
    '### By account', '',
    ...markdownTable(accountsTable(e)), '',
    '### Dormeto\'s cost', '',
    ...markdownTable(costTable(e)), '',
    '## Workloads', '',
    `| Account | Region | Load balancer | Hosts | Backend | At ${windowWords(o.window)} | Wakes a day | Recommended | Saving | Wakes a day |`, '|---|---|---|---|---|---|---|---|---|---|',
    ...[...e.workloads].sort((a, b) => b.atWindow.usdMonth - a.atWindow.usdMonth).map((x) => {
      const w = x.workload;
      const hosts = `${w.hosts.join(', ') || w.targetGroup}${x.quiet ? ' (no request in 14 days)' : ''}${w.managed ? ' (managed by Dormeto)' : ''}`;
      return `| ${w.account} | ${w.region} | ${cell(w.loadBalancer)} | ${cell(hosts)} | ${w.backend.kind} ${cell(w.backend.id.split('/').at(-1) ?? w.backend.id)} | ${usd(x.atWindow.usdMonth)} | ${day(x.atWindow.wakesPerDay)} | ${x.recommended.minutes} min | ${usd(x.recommended.usdMonth)} | ${day(x.recommended.wakesPerDay)} |`;
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
    `- Accounts: ${o.accounts ? `${o.accounts.join(', ')} (--accounts)` : 'every account reached'}`,
    `- Regions: ${o.regions ? o.regions.join(', ') : 'each account\'s enabled regions'}`,
    `- Role in member accounts: ${o.role}`,
    `- Baseline: ${o.baseline.kind === 'always' ? '24/7' : `business hours, ${o.baseline.timeZone}`}`,
    `- Discounts: compute ${o.discounts.compute}%, databases ${o.discounts.databases}%`,
    `- Idle window of the figures: ${windowWords(o.window)} (the recommended windows besides)`, '',
    '## Assumptions', '',
    ...e.assumptions.map((a) => `- ${a}`), '',
  ];
  return out.join('\n');
}

export const jsonReport = (e: Estimate): string => `${JSON.stringify(e, null, 2)}\n`;
