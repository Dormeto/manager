// A project's Compute Engine as Google answers it (Compute Engine v1 reference shapes: aggregated lists by scope,
// instanceGroups.listInstances, networkEndpointGroups.get and listNetworkEndpoints), modelled on dormeto-dev's demo (router
// terraform/gcp-dev): the global URL map dmt-dev, its host gcp.dev.dormeto.com to dmt-demo-app (the unmanaged group dmt-demo
// of the VM dmt-demo) and mig.gcp.dev.dormeto.com to dmt-demo-mig-app (the zonal managed group dmt-demo-mig), in
// europe-west1-b; dmt-demo-app onboarded on the router of europe-west2, whose waker backend service
// dmtr-europe-west2-dmt-demo-app (on the router's serverless NEG dmtr-europe-west2-waker) the map's /_dormeto/* route names.
import { GoogleError } from '@dormeto/google';
import type { WorkloadSummary } from '@dormeto/fleet';

export const PROJECT = 'dormeto-dev';
// The URLs Google writes in its answers (selfLink, references); the scan calls compute.googleapis.com.
const V1 = 'https://www.googleapis.com/compute/v1';
const MONITORING = 'https://monitoring.googleapis.com/v3';
const API = 'https://compute.googleapis.com/compute/v1';
const SQLADMIN = 'https://sqladmin.googleapis.com/v1';
const RESOURCES = ['urlMaps', 'backendServices', 'targetHttpProxies', 'targetHttpsProxies', 'forwardingRules', 'instanceGroupManagers', 'instances', 'targetPools', 'targetInstances'] as const;
type Resource = (typeof RESOURCES)[number];
type Item = Record<string, unknown>;
// Scopes Google lists without anything in them: a warning, no items.
const EMPTY_SCOPES = ['regions/us-east1', 'zones/us-east1-b'];
const CREATED = '2026-10-29T08:12:41.123-07:00';

export function compute(project = PROJECT) {
  const link = (path: string) => `${V1}/projects/${project}/${path}`;
  const lists = Object.fromEntries(RESOURCES.map((r) => [r, {} as Record<string, Item[]>])) as Record<Resource, Record<string, Item[]>>;
  const groups: Record<string, string[]> = {}; // instance group path -> its VMs' URLs
  const negs: Record<string, { neg: Item; endpoints: Item[] }> = {}; // zonal NEG path
  let ids = 4_100_000_000_000_000;
  const add = (resource: Resource, scope: string, item: Item) => {
    (lists[resource][scope] ??= []).push({ id: String(ids++), creationTimestamp: CREATED, ...item });
    return item;
  };
  const scopeOf = (region?: string) => (region ? `regions/${region}` : 'global');
  const located = (region?: string) => (region ? { region: link(`regions/${region}`) } : {});
  const calls: string[] = [];
  let inFlight = 0;

  const world = {
    project,
    link,
    lists,
    calls,
    // Scopes Google could not reach: left out of every aggregated list and named in its unreachables.
    unreachable: [] as string[],
    // Aggregated lists the discovery account may not call (403: a role without the reads yet).
    refused: [] as Resource[],
    // A target pool of VMs, a target instance pointing at a VM, and a forwarding rule to either (a target-pool Network Load
    // Balancer, protocol forwarding).
    targetPool(name: string, region: string, vms: string[]) {
      add('targetPools', `regions/${region}`, { kind: 'compute#targetPool', name, region: link(`regions/${region}`), instances: vms, selfLink: link(`regions/${region}/targetPools/${name}`) });
      return link(`regions/${region}/targetPools/${name}`);
    },
    targetInstance(name: string, zone: string, vm: string) {
      add('targetInstances', `zones/${zone}`, { kind: 'compute#targetInstance', name, zone: link(`zones/${zone}`), instance: vm, selfLink: link(`zones/${zone}/targetInstances/${name}`) });
      return link(`zones/${zone}/targetInstances/${name}`);
    },
    forwardingRule(name: string, region: string, target: string) {
      add('forwardingRules', `regions/${region}`, { kind: 'compute#forwardingRule', name, region: link(`regions/${region}`), IPProtocol: 'TCP', loadBalancingScheme: 'EXTERNAL', target, selfLink: link(`regions/${region}/forwardingRules/${name}`) });
    },
    // Scopes per page of an aggregated list (absent: one page).
    pageScopes: {} as Partial<Record<Resource, number>>,
    // Compute Engine's API turned off in the project.
    disabled: false,
    delayMs: 0,
    maxInFlight: 0,
    // Cloud Monitoring's request counts (a series per backend service and URL map, per hour, as the query groups them), the
    // queries made, a refusal to answer with, and series per page (absent: one page).
    series: [] as { type: string; backend: string; urlMap: string; region?: string; hours: Record<number, string> }[],
    queries: [] as URL[],
    monitoringError: undefined as GoogleError | undefined,
    pageSeries: undefined as number | undefined,
    service: (name: string, region?: string) => link(`${scopeOf(region)}/backendServices/${name}`),
    // The standalone scan's (plan 5): Cloud SQL instances (the Cloud SQL Admin API's list and get), a refusal of its list, the
    // 5-minute points of a VM's CPU (`vm:<zone>/<name>`) or a Cloud SQL instance's connections (`db:<project>:<name>`), by point
    // start, and a refusal of those reads; the machine types with GPUs (the router reads them, the scan cannot).
    sql: [] as Item[],
    sqlError: undefined as GoogleError | undefined,
    sqlPage: undefined as number | undefined,
    points: {} as Record<string, (t: number) => number | undefined>,
    pointsError: undefined as GoogleError | undefined,
    gpuTypes: [] as string[],
    vm(name: string, zone: string, labels: Record<string, string> = {}, extra: Item = {}) {
      add('instances', `zones/${zone}`, {
        kind: 'compute#instance', name, zone: link(`zones/${zone}`), machineType: link(`zones/${zone}/machineTypes/e2-small`), status: 'RUNNING',
        labels, labelFingerprint: '42WmSpB8rSM=', selfLink: link(`zones/${zone}/instances/${name}`),
        disks: [{ type: 'PERSISTENT', boot: true }], ...extra,
      });
      return link(`zones/${zone}/instances/${name}`);
    },
    cloudSql(name: string, extra: Item = {}) {
      world.sql.push({ kind: 'sql#instance', name, project, region: 'europe-west1', databaseVersion: 'POSTGRES_16', state: 'RUNNABLE', instanceType: 'CLOUD_SQL_INSTANCE', settings: { activationPolicy: 'ALWAYS', userLabels: {} }, selfLink: `https://sqladmin.googleapis.com/v1/projects/${project}/instances/${name}`, ...extra });
    },
    // An unmanaged instance group, or a managed group's (its manager added by mig). location: a zone, or a region with regional.
    group(name: string, location: string, vms: string[], { regional = false } = {}) {
      const scope = regional ? `regions/${location}` : `zones/${location}`;
      groups[`projects/${project}/${scope}/instanceGroups/${name}`] = vms.map((vm) => link(`zones/${regional ? `${location}-b` : location}/instances/${vm}`));
      return link(`${scope}/instanceGroups/${name}`);
    },
    // Its VMs' created-by metadata names it, as Google writes it (the project's number).
    mig(name: string, location: string, vms: string[], { regional = false, extra = {} as Item } = {}) {
      const scope = regional ? `regions/${location}` : `zones/${location}`;
      add('instanceGroupManagers', scope, {
        kind: 'compute#instanceGroupManager', name, ...(regional ? { region: link(scope) } : { zone: link(scope) }),
        instanceTemplate: link(`global/instanceTemplates/${name}-20261029`), instanceGroup: link(`${scope}/instanceGroups/${name}`),
        baseInstanceName: name, targetSize: vms.length, status: { isStable: true, stateful: { hasStatefulConfig: false } }, selfLink: link(`${scope}/instanceGroupManagers/${name}`),
        ...extra,
      });
      for (const vm of Object.values(lists.instances).flat().filter((i) => vms.includes(String(i.name)))) {
        vm.metadata = { items: [{ key: 'created-by', value: `projects/123456789012/${scope}/instanceGroupManagers/${name}` }] };
      }
      return world.group(name, location, vms, { regional });
    },
    // A zonal network endpoint group, its endpoints the VMs named.
    neg(name: string, zone: string, { type = 'GCE_VM_IP_PORT', description, annotations, vms = [] }: { type?: string; description?: string; annotations?: Record<string, string>; vms?: string[] } = {}) {
      negs[`projects/${project}/zones/${zone}/networkEndpointGroups/${name}`] = {
        neg: {
          kind: 'compute#networkEndpointGroup', id: String(ids++), creationTimestamp: CREATED, name, networkEndpointType: type, size: vms.length, zone: link(`zones/${zone}`),
          network: link('global/networks/dmt-dev'), defaultPort: 80, selfLink: link(`zones/${zone}/networkEndpointGroups/${name}`),
          ...(description ? { description } : {}), ...(annotations ? { annotations } : {}),
        },
        endpoints: vms.map((vm, i) => ({ networkEndpoint: { instance: vm, ipAddress: `10.10.0.${10 + i}`, port: 80 } })),
      };
      return link(`zones/${zone}/networkEndpointGroups/${name}`);
    },
    backendService(name: string, backends: string[], { region, scheme = 'EXTERNAL_MANAGED' }: { region?: string; scheme?: string } = {}) {
      add('backendServices', scopeOf(region), {
        kind: 'compute#backendService', name, ...located(region), backends: backends.map((group) => ({ group, balancingMode: 'UTILIZATION', capacityScaler: 1 })),
        healthChecks: [link(`${scopeOf(region)}/healthChecks/dmt-demo`)], timeoutSec: 30, port: 80, protocol: 'HTTP', portName: 'app',
        loadBalancingScheme: scheme, connectionDraining: { drainingTimeoutSec: 30 }, fingerprint: 'Xh7yVq0aLoM=', selfLink: link(`${scopeOf(region)}/backendServices/${name}`),
      });
      return link(`${scopeOf(region)}/backendServices/${name}`);
    },
    urlMap(name: string, body: Item, { region }: { region?: string } = {}) {
      add('urlMaps', scopeOf(region), { kind: 'compute#urlMap', name, ...located(region), ...body, fingerprint: 'oN7cdqb7Y9s=', selfLink: link(`${scopeOf(region)}/urlMaps/${name}`) });
      return link(`${scopeOf(region)}/urlMaps/${name}`);
    },
    // A map's load balancer: its target proxy and a forwarding rule to it, of the scheme given.
    front(map: string, { region, scheme = 'EXTERNAL_MANAGED', proxy = 'https', name = map, description }: { region?: string; scheme?: string; proxy?: 'http' | 'https'; name?: string; description?: string } = {}) {
      const resource = proxy === 'https' ? 'targetHttpsProxies' : 'targetHttpProxies';
      const self = link(`${scopeOf(region)}/${resource}/${name}`);
      add(resource, scopeOf(region), {
        kind: proxy === 'https' ? 'compute#targetHttpsProxy' : 'compute#targetHttpProxy', name, ...located(region), urlMap: link(`${scopeOf(region)}/urlMaps/${map}`),
        ...(proxy === 'https' ? { sslCertificates: [link(`global/sslCertificates/${name}`)], quicOverride: 'NONE' } : {}), fingerprint: 'G7Ka0d2yb5w=', selfLink: self,
        ...(description ? { description } : {}),
      });
      add('forwardingRules', scopeOf(region), {
        kind: 'compute#forwardingRule', name, ...located(region), IPAddress: '34.111.20.30', IPProtocol: 'TCP', portRange: proxy === 'https' ? '443-443' : '80-80',
        target: self, loadBalancingScheme: scheme, networkTier: 'PREMIUM', fingerprint: 'u5mWGh4zjL8=', selfLink: link(`${scopeOf(region)}/forwardingRules/${name}`),
        ...(description ? { description } : {}),
      });
    },

    // The discovery account's Google port: Compute Engine's answers, at most `delayMs` late, and how many were in flight at once.
    async call<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
      calls.push(`${method} ${url}`);
      inFlight += 1;
      world.maxInFlight = Math.max(world.maxInFlight, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, world.delayMs));
        if (url.startsWith(MONITORING) && new URL(url).searchParams.get('aggregation.alignmentPeriod') === '300s') return points(url) as T;
        if (url.startsWith(MONITORING)) return timeSeries(url) as T;
        if (url.startsWith(SQLADMIN)) return sqlAnswer(method, url) as T;
        return answer(method, url, body) as T;
      } finally {
        inFlight -= 1;
      }
    },
  };

  // The Cloud SQL Admin API: the project's instances in pages, one by its name.
  function sqlAnswer(method: string, url: string) {
    if (world.sqlError) throw world.sqlError;
    const u = new URL(url);
    const one = /^\/v1\/projects\/[^/]+\/instances\/([^/]+)$/.exec(u.pathname);
    if (one && method === 'GET') {
      const found = world.sql.find((i) => i.name === one[1]);
      if (!found) throw Object.assign(new GoogleError({ status: 404, reason: 'instanceDoesNotExist', message: 'The Cloud SQL instance does not exist.', host: 'sqladmin.googleapis.com' }), { code: 404 });
      return found;
    }
    if (u.pathname !== `/v1/projects/${project}/instances` || method !== 'GET') throw new Error(`unexpected call ${method} ${url}`);
    const size = world.sqlPage ?? world.sql.length;
    const at = Number(u.searchParams.get('pageToken') ?? 0);
    return { kind: 'sql#instancesList', items: world.sql.slice(at, at + size), ...(at + size < world.sql.length ? { nextPageToken: String(at + size) } : {}) };
  }

  // timeSeries.list in 5-minute points (the standalone signals): the filter's metric type and its one_of or ends_with values,
  // a series each with the labels Monitoring gives (a VM's zone and instance_name, a database's database_id), aligned points
  // whose interval ends a period after the point's start.
  function points(url: string) {
    const u = new URL(url);
    world.queries.push(u);
    if (world.pointsError) throw world.pointsError;
    const q = u.searchParams;
    const filter = q.get('filter') ?? '';
    const type = /metric\.type = "([^"]+)"/.exec(filter)?.[1] ?? '';
    const start = Date.parse(q.get('interval.startTime')!);
    const end = Date.parse(q.get('interval.endTime')!);
    const values = [...(/one_of\(([^)]*)\)/.exec(filter)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    const endsWith = /ends_with\("([^"]+)"\)/.exec(filter)?.[1];
    const keys = Object.keys(world.points).filter((key) => {
      if (type.startsWith('cloudsql.')) return key.startsWith('db:') && (values.includes(key.slice(3)) || (endsWith !== undefined && key.endsWith(endsWith)));
      return key.startsWith('vm:') && values.includes(key.slice(key.indexOf('/') + 1));
    });
    const series = keys.map((key) => {
      const value = world.points[key]!;
      const pts = [];
      for (let t = start; t < end; t += 300_000) {
        const v = value(t);
        if (v !== undefined) pts.push({ interval: { startTime: new Date(t).toISOString(), endTime: new Date(t + 300_000).toISOString() }, value: { doubleValue: type.endsWith('/connections') ? undefined : v, ...(type.endsWith('/connections') ? { int64Value: String(v) } : {}) } });
      }
      const [zone, name] = key.slice(3).split('/');
      return key.startsWith('db:')
        ? { metric: { type }, resource: { type: 'cloudsql_database', labels: { database_id: key.slice(3), project_id: project } }, points: pts.reverse() }
        : { metric: { type, labels: { instance_name: name } }, resource: { type: 'gce_instance', labels: { zone, instance_id: '1', project_id: project } }, points: pts.reverse() };
    });
    return { timeSeries: series };
  }

  // timeSeries.list: the series of the metric type asked for, as the query's aggregation groups them. A series' hours are given
  // as hours before the window's end (1 = the last hour).
  function timeSeries(url: string) {
    const u = new URL(url);
    world.queries.push(u);
    if (world.monitoringError) throw world.monitoringError;
    if (u.pathname !== `/v3/projects/${project}/timeSeries`) throw new Error(`unexpected call ${url}`);
    const q = u.searchParams;
    const type = /^metric\.type = "([^"]+)"$/.exec(q.get('filter') ?? '')?.[1];
    if (!type) throw new Error(`${url}: a metric.type filter expected`);
    for (const [key, value] of Object.entries({ 'aggregation.alignmentPeriod': '3600s', 'aggregation.perSeriesAligner': 'ALIGN_SUM', 'aggregation.crossSeriesReducer': 'REDUCE_SUM' })) {
      if (q.get(key) !== value) throw new Error(`${url}: ${key}=${value} expected`);
    }
    const end = Date.parse(q.get('interval.endTime')!);
    const found = world.series.filter((s) => s.type === type);
    const size = world.pageSeries ?? found.length;
    const at = Number(q.get('pageToken') ?? 0);
    return {
      timeSeries: found.slice(at, at + size).map((s) => ({
        metric: { type }, resource: { type: 'https_lb_rule', labels: { backend_target_name: s.backend, url_map_name: s.urlMap, ...(s.region ? { region: s.region } : {}) } },
        points: Object.entries(s.hours).map(([ago, count]) => ({
          interval: { startTime: new Date(end - Number(ago) * 3_600_000).toISOString(), endTime: new Date(end - (Number(ago) - 1) * 3_600_000).toISOString() },
          value: { int64Value: count },
        })),
      })),
      ...(at + size < found.length ? { nextPageToken: String(at + size) } : {}),
    };
  }
  const notFound = (url: string) => new GoogleError({ status: 404, reason: 'notFound', message: `The resource '${url.slice(url.indexOf('projects/'))}' was not found`, host: 'compute.googleapis.com' });
  function answer(method: string, url: string, body: unknown): unknown {
    if (world.disabled) {
      throw new GoogleError({
        status: 403, reason: 'SERVICE_DISABLED', host: 'compute.googleapis.com',
        message: `Compute Engine API has not been used in project ${project} before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/compute.googleapis.com/overview?project=${project} then retry.`,
      });
    }
    const u = new URL(url);
    const base = `/compute/v1/projects/${project}/`;
    if (!url.startsWith(API) || !u.pathname.startsWith(base)) throw new Error(`unexpected call ${method} ${url}`);
    const path = u.pathname.slice(base.length);
    const aggregated = /^aggregated\/(\w+)$/.exec(path);
    if (aggregated && method === 'GET') {
      const resource = aggregated[1] as Resource;
      if (u.searchParams.get('returnPartialSuccess') !== 'true') throw new Error(`${url}: returnPartialSuccess=true expected`);
      if (world.refused.includes(resource)) throw new GoogleError({ status: 403, reason: 'IAM_PERMISSION_DENIED', code: 'PERMISSION_DENIED', message: `Required 'compute.${resource}.list' permission for 'projects/${project}'` });
      const scopes = [...new Set([...Object.keys(lists[resource]), ...EMPTY_SCOPES])].filter((s) => !world.unreachable.includes(s)).sort();
      const size = world.pageScopes[resource] ?? scopes.length;
      const at = Number(u.searchParams.get('pageToken') ?? 0);
      const page = scopes.slice(at, at + size);
      const items = Object.fromEntries(page.map((scope) => [scope, lists[resource][scope]?.length
        ? { [resource]: lists[resource][scope] }
        : { warning: { code: 'NO_RESULTS_ON_PAGE', message: `There are no results for scope '${scope}' on this page.`, data: [{ key: 'scope', value: scope }] } }]));
      return {
        kind: `compute#${resource}AggregatedList`, id: `projects/${project}/aggregated/${resource}`, items, selfLink: `${V1}/projects/${project}/aggregated/${resource}`,
        ...(at + size < scopes.length ? { nextPageToken: String(at + size) } : {}),
        ...(at === 0 && world.unreachable.length ? { unreachables: world.unreachable } : {}),
      };
    }
    const members = /^(zones|regions)\/[^/]+\/instanceGroups\/[^/]+(?=\/listInstances$)/.exec(path);
    if (members && method === 'POST') {
      if ((body as { instanceState?: string } | undefined)?.instanceState !== 'ALL') throw new Error(`${url}: instanceState ALL expected`);
      const vms = groups[`projects/${project}/${members[0]}`];
      if (!vms) throw notFound(url);
      return { kind: 'compute#instanceGroupsListInstances', id: `projects/${project}/${members[0]}`, items: vms.map((instance) => ({ instance, status: 'RUNNING' })), selfLink: url };
    }
    const neg = /^zones\/[^/]+\/networkEndpointGroups\/[^/]+/.exec(path);
    const found = neg ? negs[`projects/${project}/${neg[0]}`] : undefined;
    if (neg && path === neg[0] && method === 'GET') {
      if (!found) throw notFound(url);
      return found.neg;
    }
    if (neg && path === `${neg[0]}/listNetworkEndpoints` && method === 'POST') {
      if (!found) throw notFound(url);
      return { kind: 'compute#networkEndpointGroupsListNetworkEndpoints', items: found.endpoints };
    }
    // The router's own reads (its preview, for the parity test): a VM, a managed group and its VMs, a machine type.
    const vm = /^zones\/([^/]+)\/instances\/([^/]+)$/.exec(path);
    if (vm && method === 'GET') {
      const found = (lists.instances[`zones/${vm[1]}`] ?? []).find((i) => i.name === vm[2]);
      if (!found) throw Object.assign(notFound(url), { code: 404 });
      return found;
    }
    const manager = /^((?:zones|regions)\/[^/]+)\/instanceGroupManagers\/([^/]+)(\/listManagedInstances)?$/.exec(path);
    if (manager) {
      const found = (lists.instanceGroupManagers[manager[1]!] ?? []).find((i) => i.name === manager[2]);
      if (!found) throw Object.assign(notFound(url), { code: 404 });
      if (!manager[3] && method === 'GET') return found;
      if (manager[3] && method === 'POST') return { managedInstances: (groups[`projects/${project}/${manager[1]}/instanceGroups/${manager[2]}`] ?? []).map((instance) => ({ instance, instanceStatus: 'RUNNING' })) };
    }
    const type = /^zones\/([^/]+)\/machineTypes\/([^/]+)$/.exec(path);
    if (type && method === 'GET') return { name: type[2], ...(world.gpuTypes.includes(type[2]!) ? { accelerators: [{ guestAcceleratorType: 'nvidia-l4', guestAcceleratorCount: 1 }] } : {}) };
    throw new Error(`unexpected call ${method} ${url}`);
  }
  return world;
}

export type ComputeWorld = ReturnType<typeof compute>;

// dormeto-dev's demo (above); dmt-demo-app onboarded on the router of europe-west2.
export function devProject(project = PROJECT) {
  const w = compute(project);
  w.vm('dmt-demo', 'europe-west1-b', { env: 'dev', app: 'demo' });
  const demo = w.group('dmt-demo', 'europe-west1-b', ['dmt-demo']);
  w.vm('dmt-demo-mig-0k3d', 'europe-west1-b', { env: 'dev', app: 'demo-mig' });
  w.vm('dmt-demo-mig-7vqx', 'europe-west1-b', { env: 'dev', app: 'demo-mig' });
  const mig = w.mig('dmt-demo-mig', 'europe-west1-b', ['dmt-demo-mig-0k3d', 'dmt-demo-mig-7vqx']);
  const app = w.backendService('dmt-demo-app', [demo]);
  w.backendService('dmt-demo-standin', [demo]);
  const migApp = w.backendService('dmt-demo-mig-app', [mig]);
  const waker = w.backendService('dmtr-europe-west2-dmt-demo-app', [w.link('regions/europe-west2/networkEndpointGroups/dmtr-europe-west2-waker')]);
  w.urlMap('dmt-dev', {
    defaultService: app,
    hostRules: [{ hosts: ['gcp.dev.dormeto.com'], pathMatcher: 'app' }, { hosts: ['mig.gcp.dev.dormeto.com'], pathMatcher: 'mig' }],
    pathMatchers: [
      { name: 'app', defaultService: app, pathRules: [{ paths: ['/_dormeto/*'], service: waker }] },
      { name: 'mig', defaultService: migApp },
    ],
  });
  w.front('dmt-dev');
  return w;
}

// The router's row of a workload (WS#<project>#<region>#<id>), as the router's reports write it.
export const workloadRow = (workloadId: string, over: Partial<WorkloadSummary> = {}): WorkloadSummary => ({
  account: PROJECT, region: 'europe-west2', router: 'dmtr-europe-west2', workloadId, name: workloadId, state: 'AWAKE', source: 'manager',
  backendService: workloadId, wakerBackendService: `dmtr-europe-west2-${workloadId}`, urlMap: 'dmt-dev', ...over,
});
