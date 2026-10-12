// The connections a discovery run decided (packaging design §5): the state machine passes the run's id (its lists could
// pass Step Functions' payload limit, R5c review I3); they are read from the run record.
import type { DiscoveryStore } from '@dormeto/discovery';
import type { createEngine } from './engine.js';

export async function runConnections(store: Pick<DiscoveryStore, 'getRun'>, engine: Pick<ReturnType<typeof createEngine>, 'connections'>, runId: string) {
  const lists = (await store.getRun(runId))?.connections;
  if (!lists) return { created: [], skipped: [] };
  return engine.connections(lists, 'discovery');
}
