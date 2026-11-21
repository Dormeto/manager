// The safety net again, for one Google Cloud standalone resource at its onboarding (final review I3; decisions
// findings-final-manager-1.md): the scan may be days old, or out of scope. As the discovery account (its role's reads only:
// backendServices.list, forwardingRules.list, targetPools.list, targetInstances.list, instanceGroups.list and listInstances,
// networkEndpointGroups.get and its endpoints, instanceGroupManagers.get and listManagedInstances), what backs any backend service, a group in a target pool, a VM in
// a region with a load balancer the manager cannot read, or a listing that missed the resource's scope, gives the scan's words
// (gcp-scan.ts, gcp-standalone.ts). A read that fails throws: the onboarding is refused, never let through.
import type { GooglePort } from './google.js';
import type { StandaloneRule } from './types.js';

type Call = GooglePort['call'];
const COMPUTE = 'https://compute.googleapis.com/compute/v1';
const INSTANCE_GROUP = /\/(zones|regions)\/([^/]+)\/instanceGroups\/([^/]+)$/;
const ZONAL_NEG = /\/zones\/([^/]+)\/networkEndpointGroups\/([^/]+)$/;
// The NEG types whose endpoints are VMs: an Application Load Balancer's, and a passthrough Network Load Balancer's.
const NEGS_OF_VMS = new Set(['GCE_VM_IP_PORT', 'GCE_VM_IP']);
const UNSEEN_TARGET = /\/(targetPools|targetInstances)\/[^/]+$/;

const nameOf = (url: string | undefined) => (url ?? '').slice((url ?? '').lastIndexOf('/') + 1);
const pathOf = (url: string) => url.slice(Math.max(url.indexOf('projects/'), 0));
const regionOfZone = (zone: string) => zone.replace(/-[a-z]$/, '');
const regionOfScope = (scope: string) => (scope === 'global' ? 'global' : scope.startsWith('zones/') ? regionOfZone(scope.slice(6)) : scope.replace(/^regions\//, ''));

interface Page<T> { items?: T[]; nextPageToken?: string }
interface AggregatedPage { items?: Record<string, Record<string, unknown> & { warning?: { code?: string } }>; unreachables?: string[]; nextPageToken?: string }

export type BackingCandidate = Pick<StandaloneRule, 'id' | 'region'> & { backend: Pick<StandaloneRule['backend'], 'kind' | 'id' | 'location'> };

export async function standaloneBackingProblems(call: Call, project: string, c: BackingCandidate): Promise<string[]> {
  const kind = c.backend.kind;
  if (kind !== 'instance' && kind !== 'asg') return [];
  const label = kind === 'instance' ? `VM ${c.backend.id}` : `managed group ${c.backend.id}`;

  // An aggregated list with the scopes it missed (unreachable, or a warning other than "no results").
  async function aggregated<T>(resource: string): Promise<{ items: { scope: string; item: T }[]; missed: string[] }> {
    const items: { scope: string; item: T }[] = [];
    const missed: string[] = [];
    let token: string | undefined;
    do {
      const query = new URLSearchParams({ returnPartialSuccess: 'true', ...(token ? { pageToken: token } : {}) });
      const page = await call<AggregatedPage>('GET', `${COMPUTE}/projects/${project}/aggregated/${resource}?${query}`);
      for (const [scope, entry] of Object.entries(page.items ?? {})) {
        for (const item of (entry[resource] ?? []) as T[]) items.push({ scope, item });
        if (entry.warning?.code && entry.warning.code !== 'NO_RESULTS_ON_PAGE') missed.push(scope);
      }
      for (const u of page.unreachables ?? []) missed.push(/(?:^|\/)(global|(?:regions|zones)\/[a-z0-9-]+)$/.exec(u)?.[1] ?? 'global');
      token = page.nextPageToken || undefined;
    } while (token);
    return { items, missed };
  }
  async function pages<T>(url: string, body: unknown): Promise<T[]> {
    const out: T[] = [];
    let token: string | undefined;
    do {
      const page = await call<Page<T>>('POST', `${url}${token ? `?${new URLSearchParams({ pageToken: token })}` : ''}`, body);
      out.push(...(page.items ?? []));
      token = page.nextPageToken || undefined;
    } while (token);
    return out;
  }

  const [services, rules] = await Promise.all([
    aggregated<{ name: string; backends?: { group?: string }[] }>('backendServices'),
    aggregated<{ name: string; target?: string }>('forwardingRules'),
  ]);
  const problems: string[] = [];
  const missed = [...services.missed, ...rules.missed].find((s) => s === 'global' || regionOfScope(s) === c.region);
  if (missed) problems.push(`${label}: its load balancers could not be read: ${missed}`);

  // The VMs that are the resource: the VM, or the group's (its manager's own target pools first).
  let vms: string[];
  let group: string | null = null;
  if (kind === 'instance') vms = [c.id];
  else {
    const manager = await call<{ instanceGroup?: string; targetPools?: string[] }>('GET', `${COMPUTE}/${c.id}`);
    problems.push(...(manager.targetPools ?? []).map((pool) => `${label} is in target pool ${nameOf(pool)}: it belongs to a load balancer`));
    group = manager.instanceGroup ? pathOf(manager.instanceGroup) : null;
    vms = [];
    let token: string | undefined;
    do {
      const page = await call<{ managedInstances?: { instance?: string }[]; nextPageToken?: string }>('POST', `${COMPUTE}/${c.id}/listManagedInstances${token ? `?${new URLSearchParams({ pageToken: token })}` : ''}`, {});
      vms.push(...(page.managedInstances ?? []).flatMap((m) => (m.instance ? [pathOf(m.instance)] : [])));
      token = page.nextPageToken || undefined;
    } while (token);
  }
  if (kind === 'instance') {
    // A target pool that lists it, a target instance that points at it (final review I2); either listing refused or missing the
    // VM's region, a forwarding rule to one in its region refuses it.
    const quietly = <T>(resource: string) => aggregated<T>(resource).then((r) => ({ ...r, refused: false }), () => ({ items: [] as { scope: string; item: T }[], missed: [] as string[], refused: true }));
    const [pools, targets] = await Promise.all([quietly<{ name: string; instances?: string[] }>('targetPools'), quietly<{ name: string; instance?: string }>('targetInstances')]);
    for (const { item } of pools.items) if ((item.instances ?? []).some((u) => pathOf(u) === c.id)) problems.push(`${label} serves target pool ${item.name}: it belongs to a load balancer`);
    for (const { item } of targets.items) if (item.instance && pathOf(item.instance) === c.id) problems.push(`${label} serves target instance ${item.name}: it belongs to a load balancer`);
    const notRead = [pools, targets].some((r) => r.refused || r.missed.some((s) => s === 'global' || regionOfScope(s) === c.region));
    const unseen = notRead ? rules.items.filter(({ scope, item }) => regionOfScope(scope) === c.region && UNSEEN_TARGET.test(item.target ?? '')).map(({ item }) => item.name).sort() : [];
    if (unseen.length) problems.push(`${label}: its region has a load balancer the manager cannot read (a target pool or a target instance): forwarding rule ${unseen[0]}`);
  }

  const zones = new Set(vms.map((vm) => /\/zones\/([^/]+)\//.exec(vm)?.[1] ?? ''));
  const regions = new Set([...zones].map(regionOfZone));
  const backs = new Set<string>();
  for (const { item: service } of services.items) {
    for (const b of service.backends ?? []) {
      const url = b.group ?? '';
      const ig = INSTANCE_GROUP.exec(url);
      if (ig) {
        if (group && pathOf(url) === group) { backs.add(service.name); continue; }
        // Only a group where the resource's VMs can be: its zone, or its region for a regional group.
        if (!(ig[1] === 'zones' ? zones.has(ig[2]!) : regions.has(ig[2]!))) continue;
        const members = await pages<{ instance?: string }>(`${COMPUTE}/${pathOf(url)}/listInstances`, { instanceState: 'ALL' });
        if (members.some((m) => m.instance && vms.includes(pathOf(m.instance)))) backs.add(service.name);
        continue;
      }
      const neg = ZONAL_NEG.exec(url);
      if (!neg || !zones.has(neg[1]!)) continue;
      const found = await call<{ networkEndpointType?: string }>('GET', `${COMPUTE}/${pathOf(url)}`);
      if (!NEGS_OF_VMS.has(String(found.networkEndpointType))) continue;
      const endpoints = await pages<{ networkEndpoint?: { instance?: string } }>(`${COMPUTE}/${pathOf(url)}/listNetworkEndpoints`, {});
      if (endpoints.some((e) => e.networkEndpoint?.instance && vms.includes(`projects/${project}/zones/${neg[1]}/instances/${nameOf(e.networkEndpoint.instance)}`))) backs.add(service.name);
    }
  }
  return [...[...backs].sort().map((s) => `${label} backs backend service ${s}: it belongs to an HTTP workload`), ...problems];
}

// Why a Google Cloud standalone candidate cannot be onboarded now, or null: onboarded already, ineligible, or no longer pending in
// scope (out of scope, excluded, dismissed, gone; final review I3), each in words that say what to do. The API's and the
// operation's one rule.
export function standaloneOnboardRefusal(c: Pick<StandaloneRule, 'id' | 'eligibility' | 'reason' | 'workloadId'> & { status?: string; statusReason?: string }): string | null {
  const no = (why: string) => `cannot onboard ${c.id}: ${why}`;
  if (c.eligibility === 'managed' || c.status === 'managed' || c.status === 'pending-offboarding') return no(`it is onboarded already${c.workloadId ? ` (workload ${c.workloadId})` : ''}`);
  if (c.eligibility === 'ineligible' || c.status === 'ineligible') return no(c.reason ?? 'the last discovery run found it ineligible');
  const reason = c.statusReason ? ` (${c.statusReason})` : '';
  if (c.status === 'out-of-scope') return no(`it is out of scope${reason}: bring it into the discovery perimeter with Standalone resources on, run discovery, then onboard it`);
  if (c.status === 'excluded') return no(`it is excluded${reason}: lift the exclusion, run discovery, then onboard it`);
  if (c.status === 'dismissed') return no('it is dismissed: restore it, then onboard it');
  if (c.status === 'gone') return no('the last discovery run did not find it');
  if (c.status !== undefined && c.status !== 'pending-onboarding') return no(`its status is ${c.status}`);
  return null;
}
