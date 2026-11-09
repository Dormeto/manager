// A project's scan (Google Cloud manager design §7.2, §7.3): its load balancers read as the discovery account, one candidate
// per backend service a URL map names, eligible, ineligible in the router's words (router gcp/src/onboarding.mjs, gke.mjs,
// urlmaps.mjs), or managed by a router's workload.
import { describe, expect, it } from 'vitest';
import { GoogleError } from '@dormeto/google';
import type { WorkloadSummary } from '@dormeto/fleet';
import type { InstalledRouter } from '@dormeto/fleet/registry';
import { scanProject } from '../src/gcp-scan.js';
import type { GooglePort } from '../src/google.js';
import { planRun, scanAccount } from '../src/run.js';
import type { ScannedRule } from '../src/types.js';
import { config, filter } from './fixtures.js';
import { devProject, PROJECT, workloadRow, type ComputeWorld } from './gcp-fakes.js';
import { HOUR, setup } from './run-fakes.js';

const NOW = () => Date.UTC(2026, 10, 9, 12);
// dmt-demo-app is onboarded on the router of europe-west2 (the demo's map names its waker).
const ONBOARDED = [workloadRow('dmt-demo-app')];
const scan = (w: ComputeWorld, managed: WorkloadSummary[] = ONBOARDED) => scanProject(w, { project: w.project, managed, now: NOW });
const named = (rules: ScannedRule[], name: string) => rules.find((r) => r.targetGroup === name);
const GKE = 'a GKE workload is onboarded with dormeto gcp workloads onboard, after dormeto gcp workloads access grant';
const DEMO_GROUP = 'zones/europe-west1-b/instanceGroups/dmt-demo';

// A load balancer of its own for a service: its URL map naming it as the default, a target proxy and a forwarding rule.
function alone(w: ComputeWorld, map: string, service: string, { region, scheme, proxy = 'http' }: { region?: string; scheme?: string; proxy?: 'http' | 'https' } = {}) {
  w.urlMap(map, { defaultService: w.service(service, region) }, { region });
  w.front(map, { region, scheme, proxy });
}

describe('a Google Cloud project\'s scan', () => {
  it('dmt-demo-mig-app in dmt-dev: eligible, its managed group as backend, its host, a global load balancer, its path as id', async () => {
    const w = devProject();
    const { rules, regions } = await scan(w);
    expect(named(rules, 'dmt-demo-mig-app')).toEqual({
      id: 'projects/dormeto-dev/global/backendServices/dmt-demo-mig-app',
      account: PROJECT,
      region: 'global',
      loadBalancer: 'dmt-dev',
      loadBalancerArn: '',
      listener: '',
      priority: '',
      conditions: 'hosts mig.gcp.dev.dormeto.com; paths /*',
      hosts: ['mig.gcp.dev.dormeto.com'],
      targetGroup: 'dmt-demo-mig-app',
      targetGroupArn: null,
      backend: { kind: 'asg', id: 'dmt-demo-mig' },
      tags: { env: ['dev'], app: ['demo-mig'] },
      rules: [],
      eligibility: 'eligible',
      idleHours7d: 168,
      requests7d: 0,
      backendService: 'projects/dormeto-dev/global/backendServices/dmt-demo-mig-app',
      urlMap: 'projects/dormeto-dev/global/urlMaps/dmt-dev',
      lb: { kind: 'global' },
    });
    // Onboarded: managed, its waker's /_dormeto/* route being Dormeto's own; the map's default reaches it too.
    const app = named(rules, 'dmt-demo-app')!;
    expect(app).toMatchObject({ eligibility: 'managed', workloadId: 'dmt-demo-app', backend: { kind: 'instance', id: 'dmt-demo' }, hosts: ['gcp.dev.dormeto.com', '*'], conditions: 'hosts gcp.dev.dormeto.com, *; paths /*', tags: { env: ['dev'], app: ['demo'] } });
    expect(app.reason).toBeUndefined();
    // dmt-demo-standin is named by no URL map.
    expect(rules.map((r) => r.targetGroup).sort()).toEqual(['dmt-demo-app', 'dmt-demo-mig-app']);
    // The regions where it has something: the global load balancer, the VMs and the group of europe-west1.
    expect(regions).toEqual([{ region: 'europe-west1', ok: true }, { region: 'global', ok: true }]);
    // Seven aggregated lists, then the groups the backend services name: nothing of the router's waker.
    const aggregated = w.calls.filter((c) => c.includes('/aggregated/'));
    expect(aggregated.map((c) => c.replace(/^GET .*\/aggregated\//, '')).sort()).toEqual(
      ['backendServices', 'forwardingRules', 'instanceGroupManagers', 'instances', 'targetHttpProxies', 'targetHttpsProxies', 'urlMaps'].map((r) => `${r}?returnPartialSuccess=true`),
    );
    expect(w.calls.filter((c) => !c.includes('/aggregated/') && !c.includes('monitoring.googleapis.com')).sort()).toEqual([
      'POST https://compute.googleapis.com/compute/v1/projects/dormeto-dev/zones/europe-west1-b/instanceGroups/dmt-demo-mig/listInstances',
      'POST https://compute.googleapis.com/compute/v1/projects/dormeto-dev/zones/europe-west1-b/instanceGroups/dmt-demo/listInstances',
    ]);
  });

  it('a backend service in two URL maps: the router\'s reason, naming the other map', async () => {
    const w = devProject();
    alone(w, 'dmt-dev-b', 'dmt-demo-mig-app');
    const c = named((await scan(w)).rules, 'dmt-demo-mig-app');
    expect(c).toMatchObject({
      loadBalancer: 'dmt-dev', eligibility: 'ineligible',
      reason: 'backend service dmt-demo-mig-app is also named in URL map dmt-dev-b: that load balancer would lose its backends during a nap; give it a backend service of its own',
    });
  });

  it('a serverless NEG: the router\'s reason for its backend type, and no backend', async () => {
    const w = devProject();
    w.backendService('dmt-demo-run', [w.link('regions/europe-west1/networkEndpointGroups/dmt-demo-run')]);
    alone(w, 'dmt-dev-run', 'dmt-demo-run');
    expect(named((await scan(w)).rules, 'dmt-demo-run')).toMatchObject({
      eligibility: 'ineligible', backend: null,
      reason: 'backend dmt-demo-run of backend service dmt-demo-run is a regional network endpoint group (serverless, private service connect): only zonal network endpoint groups of VMs and instance groups are supported',
    });
  });

  it('a GKE NEG: kind k8s, onboarded with the CLI; its endpoints, pods, are not read', async () => {
    const w = devProject();
    const description = JSON.stringify({ 'cluster-uid': '6d1c9a3e-41f2-4c1b-9b7e-0f8b2a1c5d3e', namespace: 'default', 'service-name': 'dmt-demo-gke', port: '80' });
    w.backendService('dmt-demo-gke', [w.neg('dmt-demo-gke', 'europe-west1-b', { description })]);
    alone(w, 'dmt-dev-gke', 'dmt-demo-gke');
    // GKE's own name for a NEG it made, without a description.
    w.backendService('dmt-demo-gke-b', [w.neg('k8s1-6d1c9a3e-default-dmt-demo-gke-b-80-0f8b2a1c', 'europe-west1-b')]);
    alone(w, 'dmt-dev-gke-b', 'dmt-demo-gke-b');
    const { rules } = await scan(w);
    expect(named(rules, 'dmt-demo-gke')).toMatchObject({ backend: { kind: 'k8s', id: 'dmt-demo-gke' }, eligibility: 'ineligible', reason: GKE });
    expect(named(rules, 'dmt-demo-gke-b')).toMatchObject({ backend: { kind: 'k8s', id: 'k8s1-6d1c9a3e-default-dmt-demo-gke-b-80-0f8b2a1c' }, reason: GKE });
    expect(w.calls.filter((c) => c.endsWith('/listNetworkEndpoints'))).toEqual([]);
    // Onboarded with the CLI: managed, without that reason.
    const cli = named((await scan(w, [...ONBOARDED, workloadRow('dmt-demo-gke', { urlMap: 'dmt-dev-gke', source: 'cli' })])).rules, 'dmt-demo-gke')!;
    expect([cli.eligibility, cli.reason, cli.backend]).toEqual(['managed', undefined, { kind: 'k8s', id: 'dmt-demo-gke' }]);
  });

  it('a NEG of VMs: kind instance, the labels of the VMs it names; another type: the router\'s reason', async () => {
    const w = devProject();
    w.vm('dmt-demo-neg', 'europe-west1-b', { env: 'dev', app: 'neg' });
    w.backendService('dmt-demo-neg', [w.neg('dmt-demo-neg', 'europe-west1-b', { vms: ['dmt-demo-neg'] })]);
    alone(w, 'dmt-dev-neg', 'dmt-demo-neg');
    w.backendService('dmt-demo-hybrid', [w.neg('dmt-demo-hybrid', 'europe-west1-b', { type: 'NON_GCP_PRIVATE_IP_PORT' })]);
    alone(w, 'dmt-dev-hybrid', 'dmt-demo-hybrid');
    const { rules } = await scan(w);
    expect(named(rules, 'dmt-demo-neg')).toMatchObject({ eligibility: 'eligible', backend: { kind: 'instance', id: 'dmt-demo-neg' }, tags: { env: ['dev'], app: ['neg'] } });
    expect(named(rules, 'dmt-demo-hybrid')).toMatchObject({
      backend: null, eligibility: 'ineligible',
      reason: 'network endpoint group dmt-demo-hybrid of backend service dmt-demo-hybrid has the type NON_GCP_PRIVATE_IP_PORT: only GCE_VM_IP_PORT is supported, take it out of the backend service',
    });
  });

  it('one NEG of another type behind two backend services: each one\'s reason names its own service, the NEG read once', async () => {
    const w = devProject();
    const neg = w.neg('dmt-demo-hybrid', 'europe-west1-b', { type: 'NON_GCP_PRIVATE_IP_PORT' });
    for (const name of ['dmt-demo-hybrid-a', 'dmt-demo-hybrid-b']) {
      w.backendService(name, [neg]);
      alone(w, `dmt-dev-${name.slice(9)}`, name);
    }
    const { rules } = await scan(w);
    const why = (service: string) => `network endpoint group dmt-demo-hybrid of backend service ${service} has the type NON_GCP_PRIVATE_IP_PORT: only GCE_VM_IP_PORT is supported, take it out of the backend service`;
    expect([named(rules, 'dmt-demo-hybrid-a')!.reason, named(rules, 'dmt-demo-hybrid-b')!.reason]).toEqual([why('dmt-demo-hybrid-a'), why('dmt-demo-hybrid-b')]);
    expect(w.calls.filter((c) => c.endsWith('/networkEndpointGroups/dmt-demo-hybrid'))).toHaveLength(1);
  });

  it('a URL map\'s own error response policy where it names the service: the router\'s reason', async () => {
    const w = devProject();
    const policy = { errorResponseRules: [{ matchResponseCodes: ['5xx'], path: '/oops.html', overrideResponseCode: 503 }], errorService: w.link('global/backendBuckets/dmt-dev-errors') };
    for (const name of ['dmt-demo-rule-policy', 'dmt-demo-matcher-policy']) w.backendService(name, [w.link(DEMO_GROUP)]);
    w.urlMap('dmt-dev-rule-policy', {
      defaultService: w.service('dmt-demo-rule-policy'),
      hostRules: [{ hosts: ['policy.gcp.dev.dormeto.com'], pathMatcher: 'policy' }],
      pathMatchers: [{ name: 'policy', defaultService: w.service('dmt-demo-rule-policy'), pathRules: [{ paths: ['/api/*'], service: w.service('dmt-demo-rule-policy'), customErrorResponsePolicy: policy }] }],
    });
    w.front('dmt-dev-rule-policy');
    w.urlMap('dmt-dev-matcher-policy', {
      defaultService: w.link('global/backendBuckets/dmt-dev-errors'),
      hostRules: [{ hosts: ['matcher.gcp.dev.dormeto.com'], pathMatcher: 'matcher' }],
      pathMatchers: [{ name: 'matcher', defaultService: w.service('dmt-demo-matcher-policy'), defaultCustomErrorResponsePolicy: policy }],
    });
    w.front('dmt-dev-matcher-policy');
    const { rules } = await scan(w);
    expect(named(rules, 'dmt-demo-rule-policy')).toMatchObject({
      eligibility: 'ineligible', conditions: 'hosts policy.gcp.dev.dormeto.com, *; paths /*, /api/*',
      reason: 'the URL map has its own error response policy at pathMatchers[0].pathRules[0].customErrorResponsePolicy: a nap would replace it, remove it first',
    });
    expect(named(rules, 'dmt-demo-matcher-policy')).toMatchObject({
      eligibility: 'ineligible', hosts: ['matcher.gcp.dev.dormeto.com'],
      reason: 'the URL map has its own error response policy at pathMatchers[0].defaultCustomErrorResponsePolicy: a nap would replace it, remove it first',
    });
    // A backend bucket is no backend service: no candidate.
    expect(rules.some((r) => r.targetGroup === 'dmt-dev-errors')).toBe(false);
  });

  it('a URL map\'s own /_dormeto/ route where it names the service: the router\'s reason', async () => {
    const w = devProject();
    for (const name of ['dmt-demo-path', 'dmt-demo-route']) w.backendService(name, [w.link(DEMO_GROUP)]);
    w.urlMap('dmt-dev-path', {
      defaultService: w.service('dmt-demo-path'),
      hostRules: [{ hosts: ['path.gcp.dev.dormeto.com'], pathMatcher: 'm' }],
      pathMatchers: [{ name: 'm', defaultService: w.service('dmt-demo-path'), pathRules: [{ paths: ['/_dormeto/status'], service: w.service('dmt-demo-path') }] }],
    });
    w.front('dmt-dev-path');
    w.urlMap('dmt-dev-route', {
      defaultService: w.service('dmt-demo-route'),
      hostRules: [{ hosts: ['route.gcp.dev.dormeto.com'], pathMatcher: 'm' }],
      pathMatchers: [{ name: 'm', defaultService: w.service('dmt-demo-route'), routeRules: [{ priority: 5, matchRules: [{ prefixMatch: '/_dormeto/' }], service: w.service('dmt-demo-route') }] }],
    });
    w.front('dmt-dev-route');
    const { rules } = await scan(w);
    expect(named(rules, 'dmt-demo-path')!.reason).toBe('the URL map has its own /_dormeto/ route at pathMatchers[0].pathRules[0]: change that, then onboard again');
    expect(named(rules, 'dmt-demo-route')).toMatchObject({
      conditions: 'hosts route.gcp.dev.dormeto.com, *; paths /*, /_dormeto/*',
      reason: 'the URL map has its own /_dormeto/ route at pathMatchers[0].routeRules[0]: change that, then onboard again',
    });
  });

  it('the load balancer\'s kind: classic, internal, cross-region internal; the router\'s reasons when it cannot be told', async () => {
    const w = devProject();
    w.backendService('dmt-demo-classic-app', [w.link(DEMO_GROUP)], { scheme: 'EXTERNAL' });
    alone(w, 'dmt-dev-classic', 'dmt-demo-classic-app', { scheme: 'EXTERNAL' });
    w.vm('dmt-demo-internal', 'europe-west2-b', { env: 'dev' });
    const internal = w.group('dmt-demo-internal', 'europe-west2-b', ['dmt-demo-internal']);
    w.backendService('dmt-demo-internal-app', [internal], { region: 'europe-west2', scheme: 'INTERNAL_MANAGED' });
    alone(w, 'dmt-dev-internal-regional', 'dmt-demo-internal-app', { region: 'europe-west2', scheme: 'INTERNAL_MANAGED' });
    w.backendService('dmt-demo-internal-global', [w.link(DEMO_GROUP)], { scheme: 'INTERNAL_MANAGED' });
    alone(w, 'dmt-dev-internal-global', 'dmt-demo-internal-global', { scheme: 'INTERNAL_MANAGED' });
    // No target proxy; a Cloud Service Mesh rule; a proxy without forwarding rule.
    w.backendService('dmt-demo-orphan', [w.link(DEMO_GROUP)]);
    w.urlMap('dmt-dev-orphan', { defaultService: w.service('dmt-demo-orphan') });
    w.backendService('dmt-demo-mesh', [w.link(DEMO_GROUP)], { scheme: 'INTERNAL_SELF_MANAGED' });
    alone(w, 'dmt-dev-mesh', 'dmt-demo-mesh', { scheme: 'INTERNAL_SELF_MANAGED' });
    const { rules, regions } = await scan(w);
    expect(named(rules, 'dmt-demo-classic-app')).toMatchObject({ lb: { kind: 'classic' }, eligibility: 'eligible', hosts: ['*'], conditions: 'hosts *; paths /*' });
    expect(named(rules, 'dmt-demo-internal-app')).toMatchObject({
      id: 'projects/dormeto-dev/regions/europe-west2/backendServices/dmt-demo-internal-app', region: 'europe-west2', lb: { kind: 'internal' }, eligibility: 'eligible',
      urlMap: 'projects/dormeto-dev/regions/europe-west2/urlMaps/dmt-dev-internal-regional', backendService: 'projects/dormeto-dev/regions/europe-west2/backendServices/dmt-demo-internal-app',
    });
    expect(named(rules, 'dmt-demo-internal-global')).toMatchObject({ region: 'global', lb: { kind: 'cross-region-internal' }, eligibility: 'eligible' });
    expect(named(rules, 'dmt-demo-orphan')).toMatchObject({ eligibility: 'ineligible', reason: 'URL map dmt-dev-orphan is used by no target proxy: attach it to an Application Load Balancer, then onboard again' });
    expect(named(rules, 'dmt-demo-orphan')!.lb).toBeUndefined();
    expect(named(rules, 'dmt-demo-mesh')).toMatchObject({
      eligibility: 'ineligible',
      reason: 'forwarding rule dmt-dev-mesh has the scheme INTERNAL_SELF_MANAGED: only Application Load Balancers are supported: global (EXTERNAL_MANAGED), classic (EXTERNAL), regional (EXTERNAL_MANAGED), internal (INTERNAL_MANAGED) and cross-region-internal (INTERNAL_MANAGED)',
    });
    expect(regions.map((r) => r.region)).toEqual(['europe-west1', 'europe-west2', 'global']);
  });

  it('a load balancer GKE owns, told by its URL map\'s name or by what GKE writes in its descriptions: the router\'s reason', async () => {
    const w = devProject();
    w.backendService('dmt-demo-ingress', [w.link(DEMO_GROUP)]);
    alone(w, 'k8s2-um-4kd0x3la-default-dmt-demo-ingress-6tr3oe5c', 'dmt-demo-ingress');
    w.backendService('dmt-demo-gateway', [w.link(DEMO_GROUP)]);
    w.urlMap('dmt-dev-gateway', { defaultService: w.service('dmt-demo-gateway'), description: '{"k8sResource":"/apis/gateway.networking.k8s.io/v1/namespaces/default/gateways/web"}' });
    w.front('dmt-dev-gateway');
    const { rules } = await scan(w);
    expect(named(rules, 'dmt-demo-ingress')!.reason).toBe('URL map k8s2-um-4kd0x3la-default-dmt-demo-ingress-6tr3oe5c belongs to a load balancer GKE owns (a Gateway or an Ingress): GKE writes it back at its next sync, so a nap\'s switch could not be trusted. Give the Service a standalone network endpoint group with the annotation cloud.google.com/neg, name it in a backend service of a load balancer of your own, and onboard that');
    expect(named(rules, 'dmt-demo-gateway')!.reason).toMatch(/^URL map dmt-dev-gateway belongs to a load balancer GKE owns \(a Gateway or an Ingress\)/);
  });

  it('a backend service without backend: the router\'s reason', async () => {
    const w = devProject();
    w.backendService('dmt-demo-empty', []);
    alone(w, 'dmt-dev-empty', 'dmt-demo-empty');
    expect(named((await scan(w)).rules, 'dmt-demo-empty')).toMatchObject({ backend: null, tags: {}, reason: 'backend service dmt-demo-empty has no backend: add an instance group, then onboard again' });
  });

  it('the router\'s waker backend services and URL maps are never candidates', async () => {
    const w = devProject();
    // A map of the router's name: hidden, whatever it names.
    w.urlMap('dmtr-europe-west2-test', { defaultService: w.service('dmt-demo-standin') });
    w.front('dmtr-europe-west2-test');
    const { rules } = await scan(w);
    expect(rules.map((r) => r.targetGroup).sort()).toEqual(['dmt-demo-app', 'dmt-demo-mig-app']);
    expect(w.calls.some((c) => c.includes('dmtr-europe-west2-waker'))).toBe(false);
  });

  it('a waker backend service no row names (a router not polled yet, an offboarding\'s leftover) is never a candidate', async () => {
    const w = devProject();
    const { rules } = await scan(w, []);
    expect(rules.map((r) => r.targetGroup).sort()).toEqual(['dmt-demo-app', 'dmt-demo-mig-app']);
    expect(rules.some((r) => r.targetGroup?.startsWith('dmtr-'))).toBe(false);
    // Without its row, the waker's route in dmt-demo-app's matcher is no route of Dormeto's: the router's words for it.
    expect(named(rules, 'dmt-demo-app')).toMatchObject({
      eligibility: 'ineligible', conditions: 'hosts gcp.dev.dormeto.com, *; paths /*',
      reason: 'the URL map has its own /_dormeto/ route at pathMatchers[0].pathRules[0]: change that, then onboard again',
    });
    expect(w.calls.some((c) => c.includes('dmtr-europe-west2-waker'))).toBe(false);
  });

  it('a regional map naming a row\'s waker where it named the application (a napped workload\'s swap): the row\'s candidate stays managed', async () => {
    const w = devProject();
    w.vm('dmt-demo-regional', 'europe-west2-b', { env: 'dev' });
    const app = w.backendService('dmt-demo-regional-app', [w.group('dmt-demo-regional', 'europe-west2-b', ['dmt-demo-regional'])], { region: 'europe-west2' });
    const waker = w.backendService('dmtr-europe-west2-dmt-demo-regional-app', [w.link('regions/europe-west2/networkEndpointGroups/dmtr-europe-west2-waker')], { region: 'europe-west2' });
    // As the router writes it (urlmaps.mjs): the hold route, the waker's route and, asleep, the waker where the application was, its headers in the map.
    const header = (headerName: string, headerValue: string) => ({ headerName, headerValue, replace: true });
    const asWaker = (...more: ReturnType<typeof header>[]) => ({ weightedBackendServices: [{ backendService: waker, weight: 100, headerAction: { requestHeadersToAdd: [header('x-dormeto-workload', 'dmt-demo-regional-app'), header('x-dormeto-switch', 'swap'), ...more] } }] });
    const swapped = asWaker(header('x-dormeto-ref', 'service'));
    const hold = { paths: ['/_dormeto/backend/*'], service: app };
    const map = (withHold: boolean) => ({
      defaultRouteAction: swapped,
      hostRules: [{ hosts: ['*'], pathMatcher: 'dormeto-default' }],
      pathMatchers: [{ name: 'dormeto-default', defaultRouteAction: swapped, pathRules: [...(withHold ? [hold] : []), { paths: ['/_dormeto/*'], routeAction: asWaker() }] }],
    });
    w.urlMap('dmt-dev-regional', map(true), { region: 'europe-west2' });
    w.front('dmt-dev-regional', { region: 'europe-west2', proxy: 'http' });
    const rows = [...ONBOARDED, workloadRow('dmt-demo-regional-app', { state: 'ASLEEP', urlMap: 'dmt-dev-regional', lb: { kind: 'regional', region: 'europe-west2' } })];
    const regional = (rules: ScannedRule[]) => named(rules, 'dmt-demo-regional-app')!;
    const { rules } = await scan(w, rows);
    expect(regional(rules)).toMatchObject({
      id: 'projects/dormeto-dev/regions/europe-west2/backendServices/dmt-demo-regional-app', region: 'europe-west2', loadBalancer: 'dmt-dev-regional',
      eligibility: 'managed', workloadId: 'dmt-demo-regional-app', lb: { kind: 'regional' }, hosts: ['*'], conditions: 'hosts *; paths /*', backend: { kind: 'instance', id: 'dmt-demo-regional' },
    });
    expect(regional(rules).reason).toBeUndefined();
    expect(rules.some((r) => r.targetGroup?.startsWith('dmtr-'))).toBe(false);
    // Without the hold route, the map names the waker alone: still the workload's candidate.
    w.lists.urlMaps['regions/europe-west2'] = [];
    w.urlMap('dmt-dev-regional', map(false), { region: 'europe-west2' });
    const again = regional((await scan(w, rows)).rules);
    expect([again.eligibility, again.workloadId, again.reason]).toEqual(['managed', 'dmt-demo-regional-app', undefined]);
  });

  it('a row names its backend service in its scope: a global one of the same name is not its candidate', async () => {
    const w = devProject();
    const rows = [...ONBOARDED, workloadRow('dmt-demo-mig-app', { urlMap: 'dmt-dev-regional', lb: { kind: 'regional', region: 'europe-west2' } })];
    expect(named((await scan(w, rows)).rules, 'dmt-demo-mig-app')!.eligibility).toBe('eligible');
    const classic = [...ONBOARDED, workloadRow('dmt-demo-mig-app', { lb: { kind: 'classic' } })];
    expect(named((await scan(w, classic)).rules, 'dmt-demo-mig-app')!.eligibility).toBe('managed');
  });

  it('Compute Engine turned off (SERVICE_DISABLED): no candidate, and the scan succeeded', async () => {
    const w = devProject();
    w.disabled = true;
    expect(await scan(w)).toEqual({ rules: [], regions: [{ region: 'global', ok: true }] });
  });

  it('a region Google could not reach: its pair failed, the others scanned', async () => {
    const w = devProject();
    w.vm('dmt-demo-internal', 'europe-west2-b', { env: 'dev' });
    w.backendService('dmt-demo-internal-app', [w.group('dmt-demo-internal', 'europe-west2-b', ['dmt-demo-internal'])], { region: 'europe-west2', scheme: 'INTERNAL_MANAGED' });
    alone(w, 'dmt-dev-internal-regional', 'dmt-demo-internal-app', { region: 'europe-west2', scheme: 'INTERNAL_MANAGED' });
    w.unreachable = ['regions/europe-west2', 'zones/europe-west2-b'];
    const { rules, regions } = await scan(w);
    expect(rules.map((r) => r.targetGroup).sort()).toEqual(['dmt-demo-app', 'dmt-demo-mig-app']);
    expect(regions).toEqual([
      { region: 'europe-west1', ok: true },
      { region: 'europe-west2', ok: false, error: 'Compute Engine listed regions/europe-west2 as unreachable' },
      { region: 'global', ok: true },
    ]);
  });

  it('a zone Google could not reach fails the pair of a candidate whose backends are there', async () => {
    const w = devProject();
    w.unreachable = ['zones/europe-west1-b'];
    const { rules, regions } = await scan(w);
    expect(rules).toEqual([]);
    expect(regions).toEqual([
      { region: 'europe-west1', ok: false, error: 'Compute Engine listed zones/europe-west1-b as unreachable' },
      { region: 'global', ok: false, error: 'Compute Engine listed zones/europe-west1-b as unreachable' },
    ]);
  });

  it('reads every page of the aggregated lists', async () => {
    const w = devProject();
    w.pageScopes = { urlMaps: 1, instances: 1, instanceGroupManagers: 1 };
    const { rules } = await scan(w);
    expect(named(rules, 'dmt-demo-mig-app')).toMatchObject({ backend: { kind: 'asg', id: 'dmt-demo-mig' }, tags: { env: ['dev'], app: ['demo-mig'] } });
    expect(w.calls).toContain('GET https://compute.googleapis.com/compute/v1/projects/dormeto-dev/aggregated/urlMaps?returnPartialSuccess=true&pageToken=1');
  });

  it('calls Google at most 10 times at once', async () => {
    const w = devProject();
    for (let i = 0; i < 25; i += 1) {
      w.vm(`dmt-ten-${i}`, 'europe-west1-b');
      w.backendService(`dmt-ten-${i}`, [w.group(`dmt-ten-${i}`, 'europe-west1-b', [`dmt-ten-${i}`])]);
      alone(w, `dmt-dev-ten-${i}`, `dmt-ten-${i}`);
    }
    w.delayMs = 2;
    const { rules } = await scan(w);
    expect(rules).toHaveLength(27);
    expect(w.maxInFlight).toBe(10);
  });
});

describe('a Google Cloud project\'s account step', () => {
  const connection = { project: 'dormeto-host', projectNumber: '1', pool: 'p', provider: 'aws-121014831971', scopes: [`projects/${PROJECT}`], serviceAccounts: { discovery: 'd@x', command: 'c@x' }, routers: [], googleAdded: [], connectedAt: '2026-11-09T10:00:00.000Z', connectedBy: 'ops', cli: '0.14.0' };
  const router: InstalledRouter = { name: 'dmtr-europe-west2', account: PROJECT, region: 'europe-west2', controller: 'https://dmtr-europe-west2-controller-abc-nw.a.run.app', onboarder: '', version: '0.40.0', build: '', installedBy: 'cli', cloud: 'gcp', installedAt: '2026-11-09T10:00:00.000Z' };
  function port(w: ComputeWorld, rows: WorkloadSummary[]): GooglePort {
    return {
      connection: async () => connection,
      call: (async (method: string, url: string, body?: unknown) => (url.includes('projects:search') ? { projects: [{ projectId: PROJECT }] } : url.includes(':getAncestry') ? { ancestor: [] } : w.call(method, url, body))) as GooglePort['call'],
      registry: { list: async () => [router], put: async () => {}, delete: async () => {} },
      routerWorkloads: async (account, region) => rows.filter((r) => r.account === account && r.region === region),
    };
  }

  it('keeps a stored candidate of a region Google could not reach, and marks gone one no longer found where it scanned', async () => {
    const s = setup({ cfg: config({ regions: ['*'], filters: [filter('dev', [{ accountIds: [PROJECT] }])] }) });
    await s.ready;
    const w = devProject();
    w.vm('dmt-demo-internal', 'europe-west2-b', { env: 'dev' });
    w.backendService('dmt-demo-internal-app', [w.group('dmt-demo-internal', 'europe-west2-b', ['dmt-demo-internal'])], { region: 'europe-west2', scheme: 'INTERNAL_MANAGED' });
    alone(w, 'dmt-dev-internal-regional', 'dmt-demo-internal-app', { region: 'europe-west2', scheme: 'INTERNAL_MANAGED' });
    s.deps.google = port(w, ONBOARDED);
    const first = await planRun(s.deps, { source: 'manual' });
    await scanAccount(s.deps, { runId: first.runId, account: PROJECT });
    const status = async () => Object.fromEntries((await s.store.accountCandidates(PROJECT)).map((c) => [c.targetGroup, c.status]));
    expect(await status()).toEqual({ 'dmt-demo-app': 'managed', 'dmt-demo-mig-app': 'pending-onboarding', 'dmt-demo-internal-app': 'pending-onboarding' });
    // europe-west2 unreachable, and dmt-dev's mig host removed: the regional candidate kept, dmt-demo-mig-app gone.
    w.unreachable = ['regions/europe-west2'];
    const dev = w.lists.urlMaps.global!.find((m) => m.name === 'dmt-dev')!;
    Object.assign(dev, { hostRules: (dev.hostRules as unknown[]).slice(0, 1), pathMatchers: (dev.pathMatchers as unknown[]).slice(0, 1) });
    s.advance(HOUR);
    const second = await planRun(s.deps, { source: 'manual' });
    expect(await scanAccount(s.deps, { runId: second.runId, account: PROJECT })).toEqual({ account: PROJECT, ok: false, written: 1 });
    expect(await status()).toEqual({ 'dmt-demo-app': 'managed', 'dmt-demo-mig-app': 'gone', 'dmt-demo-internal-app': 'pending-onboarding' });
    expect((await s.store.getAccountScan(PROJECT))!.result!.pairs).toEqual([
      { region: 'europe-west1', ok: true, rules: 0, ms: 0 },
      { region: 'europe-west2', ok: false, error: 'Compute Engine listed regions/europe-west2 as unreachable', rules: 0, ms: 0 },
      { region: 'global', ok: true, rules: 1, ms: 0 },
    ]);
  });
});

// §7.3: the idle share over the 168 hours ending at the floored hour, from Cloud Monitoring's request counts.
describe('a Google Cloud candidate\'s idle share', () => {
  const GLOBAL = 'loadbalancing.googleapis.com/https/request_count';
  const REGIONAL = 'loadbalancing.googleapis.com/https/external/regional/request_count';
  const scanWith = (w: ComputeWorld, log = { warn: (_e: string, _d?: object) => {} }) => scanProject(w, { project: w.project, managed: ONBOARDED, now: NOW, log });
  const share = (r: ScannedRule | undefined) => [r?.idleHours7d, r?.requests7d];

  it('points in 3 of 168 hours: 165 idle hours and the rounded sum; the same service name under another URL map is not counted', async () => {
    const w = devProject();
    w.series.push(
      { type: GLOBAL, backend: 'dmt-demo-mig-app', urlMap: 'dmt-dev', hours: { 1: '12', 40: '3', 168: '5', 169: '99' } },
      { type: GLOBAL, backend: 'dmt-demo-mig-app', urlMap: 'another-map', hours: { 2: '1000', 3: '1000' } },
    );
    const { rules } = await scanWith(w);
    // Hour 169 is before the window; a zero hour is idle.
    expect(share(named(rules, 'dmt-demo-mig-app'))).toEqual([165, 20]);
    // A managed candidate with no series is idle all week.
    expect(share(named(rules, 'dmt-demo-app'))).toEqual([168, 0]);
    expect(w.queries).toHaveLength(1);
    const q = w.queries[0]!.searchParams;
    expect([q.get('interval.startTime'), q.get('interval.endTime')]).toEqual(['2026-11-02T12:00:00.000Z', '2026-11-09T12:00:00.000Z']);
    expect(q.getAll('aggregation.groupByFields')).toEqual(['resource.label.backend_target_name', 'resource.label.url_map_name']);
  });

  it('every page of the answer is read, and a zero count is an idle hour', async () => {
    const w = devProject();
    w.pageSeries = 1;
    w.series.push(
      { type: GLOBAL, backend: 'dmt-demo-app', urlMap: 'dmt-dev', hours: { 1: '0', 2: '4' } },
      { type: GLOBAL, backend: 'dmt-demo-mig-app', urlMap: 'dmt-dev', hours: { 5: '7' } },
    );
    const { rules } = await scanWith(w);
    expect(share(named(rules, 'dmt-demo-app'))).toEqual([167, 4]);
    expect(share(named(rules, 'dmt-demo-mig-app'))).toEqual([167, 7]);
    expect(w.queries).toHaveLength(2);
  });

  it('a regional candidate is read by its region, from its own metric, grouped by region too', async () => {
    const w = devProject();
    w.vm('dmt-demo-regional', 'europe-west2-b');
    const group = w.group('dmt-demo-regional', 'europe-west2-b', ['dmt-demo-regional']);
    w.backendService('dmt-demo-regional-app', [group], { region: 'europe-west2' });
    w.urlMap('dmt-dev-regional', { defaultService: w.service('dmt-demo-regional-app', 'europe-west2') }, { region: 'europe-west2' });
    w.front('dmt-dev-regional', { region: 'europe-west2', proxy: 'http' });
    w.series.push(
      { type: REGIONAL, backend: 'dmt-demo-regional-app', urlMap: 'dmt-dev-regional', region: 'europe-west2', hours: { 1: '2', 2: '2' } },
      { type: REGIONAL, backend: 'dmt-demo-regional-app', urlMap: 'dmt-dev-regional', region: 'europe-west3', hours: { 3: '500' } },
      { type: GLOBAL, backend: 'dmt-demo-regional-app', urlMap: 'dmt-dev-regional', hours: { 4: '500' } },
    );
    const { rules } = await scanWith(w);
    expect(share(named(rules, 'dmt-demo-regional-app'))).toEqual([166, 4]);
    const regional = w.queries.find((u) => u.searchParams.get('filter')!.includes(REGIONAL))!;
    expect(regional.searchParams.getAll('aggregation.groupByFields')).toContain('resource.label.region');
    // The global candidates are read from the global metric only.
    expect(share(named(rules, 'dmt-demo-mig-app'))).toEqual([168, 0]);
  });

  it('a candidate ineligible reads nothing, and no query is made when none is left', async () => {
    const w = devProject();
    w.neg('k8s1-abc', 'europe-west1-b', { vms: ['dmt-demo'] });
    const { rules } = await scanWith(w);
    expect(rules.filter((r) => r.eligibility === 'ineligible').every((r) => r.idleHours7d === null && r.requests7d === null)).toBe(true);
  });

  it('Monitoring turned off: nulls, the candidates written, one warning for the project and type', async () => {
    const w = devProject();
    w.monitoringError = new GoogleError({ status: 403, reason: 'SERVICE_DISABLED', host: 'monitoring.googleapis.com', message: 'Cloud Monitoring API has not been used in project dormeto-dev before or it is disabled.' });
    const warnings: [string, object?][] = [];
    const { rules, regions } = await scanWith(w, { warn: (e, d) => void warnings.push([e, d]) });
    expect(rules.map((r) => [r.targetGroup, r.idleHours7d, r.requests7d])).toEqual([['dmt-demo-app', null, null], ['dmt-demo-mig-app', null, null]]);
    expect(regions.every((r) => r.ok)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]![0]).toBe('GoogleIdleFailed');
    expect(warnings[0]![1]).toMatchObject({ project: 'dormeto-dev', metric: GLOBAL });
  });

  it('a failing query gives nulls for its metric type only', async () => {
    const w = devProject();
    w.vm('dmt-demo-regional', 'europe-west2-b');
    w.backendService('dmt-demo-regional-app', [w.group('dmt-demo-regional', 'europe-west2-b', ['dmt-demo-regional'])], { region: 'europe-west2' });
    w.urlMap('dmt-dev-regional', { defaultService: w.service('dmt-demo-regional-app', 'europe-west2') }, { region: 'europe-west2' });
    w.front('dmt-dev-regional', { region: 'europe-west2', proxy: 'http' });
    w.series.push({ type: GLOBAL, backend: 'dmt-demo-mig-app', urlMap: 'dmt-dev', hours: { 1: '1' } });
    const call = w.call.bind(w);
    const flaky = Object.assign(Object.create(w), { call: async (m: string, url: string, b?: unknown) => {
      if (url.includes(encodeURIComponent(REGIONAL)) || url.includes(REGIONAL)) throw new Error('timeout');
      return call(m, url, b);
    } });
    const { rules } = await scanProject(flaky, { project: w.project, managed: ONBOARDED, now: NOW, log: { warn() {} } });
    expect(share(named(rules, 'dmt-demo-mig-app'))).toEqual([167, 1]);
    expect(share(named(rules, 'dmt-demo-regional-app'))).toEqual([null, null]);
  });
});
