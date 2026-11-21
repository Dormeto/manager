// The safety net again for one resource, at its onboarding (final review I3, decisions findings-final-manager-1.md): as the
// discovery account, what backs any backend service, a target pool, a load balancer the manager cannot read, or a listing that
// missed its scope, is refused in the scan's words; a check that cannot be made refuses too. The scan may be days old.
import { describe, expect, it } from 'vitest';
import { GoogleError } from '@dormeto/google';
import { standaloneBackingProblems } from '../src/gcp-backing.js';
import { PROJECT } from './gcp-fakes.js';
import { standaloneProject } from './gcp-standalone-world.js';

const ZONE = 'europe-west1-b';
const path = (rest: string) => `projects/${PROJECT}/${rest}`;
const vm = (name: string, zone = ZONE) => ({ id: path(`zones/${zone}/instances/${name}`), region: zone.replace(/-[a-z]$/, ''), backend: { kind: 'instance' as const, id: name, location: zone } });
const mig = (name: string, zone = ZONE) => ({ id: path(`zones/${zone}/instanceGroupManagers/${name}`), region: zone.replace(/-[a-z]$/, ''), backend: { kind: 'asg' as const, id: name, location: zone } });
const check = (w: ReturnType<typeof standaloneProject>, c: Parameters<typeof standaloneBackingProblems>[2]) => standaloneBackingProblems(w.call.bind(w), PROJECT, c);

describe('the safety net at onboarding, for one resource', () => {
  it('finds nothing for a free VM, a free group or a Cloud SQL instance (and reads nothing for the last)', async () => {
    const w = standaloneProject();
    expect(await check(w, vm('build-agent'))).toEqual([]);
    expect(await check(w, mig('workers'))).toEqual([]);
    w.calls.length = 0;
    expect(await check(w, { id: path('instances/orders'), region: 'europe-west1', backend: { kind: 'cloudsql-instance', id: 'orders' } })).toEqual([]);
    expect(w.calls).toEqual([]);
  });

  it('refuses a VM attached to a backend service after the scan, through a group or a network endpoint group of either type', async () => {
    const w = standaloneProject();
    w.backendService('late-svc', [w.group('late-ig', ZONE, ['build-agent'])], { region: 'europe-west1', scheme: 'INTERNAL_MANAGED' });
    expect(await check(w, vm('build-agent'))).toEqual(['VM build-agent backs backend service late-svc: it belongs to an HTTP workload']);
    const n = standaloneProject();
    n.backendService('nlb-svc', [n.neg('nlb-neg', ZONE, { type: 'GCE_VM_IP', vms: [n.link(`zones/${ZONE}/instances/build-agent`)] })], { region: 'europe-west1', scheme: 'INTERNAL' });
    expect(await check(n, vm('build-agent'))).toEqual(['VM build-agent backs backend service nlb-svc: it belongs to an HTTP workload']);
    expect(await check(standaloneProject(), vm('orphan'))).toEqual(['VM orphan backs backend service orphan-svc: it belongs to an HTTP workload']);
  });

  it('refuses a group a backend service names, one in a target pool, and one whose VM a network endpoint group holds', async () => {
    const w = standaloneProject();
    expect(await check(w, mig('served'))).toEqual(['managed group served backs backend service served-svc: it belongs to an HTTP workload']);
    w.vm('pool-1', ZONE);
    w.mig('pooled', ZONE, ['pool-1'], { extra: { targetPools: [w.link('regions/europe-west1/targetPools/web-pool')] } });
    expect(await check(w, mig('pooled'))).toEqual(['managed group pooled is in target pool web-pool: it belongs to a load balancer']);
    w.backendService('neg-svc', [w.neg('neg-w', ZONE, { vms: [w.link(`zones/${ZONE}/instances/workers-a1`)] })], { region: 'europe-west1' });
    expect(await check(w, mig('workers'))).toEqual(['managed group workers backs backend service neg-svc: it belongs to an HTTP workload']);
  });

  it('refuses where it cannot see: a listing that missed the scope, a target pool or a target instance in the VM\'s region', async () => {
    const w = standaloneProject();
    w.unreachable = ['global'];
    expect(await check(w, vm('build-agent'))).toEqual(['VM build-agent: its load balancers could not be read: global']);
    const r = standaloneProject();
    (r.lists.forwardingRules['regions/europe-west1'] ??= []).push({ name: 'web-fr', target: r.link('regions/europe-west1/targetPools/web-pool'), selfLink: r.link('regions/europe-west1/forwardingRules/web-fr') });
    expect(await check(r, vm('build-agent'))).toEqual(['VM build-agent: its region has a load balancer the manager cannot read (a target pool or a target instance): forwarding rule web-fr']);
  });

  it('throws when a read fails: the onboarding is refused, never let through', async () => {
    const w = standaloneProject();
    const call = async () => { throw new GoogleError({ status: 403, reason: 'PERMISSION_DENIED', message: 'denied' }); };
    await expect(standaloneBackingProblems(call as never, PROJECT, vm('build-agent'))).rejects.toThrow(/denied/);
    expect(w).toBeDefined();
  });
});
