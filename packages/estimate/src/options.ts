// The estimate command's options (vision docs/specs/2026-10-10-savings-estimate-design.md §3): an AWS profile, the
// regions, the role assumed in member accounts, the savings' baseline and discounts as the manager's, the cache to
// refresh, where the reports go.
import type { Baseline, Discounts } from '@dormeto/fleet';

export interface Options {
  profile: string;
  regions: string[] | null;
  role: string;
  baseline: Baseline;
  discounts: Discounts;
  refresh: 'discovery' | 'metrics' | null;
  out: string;
}

export class UsageError extends Error {}

export const USAGE = `Usage: npm run estimate -- --profile <profile> [--regions eu-west-1,eu-west-3] [--role <name>]
  [--baseline always|business-hours] [--timezone Europe/Paris] [--discount-compute 0-90] [--discount-databases 0-90]
  [--refresh discovery|metrics] [--out <dir>]`;

// Accounts created by AWS Organizations have it; the role is supposed to be there (decision 4).
const DEFAULT_ROLE = 'OrganizationAccountAccessRole';
const REGION = /^[a-z]{2}(-[a-z]+)+-\d+$/;
const NAMES = ['profile', 'regions', 'role', 'baseline', 'timezone', 'discount-compute', 'discount-databases', 'refresh', 'out'];

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
  return {
    profile, regions, role: given.get('role') ?? DEFAULT_ROLE,
    baseline: kind === 'always' ? { kind } : { kind, timeZone },
    discounts: { compute: percent('discount-compute', given.get('discount-compute')), databases: percent('discount-databases', given.get('discount-databases')) },
    refresh, out: given.get('out') ?? process.cwd(),
  };
}
