// Perimeter configuration: default and validation (spec section 4.4). Every error is listed at once, with its path.
import { BACKEND_KINDS, type Criterion, type DiscoveryConfig, type Filter } from './types.js';

// A new installation scans nothing until an administrator adds a filter.
export const DEFAULT_CONFIG: DiscoveryConfig = {
  version: 1,
  mode: 'organization',
  regions: ['*'],
  refreshHours: 24,
  globalExcludes: [],
  filters: [],
};

// The default of an installation outside an organization (dormeto install, account deployment) is its own account.
export const defaultConfig = (mode?: string): DiscoveryConfig => ({ ...DEFAULT_CONFIG, mode: mode === 'account' ? 'account' : 'organization' });

const MAX_FILTERS = 50;
const MAX_CRITERIA = 100;
const MAX_PATTERN = 256;
const ACCOUNT_ID = /^\d{12}$/;
const OU_ID = /^(ou-[0-9a-z]{4,32}-[0-9a-z]{8,32}|r-[0-9a-z]{4,32})$/;
// Pattern rather than a list: a region launched later must not need an engine upgrade.
const REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;
const DIMENSIONS = ['accountIds', 'ouIds', 'accountTags', 'regions', 'loadBalancers', 'hosts', 'resourceTags', 'backendKinds'] as const;
type Dimension = (typeof DIMENSIONS)[number];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function strings(value: unknown, path: string, errors: string[], check?: (s: string) => string | null): string[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${path}: at least one value`);
    return null;
  }
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string' || !v) {
      errors.push(`${path}: values are non-empty strings`);
      return null;
    }
    const problem = check?.(v);
    if (problem) {
      errors.push(`${path}: ${problem}`);
      return null;
    }
    out.push(v);
  }
  return out;
}

function tags(value: unknown, path: string, errors: string[]): Record<string, string[]> | null {
  if (!isObject(value) || Object.keys(value).length === 0) {
    errors.push(`${path}: at least one tag`);
    return null;
  }
  const out: Record<string, string[]> = {};
  for (const [key, values] of Object.entries(value)) {
    if (!key || key.length > 128) {
      errors.push(`${path}: tag keys are 1 to 128 characters`);
      return null;
    }
    if (!Array.isArray(values) || values.some((v) => typeof v !== 'string' || v.length > 256)) {
      errors.push(`${path}: tag values are a list of strings (empty for any value)`);
      return null;
    }
    out[key] = values as string[];
  }
  return out;
}

const pattern = (s: string) => (s.length > MAX_PATTERN ? `patterns are at most ${MAX_PATTERN} characters` : null);

function criterion(value: unknown, path: string, errors: string[]): Criterion | null {
  if (!isObject(value)) {
    errors.push(`${path}: must be an object`);
    return null;
  }
  const before = errors.length;
  const out: Criterion = {};
  if (value.note !== undefined) {
    if (typeof value.note !== 'string' || value.note.length > 256) errors.push(`${path}.note: at most 256 characters`);
    else out.note = value.note;
  }
  const present = (d: Dimension) => value[d] !== undefined;
  if (present('accountIds')) out.accountIds = strings(value.accountIds, `${path}.accountIds`, errors, (s) => (ACCOUNT_ID.test(s) ? null : `"${s}" is not a 12-digit account ID`)) ?? undefined;
  if (present('ouIds')) out.ouIds = strings(value.ouIds, `${path}.ouIds`, errors, (s) => (OU_ID.test(s) ? null : `"${s}" is not an OU or root ID`)) ?? undefined;
  if (present('accountTags')) out.accountTags = tags(value.accountTags, `${path}.accountTags`, errors) ?? undefined;
  if (present('regions')) out.regions = strings(value.regions, `${path}.regions`, errors, (s) => (REGION.test(s) ? null : `"${s}" is not a region name`)) ?? undefined;
  if (present('loadBalancers')) out.loadBalancers = strings(value.loadBalancers, `${path}.loadBalancers`, errors, pattern) ?? undefined;
  if (present('hosts')) out.hosts = strings(value.hosts, `${path}.hosts`, errors, pattern) ?? undefined;
  if (present('resourceTags')) out.resourceTags = tags(value.resourceTags, `${path}.resourceTags`, errors) ?? undefined;
  if (present('backendKinds')) {
    const kinds = strings(value.backendKinds, `${path}.backendKinds`, errors, (s) => ((BACKEND_KINDS as readonly string[]).includes(s) ? null : `"${s}" is not one of ${BACKEND_KINDS.join(', ')}`));
    if (kinds) out.backendKinds = kinds as Criterion['backendKinds'];
  }
  for (const key of Object.keys(value)) {
    if (key !== 'note' && !(DIMENSIONS as readonly string[]).includes(key)) errors.push(`${path}: unknown dimension "${key}"`);
  }
  return errors.length === before ? out : null;
}

function criteria(value: unknown, path: string, errors: string[], { required }: { required: boolean }): Criterion[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value)) {
    errors.push(`${path}: must be a list`);
    return [];
  }
  if (required && value.length === 0) errors.push(`${path}: at least one include criterion`);
  return value.map((c, i) => criterion(c, `${path}[${i}]`, errors)).filter((c): c is Criterion => c !== null);
}

export function validateConfig(input: unknown): { config: DiscoveryConfig | null; errors: string[] } {
  if (!isObject(input)) return { config: null, errors: ['configuration: must be an object'] };
  const errors: string[] = [];
  if (input.version !== 1) errors.push('version: must be 1');
  if (input.mode !== 'organization' && input.mode !== 'account') errors.push('mode: must be "organization" or "account"');
  let regions: string[] = [];
  if (Array.isArray(input.regions) && input.regions.length === 1 && input.regions[0] === '*') regions = ['*'];
  else regions = strings(input.regions, 'regions', errors, (s) => (REGION.test(s) ? null : `"${s}" is not a region name`)) ?? [];
  const refreshHours = input.refreshHours;
  if (typeof refreshHours !== 'number' || !Number.isInteger(refreshHours) || refreshHours < 1 || refreshHours > 168) {
    errors.push('refreshHours: must be an integer from 1 to 168');
  }
  const globalExcludes = criteria(input.globalExcludes ?? [], 'globalExcludes', errors, { required: false });

  const filters: Filter[] = [];
  if (!Array.isArray(input.filters)) errors.push('filters: must be a list');
  else {
    if (input.filters.length > MAX_FILTERS) errors.push(`filters: at most ${MAX_FILTERS} filters`);
    const names = new Set<string>();
    input.filters.forEach((f, i) => {
      const path = `filters[${i}]`;
      if (!isObject(f)) {
        errors.push(`${path}: must be an object`);
        return;
      }
      const name = typeof f.name === 'string' ? f.name.trim() : '';
      if (!name || name.length > 64) errors.push(`${path}.name: required, at most 64 characters`);
      else if (names.has(name)) errors.push(`${path}: duplicate filter name "${name}"`);
      names.add(name);
      const include = criteria(f.include, `${path}.include`, errors, { required: true });
      const exclude = criteria(f.exclude, `${path}.exclude`, errors, { required: false });
      filters.push({ name, include, exclude });
    });
  }
  const total = globalExcludes.length + filters.reduce((n, f) => n + f.include.length + f.exclude.length, 0);
  if (total > MAX_CRITERIA) errors.push(`at most ${MAX_CRITERIA} criteria in total`);

  let eventRefresh: DiscoveryConfig['eventRefresh'];
  if (input.eventRefresh !== undefined) {
    const e = input.eventRefresh;
    if (!isObject(e)) errors.push('eventRefresh: must be an object');
    else {
      if (typeof e.enabled !== 'boolean') errors.push('eventRefresh.enabled: must be true or false');
      const accounts = e.accounts === undefined ? undefined : strings(e.accounts, 'eventRefresh.accounts', errors, (s) => (ACCOUNT_ID.test(s) ? null : `"${s}" is not an account id`));
      eventRefresh = { enabled: e.enabled === true, ...(accounts ? { accounts } : {}) };
    }
  }

  if (errors.length) return { config: null, errors };
  return { config: { version: 1, mode: input.mode as DiscoveryConfig['mode'], regions, refreshHours: refreshHours as number, globalExcludes, filters, ...(eventRefresh ? { eventRefresh } : {}) }, errors };
}
