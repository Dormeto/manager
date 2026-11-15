// One model for both clouds (Google Cloud design §3): `account` is the AWS account or the Google Cloud project, so
// every key keeps its shape and the cloud is read from the account, never stored. The patterns of both clouds live here.
export type Cloud = 'aws' | 'gcp';

// The router version the manager needs on Google Cloud to call it (/v1/actions): the manager's calls and
// the dashboard's Routers view both read this floor. Declared again as ROUTER_MINIMUM in @dormeto/google, whose transport
// names it when a router has no /v1/actions (it can't import this package): packages/fleet/test/router-minimum.test.ts pins
// the two equal.
export const GOOGLE_ROUTER_MINIMUM = '0.40.0';

// The router version a Google Cloud router reports from (router push design 2026-11-14 §4, §6.4): one below it is still called
// by the manager, but sends no event: the watchdog says it too old, with the command that upgrades it.
export const GOOGLE_REPORT_MINIMUM = '0.41.0';

// A known version below a floor, by major.minor.patch alone (a dev router's 0.40.0-dev.1 meets 0.40.0, 0.39.0-dev.3 doesn't;
// the registry keeps the version as the router reports it); an unknown one ('' or not a version) is called, and its answer
// says.
function below(version: string, minimum: string): boolean {
  const v = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!v) return false;
  const floor = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (Number(v[i + 1]) !== floor[i]) return Number(v[i + 1]) < floor[i]!;
  return false;
}
// A Google Cloud router too old for the manager's calls.
export const routerTooOld = (version: string): boolean => below(version, GOOGLE_ROUTER_MINIMUM);
// A Google Cloud router too old to report to the manager.
export const reportsTooOld = (version: string): boolean => below(version, GOOGLE_REPORT_MINIMUM);
// The command that installs or upgrades a Google Cloud router (the CLI's: the manager never does), as the API, the operations,
// the watchdog's probe and the dashboard name it. The version named is the pinned one, never below the floor (the calls', or
// the reports' for a router too old to report; a dev release pins the AWS router's).
export const installCommand = (project: string, region: string, pinned?: string | null, floor: string = GOOGLE_ROUTER_MINIMUM): string =>
  `dormeto gcp routers install --project ${project} --region ${region}${pinned ? ` --version ${below(pinned, floor) ? floor : pinned}` : ''}`;
// A router too old for the manager, and the command that fixes it; version: '' when it is unknown (the router answered that
// it has no /v1/actions).
export const tooOldText = (version: string, project: string, region: string, pinned: string | undefined, floor: string = GOOGLE_ROUTER_MINIMUM): string =>
  `router ${version || `older than ${floor}`} can't report to the manager: ${installCommand(project, region, pinned, floor)}`;

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

// A Google Cloud router's source on the manager's bus (router credentials design 2026-11-15 §3, §4): its session puts this
// source alone, and the fleet function reads the router's project and region from it, never from the detail.
export const GOOGLE_SOURCE_PREFIX = 'dormeto.router.gcp/';
export const googleSourceOf = (project: string, region: string): string => `${GOOGLE_SOURCE_PREFIX}${project}/${region}`;
// The project and region of such a source, null unless it is exactly the prefix, a project ID and a Google Cloud region.
export function googleSourceParts(source: unknown): { project: string; region: string } | null {
  if (typeof source !== 'string' || !source.startsWith(GOOGLE_SOURCE_PREFIX)) return null;
  const parts = source.slice(GOOGLE_SOURCE_PREFIX.length).split('/');
  return parts.length === 2 && isProject(parts[0]) && isRegion('gcp', parts[1]) ? { project: parts[0], region: parts[1] } : null;
}

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
