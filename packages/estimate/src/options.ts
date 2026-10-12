// The estimate command's options (vision docs/specs/2026-10-10-savings-estimate-design.md §3): the AWS profiles, the
// accounts it is restricted to, the regions, the tags of the workloads it leaves out, the role assumed in member accounts, the savings' baseline and discounts as the manager's, the cache to
// refresh, where the reports go.
import type { Baseline, Discounts } from '@dormeto/fleet';

export interface Options {
  // One AWS profile or more, such as one SSO profile per account: the accounts each reaches, merged.
  profiles: string[];
  // The organization's accounts the estimate is restricted to (--accounts): every account reached when null.
  accounts: string[] | null;
  regions: string[] | null;
  // Workloads left out by their tags (--exclude-tags, repeated): any criterion excludes; in one, every key (and), each
  // with one of its values ([] = any value), as discovery's resourceTags.
  excludeTags: Record<string, string[]>[];
  role: string;
  baseline: Baseline;
  discounts: Discounts;
  refresh: 'discovery' | 'metrics' | null;
  out: string;
  // The idle window the report's figures use (the recommended windows besides): an hour by default.
  window: number;
}

export class UsageError extends Error {}

export const USAGE = `Usage: npm run estimate -- --profile <profile>[,<profile>...] [--accounts 111111111111,222222222222]
  [--regions eu-west-1,eu-west-3] [--exclude-tags 'env=dev|test,team=web' ...] [--role <name>]
  [--baseline always|business-hours] [--timezone Europe/Paris] [--discount-compute 0-90] [--discount-databases 0-90]
  [--refresh discovery|metrics] [--window 60] [--out <dir>]`;

// Accounts created by AWS Organizations have it; the role is supposed to be there (decision 4).
const DEFAULT_ROLE = 'OrganizationAccountAccessRole';
const REGION = /^[a-z]{2}(-[a-z]+)+-\d+$/;
const ACCOUNT = /^\d{12}$/;
const NAMES = ['profile', 'accounts', 'regions', 'exclude-tags', 'role', 'baseline', 'timezone', 'discount-compute', 'discount-databases', 'refresh', 'out', 'window'];
// The router's limits of idleMinutes.
const WINDOW = { min: 5, max: 1440, default: 60 };

const percent = (name: string, value: string | undefined) => {
  if (value === undefined) return 0;
  const n = Number(value);
  if (!/^\d+$/.test(value) || n > 90) throw new UsageError(`--${name}: a whole number from 0 to 90`);
  return n;
};

// One --exclude-tags: key=value|value or key alone, comma-separated.
function tagCriterion(value: string): Record<string, string[]> {
  const terms = value.split(',').map((t) => t.trim()).filter(Boolean);
  if (!terms.length) throw new UsageError('--exclude-tags: one tag or more, such as env=dev|test,team=web');
  const criterion: Record<string, string[]> = {};
  for (const term of terms) {
    const at = term.indexOf('=');
    const key = (at < 0 ? term : term.slice(0, at)).trim();
    if (!key) throw new UsageError(`--exclude-tags: a tag without its key: ${term}`);
    if (Object.hasOwn(criterion, key)) throw new UsageError(`--exclude-tags: ${key} twice in one criterion: ${key}=${[...criterion[key]!, ...term.slice(at + 1).split('|')].map((v) => v.trim()).join('|')} for either`);
    criterion[key] = at < 0 ? [] : term.slice(at + 1).split('|').map((v) => v.trim());
  }
  return criterion;
}

export function parseOptions(argv: string[]): Options {
  const given = new Map<string, string>();
  const excludeTags: Record<string, string[]>[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const name = arg.startsWith('--') ? arg.slice(2) : '';
    if (!NAMES.includes(name)) throw new UsageError(`unknown option: ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`--${name} needs a value`);
    if (name === 'exclude-tags') excludeTags.push(tagCriterion(value));
    else given.set(name, value);
    i += 1;
  }
  if (!given.has('profile')) throw new UsageError('--profile is required');
  const profiles = [...new Set(given.get('profile')!.split(',').map((p) => p.trim()).filter(Boolean))];
  if (!profiles.length) throw new UsageError('--profile: one AWS profile or more, such as qal,prod');
  let accounts: string[] | null = null;
  if (given.has('accounts')) {
    accounts = [...new Set(given.get('accounts')!.split(',').map((a) => a.trim()).filter(Boolean))];
    if (!accounts.length) throw new UsageError('--accounts: one AWS account id or more, such as 111111111111,222222222222');
    const bad = accounts.find((a) => !ACCOUNT.test(a));
    if (bad) throw new UsageError(`--accounts: not an AWS account id: ${bad}`);
  }
  let regions: string[] | null = null;
  if (given.has('regions')) {
    regions = given.get('regions')!.split(',').map((r) => r.trim()).filter(Boolean);
    if (!regions.length) throw new UsageError('--regions: one region or more, such as eu-west-1,us-east-1');
    const bad = regions.find((r) => !REGION.test(r));
    if (bad) throw new UsageError(`--regions: unknown region ${bad}`);
  }
  const kind = given.get('baseline') ?? 'always';
  if (kind !== 'always' && kind !== 'business-hours') throw new UsageError('--baseline: always or business-hours');
  const timeZone = given.get('timezone') ?? 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new UsageError(`--timezone: unknown time zone ${timeZone}`);
  }
  const refresh = given.get('refresh') ?? null;
  if (refresh !== null && refresh !== 'discovery' && refresh !== 'metrics') throw new UsageError('--refresh: discovery or metrics');
  const window = given.has('window') ? Number(given.get('window')) : WINDOW.default;
  if (!/^\d+$/.test(given.get('window') ?? String(WINDOW.default)) || window < WINDOW.min || window > WINDOW.max) throw new UsageError(`--window: whole minutes from ${WINDOW.min} to ${WINDOW.max}`);
  return {
    profiles, accounts, regions, excludeTags, role: given.get('role') ?? DEFAULT_ROLE,
    baseline: kind === 'always' ? { kind } : { kind, timeZone },
    discounts: { compute: percent('discount-compute', given.get('discount-compute')), databases: percent('discount-databases', given.get('discount-databases')) },
    refresh, out: given.get('out') ?? process.cwd(), window,
  };
}
