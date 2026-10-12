// The estimate command's options (vision docs/specs/2026-10-10-savings-estimate-design.md §3): an AWS profile, the
// accounts it is restricted to, the regions, the role assumed in member accounts, the savings' baseline and discounts as the manager's, the cache to
// refresh, where the reports go.
import type { Baseline, Discounts } from '@dormeto/fleet';

export interface Options {
  profile: string;
  // The organization's accounts the estimate is restricted to (--accounts): every account reached when null.
  accounts: string[] | null;
  regions: string[] | null;
  role: string;
  baseline: Baseline;
  discounts: Discounts;
  refresh: 'discovery' | 'metrics' | null;
  out: string;
  // The idle window the report's figures use (the recommended windows besides): an hour by default.
  window: number;
}

export class UsageError extends Error {}

export const USAGE = `Usage: npm run estimate -- --profile <profile> [--accounts 111111111111,222222222222]
  [--regions eu-west-1,eu-west-3] [--role <name>]
  [--baseline always|business-hours] [--timezone Europe/Paris] [--discount-compute 0-90] [--discount-databases 0-90]
  [--refresh discovery|metrics] [--window 60] [--out <dir>]`;

// Accounts created by AWS Organizations have it; the role is supposed to be there (decision 4).
const DEFAULT_ROLE = 'OrganizationAccountAccessRole';
const REGION = /^[a-z]{2}(-[a-z]+)+-\d+$/;
const ACCOUNT = /^\d{12}$/;
const NAMES = ['profile', 'accounts', 'regions', 'role', 'baseline', 'timezone', 'discount-compute', 'discount-databases', 'refresh', 'out', 'window'];
// The router's limits of idleMinutes.
const WINDOW = { min: 5, max: 1440, default: 60 };

const percent = (name: string, value: string | undefined) => {
  if (value === undefined) return 0;
  const n = Number(value);
  if (!/^\d+$/.test(value) || n > 90) throw new UsageError(`--${name}: a whole number from 0 to 90`);
  return n;
};

export function parseOptions(argv: string[]): Options {
  const given = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const name = arg.startsWith('--') ? arg.slice(2) : '';
    if (!NAMES.includes(name)) throw new UsageError(`unknown option: ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`--${name} needs a value`);
    given.set(name, value);
    i += 1;
  }
  const profile = given.get('profile');
  if (!profile) throw new UsageError('--profile is required');
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
    profile, accounts, regions, role: given.get('role') ?? DEFAULT_ROLE,
    baseline: kind === 'always' ? { kind } : { kind, timeZone },
    discounts: { compute: percent('discount-compute', given.get('discount-compute')), databases: percent('discount-databases', given.get('discount-databases')) },
    refresh, out: given.get('out') ?? process.cwd(), window,
  };
}
