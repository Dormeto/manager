// Every Google Cloud call of the standalone scan (plan 5, M50) is allowed to the manager's discovery account: its custom role
// dormetoDiscovery as the router's gcp/access.json declares it (manager.roles.dormetoDiscovery.permissions), which the CLI's
// dormeto gcp connect grants. A call the table does not know fails the test, so a new call cannot go unchecked. Skipped without
// the router's checkout beside the manager.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanProject } from '../src/gcp-scan.js';
import { PROJECT, workloadRow } from './gcp-fakes.js';
import { NOW, standaloneProject } from './gcp-standalone-world.js';

const ACCESS = resolve(import.meta.dirname, '../../../../router/gcp/access.json');
// Google's permission of each call, from its reference (Compute Engine aggregated lists need the list permission of each scope's
// collection; listManagedInstances, the group's get).
const PERMISSIONS: [RegExp, string[]][] = [
  [/^GET https:\/\/compute\.googleapis\.com\/compute\/v1\/projects\/[^/]+\/aggregated\/urlMaps\?/, ['compute.urlMaps.list', 'compute.regionUrlMaps.list']],
  [/^GET https:\/\/compute\.googleapis\.com\/compute\/v1\/projects\/[^/]+\/aggregated\/backendServices\?/, ['compute.backendServices.list', 'compute.regionBackendServices.list']],
  [/^GET https:\/\/compute\.googleapis\.com\/compute\/v1\/projects\/[^/]+\/aggregated\/targetHttpsProxies\?/, ['compute.targetHttpsProxies.list', 'compute.regionTargetHttpsProxies.list']],
  [/^GET https:\/\/compute\.googleapis\.com\/compute\/v1\/projects\/[^/]+\/aggregated\/targetHttpProxies\?/, ['compute.targetHttpProxies.list', 'compute.regionTargetHttpProxies.list']],
  [/^GET https:\/\/compute\.googleapis\.com\/compute\/v1\/projects\/[^/]+\/aggregated\/forwardingRules\?/, ['compute.forwardingRules.list', 'compute.globalForwardingRules.list']],
  [/^GET https:\/\/compute\.googleapis\.com\/compute\/v1\/projects\/[^/]+\/aggregated\/instanceGroupManagers\?/, ['compute.instanceGroupManagers.list']],
  [/^GET https:\/\/compute\.googleapis\.com\/compute\/v1\/projects\/[^/]+\/aggregated\/instances\?/, ['compute.instances.list']],
  [/^POST https:\/\/compute\.googleapis\.com\/compute\/v1\/projects\/[^/]+\/(zones|regions)\/[^/]+\/instanceGroups\/[^/]+\/listInstances$/, ['compute.instanceGroups.list']],
  [/^GET https:\/\/compute\.googleapis\.com\/compute\/v1\/projects\/[^/]+\/zones\/[^/]+\/networkEndpointGroups\/[^/]+$/, ['compute.networkEndpointGroups.get']],
  [/^POST https:\/\/compute\.googleapis\.com\/compute\/v1\/projects\/[^/]+\/zones\/[^/]+\/networkEndpointGroups\/[^/]+\/listNetworkEndpoints$/, ['compute.networkEndpointGroups.list']],
  [/^GET https:\/\/sqladmin\.googleapis\.com\/v1\/projects\/[^/]+\/instances(\?|$)/, ['cloudsql.instances.list']],
  [/^GET https:\/\/monitoring\.googleapis\.com\/v3\/projects\/[^/]+\/timeSeries\?/, ['monitoring.timeSeries.list']],
  // The activity step's (M51): a group's VMs.
  [/^POST https:\/\/compute\.googleapis\.com\/compute\/v1\/projects\/[^/]+\/(zones|regions)\/[^/]+\/instanceGroupManagers\/[^/]+\/listManagedInstances$/, ['compute.instanceGroupManagers.get']],
  // The onboarding's backing check (final review I3): a group's manager.
  [/^GET https:\/\/compute\.googleapis\.com\/compute\/v1\/projects\/[^/]+\/(zones|regions)\/[^/]+\/instanceGroupManagers\/[^/]+$/, ['compute.instanceGroupManagers.get']],
];

describe.skipIf(!existsSync(ACCESS))('the standalone scan\'s Google Cloud calls', () => {
  it('are each allowed to dormetoDiscovery, Cloud SQL\'s list and get included', async () => {
    const granted = new Set((JSON.parse(readFileSync(ACCESS, 'utf8')) as { manager: { roles: { dormetoDiscovery: { permissions: string[] } } } }).manager.roles.dormetoDiscovery.permissions);
    const w = standaloneProject();
    // A NEG of VMs behind a backend service: its read too.
    w.vm('neg-vm', 'europe-west1-b');
    w.backendService('neg-svc', [w.neg('neg-1', 'europe-west1-b', { vms: [w.link('zones/europe-west1-b/instances/neg-vm')] })]);
    await scanProject(w, { project: PROJECT, managed: [workloadRow('dmt-demo-app')], now: NOW, standalone: true });
    // The activity step of a group and of a Cloud SQL resource (M51), as the discovery account.
    const { googleActivityStep } = await import('../src/gcp-activity.js');
    await googleActivityStep(w.call.bind(w) as never, { project: PROJECT, backends: [{ kind: 'asg', id: 'workers', location: 'europe-west1-b' }], settings: { idleCpuPercent: 5, idleNetworkBytes: 1000, idleMetric: 'off' }, days: 1, now: NOW() });
    await googleActivityStep(w.call.bind(w) as never, { project: PROJECT, backends: [{ kind: 'cloudsql-instance', id: 'orders' }], settings: { idleCpuPercent: 'off', idleNetworkBytes: 'off', idleMetric: { type: 'cloudsql.googleapis.com/database/network/connections', filter: 'resource.type = "cloudsql_database"', aligner: 'ALIGN_MAX', below: 1 } }, days: 1, now: NOW() });
    // The onboarding's backing check of a VM and of a group (final review I3), as the discovery account.
    const { standaloneBackingProblems } = await import('../src/gcp-backing.js');
    await standaloneBackingProblems(w.call.bind(w) as never, PROJECT, { id: `projects/${PROJECT}/zones/europe-west1-b/instances/neg-vm`, region: 'europe-west1', backend: { kind: 'instance', id: 'neg-vm', location: 'europe-west1-b' } });
    await standaloneBackingProblems(w.call.bind(w) as never, PROJECT, { id: `projects/${PROJECT}/zones/europe-west1-b/instanceGroupManagers/workers`, region: 'europe-west1', backend: { kind: 'asg', id: 'workers', location: 'europe-west1-b' } });
    expect(w.calls.some((c) => /instanceGroupManagers\/workers$/.test(c))).toBe(true);
    const needed = new Set<string>();
    for (const call of w.calls) {
      const found = PERMISSIONS.find(([re]) => re.test(call));
      expect(found, `a call the table does not know: ${call}`).toBeDefined();
      for (const p of found![1]) needed.add(p);
    }
    expect([...needed].filter((p) => !granted.has(p))).toEqual([]);
    for (const p of ['cloudsql.instances.list', 'cloudsql.instances.get', 'monitoring.timeSeries.list', 'compute.instances.list', 'compute.instanceGroupManagers.list']) expect(granted.has(p), p).toBe(true);
  });
});
