// The Google Cloud standalone scan's world (plan 5, M50): dormeto-dev's demo, and beside it a VM and a group of each case, Cloud
// SQL instances, and a backend service no URL map names.
import { devProject, PROJECT } from './gcp-fakes.js';

const ZONE = 'europe-west1-b';
export const NOW = () => Date.UTC(2026, 10, 9, 12, 7);
export function standaloneProject() {
  const w = devProject();
  w.vm('build-agent', ZONE, { team: 'ci' });
  w.vm('gpu-box', ZONE, {}, { guestAccelerators: [{ acceleratorType: 'nvidia-l4', acceleratorCount: 1 }] });
  w.vm('ssd-box', ZONE, {}, { disks: [{ type: 'PERSISTENT', boot: true }, { type: 'SCRATCH' }] });
  w.vm('lone-node', ZONE, { 'goog-gke-node': '' });
  w.vm('batch', ZONE, { team: 'data' });
  // An unmanaged group a backend service no URL map names: its VM backs it.
  w.vm('orphan', ZONE);
  w.backendService('orphan-svc', [w.group('orphan-ig', ZONE, ['orphan'])]);
  // Managed groups: eligible, no VM, stateful, regional EVEN, GKE nodes; and one behind the orphan backend service.
  w.vm('workers-a1', ZONE, { team: 'batch' });
  w.vm('workers-b2', ZONE, { team: 'batch' });
  w.mig('workers', ZONE, ['workers-a1', 'workers-b2']);
  w.mig('empty', ZONE, []);
  w.vm('keep-1', ZONE);
  w.mig('keep', ZONE, ['keep-1'], { extra: { status: { isStable: true, stateful: { hasStatefulConfig: true } } } });
  w.vm('spread-1', 'europe-west1-c');
  w.mig('spread', 'europe-west1', ['spread-1'], { regional: true, extra: { distributionPolicy: { targetShape: 'EVEN' }, updatePolicy: { instanceRedistributionType: 'PROACTIVE' } } });
  w.vm('nodes-1', ZONE, { 'goog-gke-node': '' });
  w.mig('nodes', ZONE, ['nodes-1']);
  w.vm('served-1', ZONE);
  w.backendService('served-svc', [w.mig('served', ZONE, ['served-1'])]);
  w.cloudSql('orders', { settings: { activationPolicy: 'ALWAYS', userLabels: { team: 'shop' } } });
  w.cloudSql('orders-replica', { masterInstanceName: `${PROJECT}:orders`, instanceType: 'READ_REPLICA_INSTANCE' });
  w.cloudSql('reports', { region: 'europe-west2' });
  return w;
}
