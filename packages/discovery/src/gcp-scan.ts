// A Google Cloud project's scan (Google Cloud manager design §7.2, §7.3), as the discovery account: Compute Engine's
// aggregated lists of URL maps, backend services, target proxies, forwarding rules, instance group managers and VMs (every
// scope at once, every page), then the groups and zonal NEGs the backend services name. A candidate is a backend service a
// URL map names: eligible, ineligible with the router's own onboarding reason (router gcp/src/onboarding.mjs, gke.mjs and
// urlmaps.mjs, read at ca79d5b; the first reason wins, as the router lists them), or managed when a router's workload row
// names it. The onboarding's preview, the router's dry run, has the last word.
//
// The candidate keeps AWS's fields with Google Cloud's meaning (Google Cloud manager design §3): `id` and `backendService`
// the backend service's path, `targetGroup` its name, `loadBalancer` the URL map's name, `urlMap` its path, `region` the
// map's region or `global`; the AWS-only fields empty. The router's own resources (`dmtr-*`) are never candidates.
//
// What failed is said per region: a scope Compute Engine lists as unreachable fails its region, and a candidate whose
// backends could not be read fails its own (a failed pair changes none of its candidates). Compute Engine turned off
// (SERVICE_DISABLED) is a project with nothing to find.
import type { WorkloadSummary } from '@dormeto/fleet';
import { GoogleError } from '@dormeto/google';
import { idleOfProject } from './gcp-idle.js';
import type { GooglePort } from './google.js';
import type { BackendKind, ScannedRule } from './types.js';

type Call = GooglePort['call'];
type LbKind = NonNullable<ScannedRule['lb']>['kind'];

// The router's row of a workload (WS#<project>#<region>#<id>), as the poll writes it: names, not paths.
export type ManagedRow = Pick<WorkloadSummary, 'workloadId' | 'region' | 'backendService' | 'wakerBackendService' | 'urlMap' | 'lb'>;

export interface ProjectScan {
  rules: ScannedRule[];
  regions: { region: string; ok: boolean; error?: string }[]; // `global` and each region where the scan found something
}

const COMPUTE = 'https://compute.googleapis.com/compute/v1';
// Discovery's Google reads at once (Google Cloud manager design, bounds).
const AT_ONCE = 10;

// ---- The router's words (router gcp/src/onboarding.mjs, gke.mjs and urlmaps.mjs at ca79d5b) ----
// onboarding.mjs:55-63: a load balancer's scheme by its kind, the kinds of each scope of a map.
const SCHEME_OF: Record<LbKind, string> = {
  global: 'EXTERNAL_MANAGED', classic: 'EXTERNAL', regional: 'EXTERNAL_MANAGED', internal: 'INTERNAL_MANAGED', 'cross-region-internal': 'INTERNAL_MANAGED',
};
const GLOBAL_KINDS: LbKind[] = ['global', 'classic', 'cross-region-internal'];
const REGIONAL_KINDS: LbKind[] = ['regional', 'internal'];
const SUPPORTED = 'only Application Load Balancers are supported: global (EXTERNAL_MANAGED), classic (EXTERNAL), regional (EXTERNAL_MANAGED), internal (INTERNAL_MANAGED) and cross-region-internal (INTERNAL_MANAGED)';
// switch.mjs:20: the kinds a nap swaps (the others get the error response policy).
const SWAPPED = new Set<LbKind>(['regional', 'classic', 'internal', 'cross-region-internal']);
const INSTANCE_GROUP = /\/(zones|regions)\/([^/]+)\/instanceGroups\/([^/]+)$/;
const NEG_URL = /\/(zones|regions|global)\/(?:([^/]+)\/)?networkEndpointGroups\/([^/]+)$/;
const NEG_OF_VMS = 'GCE_VM_IP_PORT';
// gke.mjs:34-40, :94-110: a load balancer GKE owns, by its URL map's name or the descriptions GKE writes; a NEG GKE made.
const GKE_MAP = /^(k8s2-|k8s-um-|gkegw1-|gkemcg1-|mci-[a-z0-9]{6}(-|$))/;
const GKE_MAP_FIELD = 'k8sResource';
const GKE_INGRESS_FIELD = 'kubernetes.io/ingress-name';
const GKE_NEG_FIELD = /cluster-(uid|name)/i;
const GKE_NEG_PREFIX = 'k8s1-';
const gkeMapWords = (name: string) => `URL map ${name} belongs to a load balancer GKE owns (a Gateway or an Ingress): GKE writes it back at its next sync, so a nap's switch could not be trusted. Give the Service a standalone network endpoint group with the annotation cloud.google.com/neg, name it in a backend service of a load balancer of your own, and onboard that`;
// Its onboarding needs the cluster, namespace and Service, which a NEG does not name, and its RBAC is the operator's (§7.3).
const GKE_REASON = 'a GKE workload is onboarded with dormeto gcp workloads onboard, after dormeto gcp workloads access grant';
// urlmaps.mjs: what Dormeto writes in a map, and onboarding.mjs's mapProblems: the advice after each refusal.
const POLICY = 'defaultCustomErrorResponsePolicy';
const ROUTE_PATH = '/_dormeto/*';
const ROUTE_PREFIX = '/_dormeto/';
const ROUTE_NAMESPACE = '/_dormeto';
const HOLD_PATH = '/_dormeto/backend/*';
const HOLD_PREFIX = '/_dormeto/backend/';
const ROUTE_ADVICE = 'change that, then onboard again';
const POLICY_ADVICE = 'a nap would replace it, remove it first';

// ---- Google's answers (Compute Engine v1), the fields read ----
interface Weighted { backendService?: string }
interface RouteAction { weightedBackendServices?: Weighted[] }
interface Policy { errorService?: string }
interface PathRule { paths?: string[]; service?: string; routeAction?: RouteAction; customErrorResponsePolicy?: Policy }
interface MatchRule { prefixMatch?: string; fullPathMatch?: string; regexMatch?: string; pathTemplateMatch?: string }
interface RouteRule { priority?: number; matchRules?: MatchRule[]; service?: string; routeAction?: RouteAction; customErrorResponsePolicy?: Policy }
interface PathMatcher { name?: string; defaultService?: string; defaultRouteAction?: RouteAction; pathRules?: PathRule[]; routeRules?: RouteRule[]; defaultCustomErrorResponsePolicy?: Policy }
interface UrlMap { name: string; selfLink: string; description?: string; defaultService?: string; defaultRouteAction?: RouteAction; hostRules?: { hosts?: string[]; pathMatcher?: string }[]; pathMatchers?: PathMatcher[] }
interface BackendService { name: string; selfLink: string; backends?: { group?: string }[] }
interface Proxy { name: string; selfLink: string; urlMap?: string; description?: string }
interface ForwardingRule { name: string; target?: string; loadBalancingScheme?: string; description?: string }
interface Manager { name: string; instanceGroup?: string }
interface Instance { selfLink: string; labels?: Record<string, string> }
interface Neg { name: string; networkEndpointType?: string; description?: string; annotations?: Record<string, string> }
interface AggregatedPage { items?: Record<string, Record<string, unknown> & { warning?: { code?: string; message?: string } }>; unreachables?: string[]; nextPageToken?: string }
// What names a backend service: the map and its matchers by their defaults, the rules by their service and route action.
interface Holder { service?: string; defaultService?: string; routeAction?: RouteAction; defaultRouteAction?: RouteAction }
type ServiceKey = 'service' | 'defaultService';
type ActionKey = 'routeAction' | 'defaultRouteAction';

const nameOf = (url: string | undefined) => (url ?? '').slice((url ?? '').lastIndexOf('/') + 1);
// A URL from `projects/` on, whatever the API's host and version (as the router's fromProjects).
const pathOf = (url: string) => url.slice(Math.max(url.indexOf('projects/'), 0));
const hidden = (name: string) => name.startsWith('dmtr-');
// The region of a scope: `global`, `regions/<r>`, `zones/<r>-<x>`.
const regionOfScope = (scope: string) => (scope === 'global' ? 'global' : scope.startsWith('zones/') ? scope.slice(6).replace(/-[a-z]$/, '') : scope.replace(/^regions\//, ''));
const regionOfZone = (zone: string) => zone.replace(/-[a-z]$/, '');
const isRegionalKind = (kind: string | undefined) => kind === 'regional' || kind === 'internal';

// Every service a holder sends to: its service, its weighted services (urlmaps.mjs refsOf).
const refsOf = (h: Holder, serviceKey: ServiceKey, actionKey: ActionKey) => [h[serviceKey], ...(h[actionKey]?.weightedBackendServices ?? []).map((w) => w.backendService)]
  .filter((u): u is string => typeof u === 'string');
// The one service a holder sends to (urlmaps.mjs soleService).
function soleService(h: Holder, serviceKey: ServiceKey, actionKey: ActionKey) {
  const weighted = h[actionKey]?.weightedBackendServices ?? [];
  return h[serviceKey] ?? (weighted.length === 1 ? weighted[0]!.backendService : undefined);
}
// Every service a map names, wherever it does.
const allRefs = (map: UrlMap) => [
  ...[map, ...(map.pathMatchers ?? [])].flatMap((h) => refsOf(h, 'defaultService', 'defaultRouteAction')),
  ...(map.pathMatchers ?? []).flatMap((m) => [...(m.pathRules ?? []), ...(m.routeRules ?? [])].flatMap((r) => refsOf(r, 'service', 'routeAction'))),
];

// What names the candidate's service in a map: its own name, and for a managed one its waker's (a napped workload's swap names
// the waker where it named the application).
interface Names { app: string; waker?: string }
type Is = (url: string) => boolean;
const isOne = (n: Names): Is => (url) => nameOf(url) === n.app || (n.waker !== undefined && nameOf(url) === n.waker);
const holds = (h: Holder, serviceKey: ServiceKey, actionKey: ActionKey, is: Is) => refsOf(h, serviceKey, actionKey).some(is);
const matcherHolds = (m: PathMatcher, is: Is) => holds(m, 'defaultService', 'defaultRouteAction', is)
  || (m.pathRules ?? []).some((r) => holds(r, 'service', 'routeAction', is))
  || (m.routeRules ?? []).some((r) => holds(r, 'service', 'routeAction', is));
// The matchers naming the service, with their index; `named`: the map's own default names it (urlmaps.mjs holders).
function holders(map: UrlMap, is: Is) {
  const matchers = (map.pathMatchers ?? []).flatMap((matcher, i) => (matcherHolds(matcher, is) ? [{ matcher, i }] : []));
  return { named: holds(map, 'defaultService', 'defaultRouteAction', is), matchers };
}
const references = (map: UrlMap, is: Is) => {
  const { named, matchers } = holders(map, is);
  return named || matchers.length > 0;
};

// Dormeto's own routes (urlmaps.mjs): the waker's /_dormeto/* route, and the hold route to the application.
const pathRuleOurs = (r: PathRule, n: Names) => n.waker !== undefined && nameOf(soleService(r, 'service', 'routeAction')) === n.waker && (r.paths ?? []).includes(ROUTE_PATH);
const routeRuleOurs = (r: RouteRule, n: Names) => n.waker !== undefined && nameOf(soleService(r, 'service', 'routeAction')) === n.waker && (r.matchRules ?? []).some((m) => m.prefixMatch === ROUTE_PREFIX);
const holdPathRule = (r: PathRule, n: Names) => nameOf(r.service) === n.app && r.paths?.length === 1 && r.paths[0] === HOLD_PATH;
const holdRouteRule = (r: RouteRule, n: Names) => nameOf(r.service) === n.app && (r.matchRules ?? []).length === 1
  && Object.keys(r.matchRules![0]!).join() === 'prefixMatch' && r.matchRules![0]!.prefixMatch === HOLD_PREFIX;
const inNamespace = (path: string | undefined) => typeof path === 'string' && path.startsWith(ROUTE_NAMESPACE);

// The hosts that reach the service (urlmaps.mjs hostsOf): those of the matchers naming it, and `*` for the map's default
// when it is reachable.
function hostsOf(map: UrlMap, is: Is) {
  const { named, matchers } = holders(map, is);
  const names = new Set(matchers.map(({ matcher }) => matcher.name));
  const hostRules = map.hostRules ?? [];
  const hosts = hostRules.filter((h) => names.has(h.pathMatcher)).flatMap((h) => h.hosts ?? []);
  const reached = named && !hostRules.some((h) => (h.hosts ?? []).includes('*'));
  return { hosts: [...new Set(reached ? [...hosts, '*'] : hosts)], reached };
}

// The paths that lead to the service, Dormeto's own routes left out: `/*` for a default, a path rule's paths, a route rule's match.
function pathsOf(map: UrlMap, n: Names, reached: boolean) {
  const is = isOne(n);
  const paths: string[] = [];
  for (const { matcher } of holders(map, is).matchers) {
    if (holds(matcher, 'defaultService', 'defaultRouteAction', is)) paths.push('/*');
    for (const r of matcher.pathRules ?? []) if (holds(r, 'service', 'routeAction', is) && !pathRuleOurs(r, n) && !holdPathRule(r, n)) paths.push(...(r.paths ?? []));
    for (const r of matcher.routeRules ?? []) {
      if (!holds(r, 'service', 'routeAction', is) || routeRuleOurs(r, n) || holdRouteRule(r, n)) continue;
      paths.push(...(r.matchRules ?? []).flatMap((m) => (m.prefixMatch !== undefined ? [`${m.prefixMatch}*`] : [m.fullPathMatch, m.regexMatch, m.pathTemplateMatch].filter((p): p is string => p !== undefined))));
    }
  }
  if (reached) paths.push('/*');
  return [...new Set(paths)];
}

// urlmaps.mjs:222-233 (checkNoOwnRoute), in each matcher naming the service: a /_dormeto/ route that is not Dormeto's.
function ownRoute(matcher: PathMatcher, path: string, n: Names): string | null {
  const pathRule = (matcher.pathRules ?? []).findIndex((r) => (r.paths ?? []).some(inNamespace) && !pathRuleOurs(r, n) && !holdPathRule(r, n));
  if (pathRule >= 0) return `the URL map has its own /_dormeto/ route at ${path}.pathRules[${pathRule}]`;
  const routeRule = (matcher.routeRules ?? []).findIndex((r) => (r.matchRules ?? []).some((m) => [m.prefixMatch, m.fullPathMatch].some(inNamespace)) && !routeRuleOurs(r, n) && !holdRouteRule(r, n));
  if (routeRule >= 0) return `the URL map has its own /_dormeto/ route at ${path}.routeRules[${routeRule}]`;
  return null;
}

// urlmaps.mjs:157-185 (withErrorPolicy), in each matcher naming the service: a rule's own policy, then the matcher's.
function ownPolicy(matcher: PathMatcher, i: number, n: Names): string | null {
  const is = isOne(n);
  for (const kind of ['pathRules', 'routeRules'] as const) {
    const rules: (PathRule | RouteRule)[] = matcher[kind] ?? [];
    const j = rules.findIndex((r) => r.customErrorResponsePolicy !== undefined && holds(r, 'service', 'routeAction', is));
    if (j >= 0) return `the URL map has its own error response policy at pathMatchers[${i}].${kind}[${j}].customErrorResponsePolicy`;
  }
  const policy = matcher[POLICY];
  if (policy !== undefined && !(n.waker !== undefined && nameOf(policy.errorService) === n.waker)) return `the URL map has its own error response policy at pathMatchers[${i}].${POLICY}`;
  return null;
}

// onboarding.mjs:366 (mapProblems): the route first (with its advice), then, on a load balancer a nap does not swap, the policy.
function mapProblems(map: UrlMap, n: Names, kind: LbKind): string[] {
  const { matchers } = holders(map, isOne(n));
  for (const { matcher, i } of matchers) {
    const refused = ownRoute(matcher, `pathMatchers[${i}]`, n);
    if (refused) return [`${refused}: ${ROUTE_ADVICE}`];
  }
  if (SWAPPED.has(kind)) return [];
  for (const { matcher, i } of matchers) {
    const refused = ownPolicy(matcher, i, n);
    if (refused) return [`${refused}: ${POLICY_ADVICE}`];
  }
  return [];
}

// gke.mjs:103-107: what GKE writes in the descriptions of a load balancer it owns.
function gkeDescribed(map: UrlMap, proxies: Proxy[], rules: ForwardingRule[]) {
  const has = (item: { description?: string }, field: string) => typeof item.description === 'string' && item.description.includes(field);
  return has(map, GKE_MAP_FIELD) || [...proxies, ...rules].some((item) => has(item, GKE_INGRESS_FIELD));
}
// gke.mjs:110: a NEG GKE made, its endpoints pods.
const isGkeNeg = ({ name, description, annotations }: Neg) => name.startsWith(GKE_NEG_PREFIX) || GKE_NEG_FIELD.test(description ?? '') || Object.keys(annotations ?? {}).some((key) => GKE_NEG_FIELD.test(key));

// Calls with at most `size` in flight: a call waiting takes the slot of the one that ends.
function limited(call: Call, size: number): Call {
  let active = 0;
  const waiting: (() => void)[] = [];
  return (async (method: string, url: string, body?: unknown) => {
    if (active < size) active += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await call(method, url, body);
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  }) as Call;
}

// A read that depends on a region Compute Engine could not list: the candidate's pair fails with that region's reason.
class RegionFailed extends Error {}
const errorText = (err: unknown) => (err instanceof RegionFailed ? err.message : `${(err as Error).name ?? 'Error'}: ${(err as Error).message ?? String(err)}`);

// `managed`: the rows of the project's routers. `now`: the clock of the idle share (§7.3).
export async function scanProject(port: Pick<GooglePort, 'call'>, { project, managed, now, log }: { project: string; managed: ManagedRow[]; now: () => number; log?: { warn(event: string, data?: object): void } }): Promise<ProjectScan> {
  const call = limited(port.call.bind(port), AT_ONCE);
  const seen = new Set<string>(['global']);
  const unlisted = new Map<string, string>(); // region -> why the lists miss part of it
  const failed = new Map<string, string>(); // region -> why its pair failed: unlisted, or a candidate's read
  const fail = (region: string, why: string, map = failed) => {
    seen.add(region);
    if (!map.has(region)) map.set(region, why);
  };
  const unlist = (region: string, why: string) => {
    fail(region, why, unlisted);
    fail(region, why);
  };

  // Every page of an aggregated list: its items with their scope. A scope with only Google's "no results" warning is empty;
  // another warning, or a scope Google could not reach, fails its region.
  async function aggregated<T>(resource: string): Promise<{ scope: string; item: T }[]> {
    const out: { scope: string; item: T }[] = [];
    let token: string | undefined;
    do {
      const query = new URLSearchParams({ returnPartialSuccess: 'true', ...(token ? { pageToken: token } : {}) });
      const page = await call<AggregatedPage>('GET', `${COMPUTE}/projects/${project}/aggregated/${resource}?${query}`);
      for (const [scope, entry] of Object.entries(page.items ?? {})) {
        const items = (entry[resource] ?? []) as T[];
        for (const item of items) out.push({ scope, item });
        if (items.length) seen.add(regionOfScope(scope));
        const code = entry.warning?.code;
        if (code && code !== 'NO_RESULTS_ON_PAGE') unlist(regionOfScope(scope), `Compute Engine warned about ${scope}: ${entry.warning?.message ?? code}`);
      }
      for (const unreachable of page.unreachables ?? []) {
        const scope = /(?:^|\/)(global|(?:regions|zones)\/[a-z0-9-]+)$/.exec(unreachable)?.[1];
        // An unreachable place the scan cannot tell: nothing of the project can be trusted.
        if (!scope) throw new Error(`Compute Engine listed ${unreachable} as unreachable`);
        unlist(regionOfScope(scope), `Compute Engine listed ${unreachable} as unreachable`);
      }
      token = page.nextPageToken || undefined;
    } while (token);
    return out;
  }

  let lists;
  try {
    lists = await Promise.all([
      aggregated<UrlMap>('urlMaps'), aggregated<BackendService>('backendServices'), aggregated<Proxy>('targetHttpsProxies'), aggregated<Proxy>('targetHttpProxies'),
      aggregated<ForwardingRule>('forwardingRules'), aggregated<Manager>('instanceGroupManagers'), aggregated<Instance>('instances'),
    ]);
  } catch (err) {
    // Compute Engine turned off: no load balancer to find.
    if (err instanceof GoogleError && err.reason === 'SERVICE_DISABLED') return { rules: [], regions: [{ region: 'global', ok: true }] };
    throw err;
  }
  const [maps, services, httpsProxies, httpProxies, forwardingRules, managers, instances] = lists;
  const proxies = [...httpsProxies, ...httpProxies].map((p) => p.item);
  const rulesOf = forwardingRules.map((r) => r.item);
  const serviceAt = new Map(services.map(({ item }) => [pathOf(item.selfLink), item]));
  const managerOf = new Map(managers.flatMap(({ item }) => (item.instanceGroup ? [[pathOf(item.instanceGroup), item] as const] : [])));
  const labelsOf = new Map(instances.map(({ item }) => [pathOf(item.selfLink), item.labels ?? {}]));
  // The maps of each scope, by name.
  const mapsIn = new Map<string, UrlMap[]>();
  for (const { scope, item } of [...maps].sort((a, b) => a.item.name.localeCompare(b.item.name))) mapsIn.set(scope, [...(mapsIn.get(scope) ?? []), item]);

  // The rows by their backend service and by their waker, each in its scope.
  const rowScope = (row: ManagedRow) => (isRegionalKind(row.lb?.kind) ? `regions/${row.lb?.region ?? row.region}` : 'global');
  const rows = managed.filter((r) => typeof r.backendService === 'string' && r.backendService !== '');
  const rowOf = new Map(rows.map((r) => [`${rowScope(r)}#${r.backendService}`, r]));
  const wakerOf = new Map(rows.filter((r) => r.wakerBackendService).map((r) => [`${rowScope(r)}#${r.wakerBackendService}`, r]));

  // The backend services the project's maps name (a waker counting as its workload's service), each with the maps naming it.
  const candidates = new Map<string, { scope: string; name: string; maps: UrlMap[] }>();
  for (const [scope, list] of mapsIn) {
    for (const map of list.filter((m) => !hidden(m.name))) {
      for (const url of allRefs(map)) {
        const path = pathOf(url);
        // Another project's service, or no backend service (a backend bucket): not this project's candidate.
        if (!path.startsWith(`projects/${project}/${scope}/backendServices/`)) continue;
        const name = wakerOf.get(`${scope}#${nameOf(url)}`)?.backendService ?? nameOf(url);
        if (hidden(name)) continue;
        const id = `projects/${project}/${scope}/backendServices/${name}`;
        const entry = candidates.get(id) ?? { scope, name, maps: [] };
        if (!entry.maps.includes(map)) entry.maps.push(map);
        candidates.set(id, entry);
      }
    }
  }

  // What a group's or a NEG's read finds, once each, whichever backend services name it: their reasons are worded per service.
  // `otherType`: a zonal NEG's type when it is not one of VMs.
  interface Found { kind?: BackendKind; id?: string; gke?: true; otherType?: string; vms: string[] }
  const reads = new Map<string, Promise<Found>>();
  const once = (key: string, read: () => Promise<Found>) => {
    if (!reads.has(key)) reads.set(key, read());
    return reads.get(key)!;
  };
  const reachable = (region: string) => {
    const why = unlisted.get(region);
    if (why) throw new RegionFailed(why);
  };
  async function pagesOf<T>(url: string, body: unknown): Promise<T[]> {
    const out: T[] = [];
    let token: string | undefined;
    do {
      const page = await call<{ items?: T[]; nextPageToken?: string }>('POST', `${url}${token ? `?${new URLSearchParams({ pageToken: token })}` : ''}`, body);
      out.push(...(page.items ?? []));
      token = page.nextPageToken || undefined;
    } while (token);
    return out;
  }
  // onboarding.mjs backendOf and negOf, the reasons a read can decide; the VMs whose labels are the candidate's tags.
  interface BackendRead { reasons: string[]; kind?: BackendKind; id?: string; gke?: true; vms: string[] }
  async function backendOf(url: string, service: string): Promise<BackendRead> {
    const group = INSTANCE_GROUP.exec(url);
    if (group) {
      const [scope, location, name] = [group[1]!, group[2]!, group[3]!];
      const found = await once(pathOf(url), async () => {
        reachable(scope === 'zones' ? regionOfZone(location) : location);
        const manager = managerOf.get(`projects/${project}/${scope}/${location}/instanceGroups/${name}`);
        const members = await pagesOf<{ instance?: string }>(`${COMPUTE}/projects/${project}/${scope}/${location}/instanceGroups/${name}/listInstances`, { instanceState: 'ALL' });
        const vms = members.flatMap((m) => (m.instance ? [pathOf(m.instance)] : []));
        for (const vm of vms) reachable(regionOfZone(/\/zones\/([^/]+)\//.exec(vm)?.[1] ?? ''));
        return manager ? { kind: 'asg', id: manager.name, vms } : { kind: 'instance', id: name, vms };
      });
      return { reasons: [], ...found };
    }
    const [, scope, zone, name] = NEG_URL.exec(url) ?? [];
    if (scope === 'zones' && zone && name) {
      const found = await once(pathOf(url), async () => {
        reachable(regionOfZone(zone));
        const negUrl = `${COMPUTE}/projects/${project}/zones/${zone}/networkEndpointGroups/${name}`;
        const neg = await call<Neg>('GET', negUrl);
        if (neg.networkEndpointType !== NEG_OF_VMS) return { otherType: String(neg.networkEndpointType), vms: [] };
        if (isGkeNeg({ ...neg, name })) return { kind: 'k8s', id: name, gke: true, vms: [] };
        const endpoints = await pagesOf<{ networkEndpoint?: { instance?: string } }>(`${negUrl}/listNetworkEndpoints`, {});
        const vms = endpoints.flatMap((e) => (e.networkEndpoint?.instance ? [`projects/${project}/zones/${zone}/instances/${nameOf(e.networkEndpoint.instance)}`] : []));
        return { kind: 'instance', id: name, vms };
      });
      if (found.otherType !== undefined) return { reasons: [`network endpoint group ${name} of backend service ${service} has the type ${found.otherType}: only ${NEG_OF_VMS} is supported, take it out of the backend service`], vms: [] };
      return { reasons: [], ...found };
    }
    const where = scope === 'regions' ? 'regional network endpoint group (serverless, private service connect)' : scope === 'global' ? 'global network endpoint group (internet)' : 'network endpoint group';
    return { reasons: [`backend ${nameOf(url)} of backend service ${service} is a ${where}: only zonal network endpoint groups of VMs and instance groups are supported`], vms: [] };
  }

  // onboarding.mjs:335-361 (loadBalancerOf): one target proxy, forwarding rules whose scheme tells the kind; the reasons when it cannot be told.
  function loadBalancerOf(map: UrlMap, scope: string): { kind?: LbKind; reasons: string[] } {
    const self = pathOf(map.selfLink);
    const fronting = proxies.filter((p) => p.urlMap !== undefined && pathOf(p.urlMap) === self);
    const refused = (...reasons: string[]) => ({ reasons });
    if (fronting.length && gkeDescribed(map, fronting, [])) return refused(gkeMapWords(map.name));
    if (!fronting.length) return refused(`URL map ${map.name} is used by no target proxy: attach it to an Application Load Balancer, then onboard again`);
    if (fronting.length > 1) return refused(`URL map ${map.name} is used by ${fronting.length} target proxies (${fronting.map((p) => p.name).join(', ')}): give each load balancer its own URL map`);
    const proxy = pathOf(fronting[0]!.selfLink);
    const fronts = rulesOf.filter((r) => r.target !== undefined && pathOf(r.target) === proxy);
    if (gkeDescribed(map, fronting, fronts)) return refused(gkeMapWords(map.name));
    if (!fronts.length) return refused(`no forwarding rule sends to the target proxy of URL map ${map.name}: add one, then onboard again`);
    const kinds = scope === 'global' ? GLOBAL_KINDS : REGIONAL_KINDS;
    const kindsOf = (r: ForwardingRule) => kinds.filter((kind) => SCHEME_OF[kind] === r.loadBalancingScheme);
    const unsupported = fronts.filter((r) => !kindsOf(r).length);
    if (unsupported.length) return refused(...unsupported.map((r) => `forwarding rule ${r.name} has the scheme ${r.loadBalancingScheme}: ${SUPPORTED}`));
    const found = [...new Set(fronts.flatMap(kindsOf))];
    // Rules of two kinds (a migration under way): not told here, the preview says it.
    return found.length === 1 ? { kind: found[0], reasons: [] } : { reasons: [] };
  }

  async function candidateOf(id: string, { scope, name, maps: naming }: { scope: string; name: string; maps: UrlMap[] }): Promise<ScannedRule | null> {
    const service = serviceAt.get(id);
    // Not in the list read (created or deleted meanwhile): the next run sees it.
    if (!service) return null;
    const row = rowOf.get(`${scope}#${name}`);
    const map = (row && naming.find((m) => m.name === row.urlMap)) ?? naming[0]!;
    const n: Names = { app: name, ...(row?.wakerBackendService ? { waker: row.wakerBackendService } : {}) };
    const region = regionOfScope(scope);
    // gke.mjs:97 first: a map GKE owns by its name is refused before anything is read.
    const front: { kind?: LbKind; reasons: string[] } = GKE_MAP.test(map.name) ? { reasons: [gkeMapWords(map.name)] } : loadBalancerOf(map, scope);
    const reasons = [...front.reasons];
    for (const other of mapsIn.get(scope) ?? []) {
      if (other !== map && references(other, (u) => nameOf(u) === name)) {
        reasons.push(`backend service ${name} is also named in URL map ${other.name}: that load balancer would lose its backends during a nap; give it a backend service of its own`);
      }
    }
    if (!service.backends?.length) reasons.push(`backend service ${name} has no backend: add an instance group, then onboard again`);
    reasons.push(...mapProblems(map, n, front.kind ?? (scope === 'global' ? 'global' : 'regional')));
    const backends = await Promise.all((service.backends ?? []).map((b) => backendOf(b.group ?? '', name)));
    // A GKE workload is the CLI's to onboard; one it onboarded is managed all the same.
    for (const b of backends) reasons.push(...b.reasons, ...(b.gke && !row ? [GKE_REASON] : []));
    const first = backends[0];
    const tags: Record<string, string[]> = {};
    for (const vm of backends.flatMap((b) => b.vms)) {
      for (const [key, value] of Object.entries(labelsOf.get(vm) ?? {})) {
        tags[key] ??= [];
        if (!tags[key].includes(value)) tags[key].push(value);
      }
    }
    const { hosts, reached } = hostsOf(map, isOne(n));
    const paths = pathsOf(map, n, reached);
    const base: ScannedRule = {
      id,
      account: project,
      region,
      loadBalancer: map.name,
      loadBalancerArn: '',
      listener: '',
      priority: '',
      conditions: [hosts.length ? `hosts ${hosts.join(', ')}` : '', paths.length ? `paths ${paths.join(', ')}` : ''].filter(Boolean).join('; '),
      hosts,
      targetGroup: name,
      targetGroupArn: null,
      backend: first?.kind && first.id ? { kind: first.kind, id: first.id } : null,
      tags,
      rules: [],
      eligibility: 'eligible',
      idleHours7d: null,
      requests7d: null,
      backendService: id,
      urlMap: pathOf(map.selfLink),
      ...(front.kind ? { lb: { kind: front.kind } } : {}),
    };
    if (row) return { ...base, eligibility: 'managed', workloadId: row.workloadId, ...(reasons.length ? { reason: reasons[0] } : {}) };
    return reasons.length ? { ...base, eligibility: 'ineligible', reason: reasons[0] } : base;
  }

  const rules: ScannedRule[] = [];
  await Promise.all([...candidates].map(async ([id, entry]) => {
    const region = regionOfScope(entry.scope);
    try {
      const rule = await candidateOf(id, entry);
      if (rule) rules.push(rule);
      seen.add(region);
    } catch (err) {
      fail(region, errorText(err));
    }
  }));
  const kept = rules.filter((r) => !failed.has(r.region)).sort((a, b) => a.id.localeCompare(b.id));
  // The idle share of the candidates not ineligible, a Monitoring that fails leaving it null (§7.3).
  const idle = await idleOfProject(port, {
    project, now, log,
    candidates: kept.filter((r) => r.eligibility !== 'ineligible').map((r) => ({ id: r.id, backendService: r.targetGroup ?? '', urlMap: r.loadBalancer, region: r.region, kind: r.lb?.kind })),
  });
  return {
    rules: kept.map((r) => ({ ...r, ...idle.get(r.id) })),
    regions: [...seen].sort().map((region) => (failed.has(region) ? { region, ok: false, error: failed.get(region)! } : { region, ok: true })),
  };
}
