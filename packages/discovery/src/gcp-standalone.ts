// A Google Cloud project's standalone candidates (vision standalone workloads design §6; plan 5, M50): the Compute Engine VMs
// outside a managed instance group, the managed instance groups and the Cloud SQL instances, each a candidate of its own
// resource by its path (router gcp/src/resources.mjs), eligible, ineligible in the router's words (router gcp/src/onboarding.mjs
// vmResourceProblems and resourceRead, cloudsql.mjs companionProblem), managed when a router's row names it as its resource.
//
// The scan is the safety net the router cannot be (plan 5's ruling): the router holds no backendServices.list, so a VM or a group
// that backs any backend service, global or regional, managed or not, is never eligible here. One that backs a backend service a
// URL map names is that HTTP candidate's backend and is left out; one that backs another is listed ineligible, with what backs it.
//
// Its idle share: the router's default signals (gcp/src/idle-signals.mjs, lambda/src/lib/settings-levels.mjs builtInsOf) over
// the 168 hours to the last hour 10 minutes behind, in Cloud Monitoring's 5-minute points: a VM's CPU, each VM of a group's, a
// Cloud SQL instance's connections. An hour is idle when every series has its 12 points, each under its threshold (the M43 rule);
// a candidate with no point all week has no share; a read that fails keeps the stored share and is said in the run.
import { GoogleError } from '@dormeto/google';
import { errorText } from './error-text.js';
import type { GooglePort } from './google.js';
import type { ResourceKind, StandaloneRule } from './types.js';

type Call = GooglePort['call'];

// ---- The router's words and rules (router gcp/src/onboarding.mjs, cloudsql.mjs and idle-signals.mjs at 84b1038) ----
const GKE_NODE_LABEL = 'goog-gke-node';
const LOCAL_SSD = 'SCRATCH';
const MANAGED_GROUP_OWNER = /\/instanceGroupManagers\/([^/]+)$/;
const REPLICA = 'READ_REPLICA_INSTANCE';
const CPU = 'compute.googleapis.com/instance/cpu/utilization';
// settings-levels.mjs CLOUD_SQL_CONNECTIONS: a Cloud SQL resource's built-in signal (its CPU off), under 1.
const CONNECTIONS = 'cloudsql.googleapis.com/database/network/connections';
// STANDALONE_BUILT_IN: a VM's or a group's CPU under 5 %.
const CPU_PERCENT = 5;
const CONNECTIONS_BELOW = 1;

const SQLADMIN = 'https://sqladmin.googleapis.com/v1';
const MONITORING = 'https://monitoring.googleapis.com/v3';
const HOUR_MS = 3_600_000;
const HOURS = 168;
const PERIOD_MS = 300_000;
const POINTS = HOUR_MS / PERIOD_MS;
const METRIC_LAG_MS = 600_000;
// A Monitoring filter's one_of: at most this many values a call.
const ONE_OF = 100;
// The connect command a missing permission asks for (the CLI's: dormeto gcp connect).
const CONNECT_AGAIN = 'run dormeto gcp connect again: it gives the discovery account the permissions of this release';

// ---- Google's answers, the fields read ----
export interface GInstance {
  name: string; selfLink: string; zone?: string; labels?: Record<string, string>; status?: string;
  metadata?: { items?: { key?: string; value?: string }[] }; disks?: { type?: string }[]; guestAccelerators?: unknown[];
}
export interface GManager {
  name: string; selfLink?: string; zone?: string; region?: string; instanceGroup?: string; targetSize?: number;
  status?: { stateful?: { hasStatefulConfig?: boolean } }; distributionPolicy?: { targetShape?: string }; updatePolicy?: { instanceRedistributionType?: string };
}
export interface SqlInstance { name: string; region?: string; masterInstanceName?: string; instanceType?: string; settings?: { userLabels?: Record<string, string> } }
// A router's row (WS#…) of a standalone workload: its resource's path.
export interface StandaloneRow { workloadId: string; kind?: string; resource?: string }

const nameOf = (url: string | undefined) => (url ?? '').slice((url ?? '').lastIndexOf('/') + 1);
const pathOf = (url: string) => url.slice(Math.max(url.indexOf('projects/'), 0));
const regionOfZone = (zone: string) => zone.replace(/-[a-z]$/, '');
// A VM's managed group by its created-by metadata (projects/<number>/zones|regions/<l>/instanceGroupManagers/<n>): its scope.
const createdBy = (vm: GInstance) => vm.metadata?.items?.find((i) => i.key === 'created-by')?.value ?? '';
const ownerScope = (vm: GInstance) => /\/((?:zones|regions)\/[^/]+\/instanceGroupManagers\/[^/]+)$/.exec(createdBy(vm))?.[1];
const managerScope = (m: GManager) => (m.zone ? `zones/${nameOf(m.zone)}` : `regions/${nameOf(m.region)}`);
const tagsOf = (labels: Record<string, string>[]) => {
  const out: Record<string, string[]> = {};
  for (const set of labels) for (const [k, v] of Object.entries(set)) if (!(out[k] ??= []).includes(v)) out[k].push(v);
  return out;
};

// What backs the project's backend services: VMs and managed groups by path, with the backend service and whether a URL map
// names it (an HTTP candidate's backend).
export interface Backing { vms: Map<string, { service: string; candidate: boolean }>; groups: Map<string, { service: string; candidate: boolean }> }

// The Cloud SQL instances of the project, or why they could not be listed (the AWS RDS lists' form, M42): a 403 is the
// discovery account's missing permission or the Cloud SQL Admin API not enabled, told apart when Google says which.
export async function listCloudSql(call: Call, project: string): Promise<{ instances: SqlInstance[] } | { problem: string }> {
  const out: SqlInstance[] = [];
  try {
    let token: string | undefined;
    do {
      const page = await call<{ items?: SqlInstance[]; nextPageToken?: string }>('GET', `${SQLADMIN}/projects/${project}/instances${token ? `?${new URLSearchParams({ pageToken: token })}` : ''}`);
      out.push(...(page.items ?? []));
      token = page.nextPageToken || undefined;
    } while (token);
    return { instances: out };
  } catch (err) {
    const what = 'Cloud SQL instances not listed';
    if (err instanceof GoogleError && err.status === 403) {
      if (err.reason === 'SERVICE_DISABLED' || err.reason === 'accessNotConfigured') return { problem: `${what}: the Cloud SQL Admin API (sqladmin.googleapis.com) is not enabled in project ${project}` };
      if (err.reason === 'IAM_PERMISSION_DENIED' || err.code === 'PERMISSION_DENIED' || err.reason === 'forbidden' || err.reason === 'notAuthorized') return { problem: `${what}: the discovery account may not call cloudsql.instances.list (${CONNECT_AGAIN})` };
      return { problem: `${what}: the discovery account may not call cloudsql.instances.list, or the Cloud SQL Admin API (sqladmin.googleapis.com) is not enabled in project ${project} (${CONNECT_AGAIN}, or enable the API): ${err.message}` };
    }
    return { problem: `${what}: ${errorText(err)}` };
  }
}

// The candidates, in kind order (VMs, groups, Cloud SQL), each by its path. `sql`: the list read, or null when it could not be.
export function standaloneRules({ project, instances, managers, sql, backing, rows }: {
  project: string; instances: GInstance[]; managers: GManager[]; sql: SqlInstance[] | null; backing: Backing; rows: StandaloneRow[];
}): StandaloneRule[] {
  const own = new Map(rows.filter((r) => r.kind === 'standalone' && typeof r.resource === 'string').map((r) => [r.resource!, r.workloadId]));
  const rules: StandaloneRule[] = [];
  const settle = (rule: Omit<StandaloneRule, 'kind' | 'account' | 'cloud' | 'eligibility' | 'idleHours7d' | 'resource'>, reasons: string[]) => {
    const workloadId = own.get(rule.id);
    rules.push({
      kind: 'standalone', ...rule, account: project, resource: rule.id, cloud: 'gcp',
      ...(workloadId ? { eligibility: 'managed' as const, workloadId } : { eligibility: reasons.length ? 'ineligible' as const : 'eligible' as const }),
      ...(!workloadId && reasons.length ? { reason: reasons.join('; ') } : {}),
      idleHours7d: null,
    });
  };
  const backs = (label: string, by: { service: string } | undefined) => (by ? [`${label} backs backend service ${by.service}: it belongs to an HTTP workload`] : []);

  // A VM: an HTTP candidate's backend left out; else vmResourceProblems (its group, a GKE node, a GPU, a local SSD).
  const members = new Map<string, GInstance[]>();
  for (const vm of [...instances].sort((a, b) => pathOf(a.selfLink).localeCompare(pathOf(b.selfLink)))) {
    const path = pathOf(vm.selfLink);
    const owner = ownerScope(vm);
    if (owner) members.set(owner, [...(members.get(owner) ?? []), vm]);
    const by = backing.vms.get(path);
    if (by?.candidate && !own.has(path)) continue;
    const zone = /\/zones\/([^/]+)\/instances\//.exec(path)?.[1] ?? '';
    const label = `VM ${vm.name}`;
    const groupName = MANAGED_GROUP_OWNER.exec(createdBy(vm))?.[1];
    // A group's member is its group's: listed (ineligible, as the router says), unless the group is left out or managed.
    if (groupName && owner) {
      const group = managers.find((m) => `${managerScope(m)}/instanceGroupManagers/${m.name}` === owner);
      const groupPath = group ? `projects/${project}/${owner}` : undefined;
      if (groupPath && (own.has(groupPath) || backing.groups.get(groupPath)?.candidate)) continue;
    }
    const reasons = [
      ...backs(label, by),
      ...(groupName ? [`${label} is a member of managed group ${groupName}: onboard the group (it would repair a stopped VM)`] : []),
      ...(Object.hasOwn(vm.labels ?? {}, GKE_NODE_LABEL) ? [`${label} is a GKE node: onboard the Kubernetes workloads that run on it`] : []),
      ...(vm.guestAccelerators?.length ? [`${label} has a GPU: GPU VMs are not supported`] : []),
      ...(vm.disks?.some((d) => d.type === LOCAL_SSD) ? [`${label} has a local SSD: a stop would lose its data`] : []),
    ];
    settle({ id: path, region: regionOfZone(zone), name: vm.name, backend: { kind: 'instance', id: vm.name, location: zone }, tags: tagsOf([vm.labels ?? {}]) }, reasons);
  }

  // A managed group: resourceRead's mig (stateful, a regional EVEN shape with redistribution on, GKE nodes). One sized 0 is eligible
  // (router 5be13fa: it is onboarded awake).
  for (const m of [...managers].sort((a, b) => `${managerScope(a)}/${a.name}`.localeCompare(`${managerScope(b)}/${b.name}`))) {
    const scope = managerScope(m);
    const path = `projects/${project}/${scope}/instanceGroupManagers/${m.name}`;
    const by = backing.groups.get(path);
    if (by?.candidate && !own.has(path)) continue;
    const label = `managed group ${m.name}`;
    const vms = members.get(`${scope}/instanceGroupManagers/${m.name}`) ?? [];
    const regional = scope.startsWith('regions/');
    const location = nameOf(m.zone ?? m.region);
    const reasons = [
      ...backs(label, by),
      ...(m.status?.stateful?.hasStatefulConfig ? [`${label} has a stateful configuration: a nap might not keep it`] : []),
      ...(regional && (m.distributionPolicy?.targetShape ?? 'EVEN') === 'EVEN' && (m.updatePolicy?.instanceRedistributionType ?? 'PROACTIVE') !== 'NONE'
        ? [`regional ${label} has the target shape EVEN with instance redistribution on: Google cannot stop or suspend its VMs one by one, set its instance redistribution type to NONE or change its target shape, then onboard again`] : []),
      ...(vms.some((vm) => Object.hasOwn(vm.labels ?? {}, GKE_NODE_LABEL)) ? [`${label} holds GKE nodes: onboard the Kubernetes workloads that run on them`] : []),
    ];
    settle({ id: path, region: regional ? location : regionOfZone(location), name: m.name, backend: { kind: 'asg', id: m.name, location }, tags: tagsOf(vms.map((vm) => vm.labels ?? {})) }, reasons);
  }

  // A Cloud SQL instance: a read replica cannot be stopped (companionProblem).
  for (const db of [...(sql ?? [])].sort((a, b) => a.name.localeCompare(b.name))) {
    const path = `projects/${project}/instances/${db.name}`;
    const replica = Boolean(db.masterInstanceName) || db.instanceType === REPLICA;
    settle({ id: path, region: db.region ?? 'global', name: db.name, backend: { kind: 'cloudsql-instance', id: db.name }, tags: tagsOf([db.settings?.userLabels ?? {}]) },
      replica ? [`Cloud SQL instance ${db.name} is a read replica: Google cannot stop one`] : []);
  }
  return rules;
}

// ---- The idle share ----

// A candidate's series: its VMs (zone/name) or its Cloud SQL instance (project:name), each under its threshold.
export interface IdleTarget { id: string; kind: ResourceKind; vms: { zone: string; name: string }[]; database?: string }

interface Series { metric?: { labels?: Record<string, string> }; resource?: { labels?: Record<string, string> }; points?: { interval?: { endTime?: string }; value?: { doubleValue?: number; int64Value?: string | number } }[] }

// shares: each target read, its idle hours of the week (null: no point at all); failed: the targets of a call that failed.
export async function standaloneIdleOf(call: Call, { project, targets, now }: { project: string; targets: IdleTarget[]; now: () => number }) {
  const end = Math.floor((now() - METRIC_LAG_MS) / HOUR_MS) * HOUR_MS;
  const start = end - HOURS * HOUR_MS;
  const points = new Map<string, Map<number, number>>(); // series key -> point start -> value
  const shares = new Map<string, number | null>();
  const failed: { ids: string[]; error: string }[] = [];
  const unread = new Set<string>();

  // One read: a metric over a list of values, its series keyed by `key`, the values scaled; a failure marks its targets.
  async function read(type: string, filter: string, key: (s: Series) => string, scale: (v: number) => number, ids: string[]) {
    try {
      let token: string | undefined;
      do {
        const query = new URLSearchParams({
          filter: `metric.type = "${type}" AND ${filter}`,
          'interval.startTime': new Date(start).toISOString(),
          'interval.endTime': new Date(end).toISOString(),
          'aggregation.alignmentPeriod': `${PERIOD_MS / 1000}s`,
          'aggregation.perSeriesAligner': 'ALIGN_MAX',
          ...(token ? { pageToken: token } : {}),
        });
        const page = await call<{ timeSeries?: Series[]; nextPageToken?: string }>('GET', `${MONITORING}/projects/${project}/timeSeries?${query}`);
        for (const series of page.timeSeries ?? []) {
          const at = points.get(key(series)) ?? new Map<number, number>();
          for (const point of series.points ?? []) {
            // An aligned point is its period's: its interval's end minus the period (the router's reading).
            const t = Date.parse(point.interval?.endTime ?? '') - PERIOD_MS;
            const v = Number(point.value?.doubleValue ?? point.value?.int64Value);
            if (Number.isFinite(t) && Number.isFinite(v) && t >= start && t < end) at.set(t, Math.max(at.get(t) ?? -Infinity, scale(v)));
          }
          points.set(key(series), at);
        }
        token = page.nextPageToken || undefined;
      } while (token);
    } catch (err) {
      for (const id of ids) unread.add(id);
      failed.push({ ids, error: errorText(err) });
    }
  }
  const quoted = (v: string) => JSON.stringify(v);
  const chunks = <T>(list: T[]) => Array.from({ length: Math.ceil(list.length / ONE_OF) }, (_, i) => list.slice(i * ONE_OF, (i + 1) * ONE_OF));
  // The VMs by name, their zone telling two of a name apart.
  const vmTargets = targets.filter((t) => t.vms.length);
  const names = [...new Set(vmTargets.flatMap((t) => t.vms.map((vm) => vm.name)))].sort();
  const dbTargets = targets.filter((t) => t.database);
  const databases = [...new Set(dbTargets.map((t) => `${project}:${t.database}`))].sort();
  const owners = (list: string[], match: (t: IdleTarget, v: string) => boolean, from: IdleTarget[]) => from.filter((t) => list.some((v) => match(t, v))).map((t) => t.id);
  await Promise.all([
    ...chunks(names).map((list) => read(CPU, `resource.type = "gce_instance" AND metric.labels.instance_name = one_of(${list.map(quoted).join(', ')})`,
      (s) => `vm:${s.resource?.labels?.zone ?? ''}/${s.metric?.labels?.instance_name ?? ''}`, (v) => v * 100, owners(list, (t, v) => t.vms.some((vm) => vm.name === v), vmTargets))),
    ...chunks(databases).map((list) => read(CONNECTIONS, `resource.type = "cloudsql_database" AND resource.labels.database_id = one_of(${list.map(quoted).join(', ')})`,
      (s) => `db:${s.resource?.labels?.database_id ?? ''}`, (v) => v, owners(list, (t, v) => `${project}:${t.database}` === v, dbTargets))),
  ]);

  for (const t of targets) {
    if (unread.has(t.id)) continue;
    const series = t.database ? [{ key: `db:${project}:${t.database}`, below: CONNECTIONS_BELOW }] : t.vms.map((vm) => ({ key: `vm:${vm.zone}/${vm.name}`, below: CPU_PERCENT }));
    if (!series.length || series.every((s) => !points.get(s.key)?.size)) {
      shares.set(t.id, null);
      continue;
    }
    let idle = 0;
    for (let h = 0; h < HOURS; h += 1) {
      const hour = start + h * HOUR_MS;
      const under = series.every((s) => Array.from({ length: POINTS }, (_, p) => points.get(s.key)?.get(hour + p * PERIOD_MS)).every((v) => v !== undefined && v < s.below));
      if (under) idle += 1;
    }
    shares.set(t.id, idle);
  }
  return { shares, failed };
}

// A candidate's idle target: its VMs (a VM's own, a group's members by their created-by), or its Cloud SQL instance.
export function idleTargetOf(rule: StandaloneRule, instances: GInstance[]): IdleTarget {
  if (rule.backend.kind === 'cloudsql-instance') return { id: rule.id, kind: rule.backend.kind, vms: [], database: rule.backend.id };
  if (rule.backend.kind === 'instance') return { id: rule.id, kind: rule.backend.kind, vms: [{ zone: rule.backend.location ?? '', name: rule.backend.id }] };
  // projects/<p>/<zones|regions>/<l>/instanceGroupManagers/<n>: the part after the project, as created-by ends.
  const scope = rule.id.split('/').slice(2).join('/');
  const vms = instances.filter((vm) => ownerScope(vm) === scope).map((vm) => ({ zone: /\/zones\/([^/]+)\//.exec(pathOf(vm.selfLink))?.[1] ?? '', name: vm.name }));
  return { id: rule.id, kind: rule.backend.kind, vms };
}
