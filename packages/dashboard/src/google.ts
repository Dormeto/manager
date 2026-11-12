import { routerTooOld } from '@dormeto/fleet/clouds';

// Google Cloud in the dashboard: the console's pages for a router's controller and a workload's resources (from their resource
// paths, `projects/<project>/zones/<zone>/instances/<name>`), and the CLI commands that install and uninstall a router, which
// the manager never does itself.
const CONSOLE = 'https://console.cloud.google.com';
const part = encodeURIComponent;

// A Google Cloud router the manager can't act through (no /v1/actions before 0.40.0): a known version below it, by
// major.minor.patch (a dev router's 0.40.0-dev.1 meets it; the API's rule), or one the API found too old; an unknown version
// is let through.
export function googleRouterTooOld(router: { version?: string | null; refusal?: string }): boolean {
  return router.refusal === 'router_too_old' || routerTooOld(router.version ?? '');
}
const withProject = (project: string) => `?project=${part(project)}`;

// The last segment of a resource path: the name Google Cloud shows.
export const resourceName = (path: string): string => path.split('/').at(-1) ?? path;

// The path of a backend service or a URL map a workload's row names by name (the router's row holds names, discovery's candidate
// paths): the global scope for a missing, `global`, `classic` or `cross-region-internal` load balancer, the load balancer's region
// (else the row's) for a `regional` or `internal` one. A path is kept as it is.
export function googleResourcePath(project: string, collection: 'backendServices' | 'urlMaps', value: string, lb: { kind: string; region?: string } | undefined, region: string): string {
  if (value.startsWith('projects/')) return value;
  return lb?.kind === 'regional' || lb?.kind === 'internal' ? `projects/${project}/regions/${lb.region ?? region}/${collection}/${value}` : `projects/${project}/global/${collection}/${value}`;
}

// `projects/<project>/(zones|regions|global)/<location>/<collection>/<name>`, or `projects/<project>/<collection>/<name>`
// (Cloud SQL's). Null for anything else.
function resourceOf(path: string): { project: string; scope: 'zones' | 'regions' | 'global' | null; location: string | null; collection: string; name: string } | null {
  const m = /^projects\/([^/]+)\/(?:(zones|regions)\/([^/]+)\/|(global)\/)?([^/]+)\/([^/]+)$/.exec(path);
  return m ? { project: m[1]!, scope: (m[2] ?? m[4] ?? null) as 'zones' | 'regions' | 'global' | null, location: m[3] ?? null, collection: m[5]!, name: m[6]! } : null;
}

// A backend's page in the console: a VM, a managed instance group (zonal or regional), a Cloud SQL instance. Null when its id is
// not a resource path, and for a Kubernetes workload (the console's page is its cluster's, which the id does not name).
export function backendConsoleUrl(backend: { kind: string; id: string }, project: string): string | null {
  const r = resourceOf(backend.id);
  if (!r) return null;
  const query = withProject(r.project || project);
  if (backend.kind === 'instance' && r.scope === 'zones' && r.collection === 'instances') return `${CONSOLE}/compute/instancesDetail/zones/${part(r.location!)}/instances/${part(r.name)}${query}`;
  if (backend.kind === 'asg' && r.location && r.collection === 'instanceGroupManagers') return `${CONSOLE}/compute/instanceGroups/details/${part(r.location)}/${part(r.name)}${query}`;
  if (backend.kind === 'cloudsql-instance' && !r.scope && r.collection === 'instances') return `${CONSOLE}/sql/instances/${part(r.name)}/overview${query}`;
  return null;
}

// The load balancer of a URL map. A regional map's detail page has a form this dashboard cannot confirm from Google's console,
// so it links the project's list of load balancers instead.
export function urlMapConsoleUrl(urlMap: string, lb: { kind: string; region?: string } | undefined, project: string): string {
  const r = resourceOf(urlMap);
  const query = withProject(r?.project || project);
  if (r && lb?.kind !== 'regional' && r.scope === 'global') return `${CONSOLE}/net-services/loadbalancing/details/http/${part(r.name)}${query}`;
  return `${CONSOLE}/net-services/loadbalancing/list/loadBalancers${query}`;
}

// A router's controller, the Cloud Run service `dmtr-<region>-controller`.
export const controllerConsoleUrl = (project: string, region: string): string => `${CONSOLE}/run/detail/${part(region)}/dmtr-${region}-controller/metrics${withProject(project)}`;

// Routers are installed, upgraded and uninstalled by the CLI, which changes the project's IAM policy through its own checks.
// The install command is the API's: the version named is the pinned one, never below the router minimum.
export { installCommand } from '@dormeto/fleet/clouds';
export const uninstallCommand = (project: string, region: string): string => `dormeto gcp routers uninstall --project ${project} --region ${region}`;

const LB_KINDS: Record<string, string> = {
  global: 'global external Application Load Balancer', classic: 'classic Application Load Balancer', regional: 'regional Application Load Balancer',
  internal: 'regional internal Application Load Balancer', 'cross-region-internal': 'cross-region internal Application Load Balancer',
};
// A load balancer's kind in words, with its region when it has one.
export const lbText = (lb: { kind: string; region?: string }): string => `${LB_KINDS[lb.kind] ?? lb.kind}${lb.region ? ` in ${lb.region}` : ''}`;
