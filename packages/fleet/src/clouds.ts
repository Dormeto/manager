// One model for both clouds (Google Cloud design §3): `account` is the AWS account or the Google Cloud project, so
// every key keeps its shape and the cloud is read from the account, never stored. The patterns of both clouds live here.
export type Cloud = 'aws' | 'gcp';

// The router version the manager needs on Google Cloud (/v1/actions, the journal, the check summary): the manager's calls and
// the dashboard's Routers view both read this floor.
export const GOOGLE_ROUTER_MINIMUM = '0.40.0';

const ACCOUNT = /^\d{12}$/;
// A project ID: 6 to 30 characters, lowercase letters, digits and hyphens, starting with a letter, not ending with a hyphen.
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
// Patterns rather than lists: a region launched later must not need an engine upgrade.
const REGIONS: Record<Cloud, RegExp> = {
  aws: /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/,
  gcp: /^[a-z]+-[a-z]+\d{1,2}$/,
};

export const isAccount = (s: unknown): s is string => typeof s === 'string' && ACCOUNT.test(s);
export const isProject = (s: unknown): s is string => typeof s === 'string' && PROJECT.test(s);
export const cloudOf = (account: string): Cloud | null => (isAccount(account) ? 'aws' : isProject(account) ? 'gcp' : null);
export const isRegion = (cloud: Cloud, s: unknown): s is string => typeof s === 'string' && REGIONS[cloud].test(s);
// A candidate's region: a Google Cloud global load balancer's is `global`.
export const isCandidateRegion = (cloud: Cloud, s: unknown): s is string => isRegion(cloud, s) || (cloud === 'gcp' && s === 'global');

// The minutes of a five-field schedule that runs every N minutes (`*/N * * * *`, a Google Cloud router's Scheduler job).
export function fiveFieldMinutes(cron: string | null | undefined): number | null {
  const m = /^\*\/(\d+) \* \* \* \*$/.exec(cron ?? '');
  return m && Number(m[1]) > 0 ? Number(m[1]) : null;
}

// A Google Cloud path of a backend service or a URL map, as the manager names them: `projects/<project>/global/<kind>/<name>`
// or `projects/<project>/regions/<region>/<kind>/<name>`. One reader for the API, discovery and the operations.
const GOOGLE_NAME = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;
export interface GooglePath {
  project: string;
  region: string; // `global` or the region
  kind: 'backendServices' | 'urlMaps';
  name: string;
}
export function googlePath(s: unknown): GooglePath | null {
  if (typeof s !== 'string') return null;
  const parts = s.split('/');
  if (parts[0] !== 'projects') return null;
  const [, project, scope, ...rest] = parts;
  let region: string;
  let tail: string[];
  if (scope === 'global') {
    region = 'global';
    tail = rest;
  } else if (scope === 'regions' && isRegion('gcp', rest[0])) {
    region = rest[0]!;
    tail = rest.slice(1);
  } else return null;
  const [kind, name] = tail;
  if (tail.length !== 2 || !isProject(project) || (kind !== 'backendServices' && kind !== 'urlMaps') || !GOOGLE_NAME.test(name!)) return null;
  return { project, region, kind, name: name! };
}

// The scope of a Google Cloud workload's backend services and URL map, from its row's load balancer: a regional or internal
// one's in its region (else the router's), the others' (global, classic, cross-region internal, or none) global.
export const googleScopeOf = (lb: { kind?: string; region?: string } | undefined, region: string): string => (lb?.kind === 'regional' || lb?.kind === 'internal' ? `regions/${lb.region ?? region}` : 'global');
// The path of a backend service or a URL map a row names by name (a path is kept as it is), in the scope of its load balancer.
export const googleServicePath = (project: string, collection: 'backendServices' | 'urlMaps', value: string, lb: { kind?: string; region?: string } | undefined, region: string): string => (
  value.startsWith('projects/') ? value : `projects/${project}/${googleScopeOf(lb, region)}/${collection}/${value}`);
