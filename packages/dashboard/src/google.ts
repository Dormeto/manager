// Google Cloud in the dashboard: the console's pages for a router's controller and a workload's resources (from their resource
// paths, `projects/<project>/zones/<zone>/instances/<name>`), and the CLI commands that install and uninstall a router, which
// the manager never does itself.
const CONSOLE = 'https://console.cloud.google.com';
const part = encodeURIComponent;
const withProject = (project: string) => `?project=${part(project)}`;

// The last segment of a resource path: the name Google Cloud shows.
export const resourceName = (path: string): string => path.split('/').at(-1) ?? path;

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
export const installCommand = (project: string, region: string, version?: string | null): string =>
  `dormeto gcp install --project ${project} --region ${region}${version ? ` --version ${version}` : ''}`;
export const uninstallCommand = (project: string, region: string): string => `dormeto gcp uninstall --project ${project} --region ${region}`;
