// A router's health warning of standalone workloads without their resource (the router's code `resource-missing`, plan 1's
// handover, Minor 9): an alert of its own code, the router's text, and what to do.
import { describe, expect, it } from 'vitest';
import type { RouterSummary } from '@dormeto/fleet';
import { routerObservations } from '../src/watchdog.js';

const NOW = Date.UTC(2026, 11, 1, 12, 0);
const MANAGER = '121014831971';
const TEXT = '1 standalone workload without its resource: deleted, or its dormeto:workload tag removed (see the workloads)';

describe('a router\'s standalone workloads without their resource', () => {
  it('open an alert with the router\'s code and text, and say what to do', () => {
    const summary = {
      account: MANAGER, region: 'eu-west-1', name: 'dmt-dev', version: '0.42.0', build: 'b', checkSchedule: 'rate(5 minutes)', checkedAt: new Date(NOW - 60_000).toISOString(), durationMs: 1,
      health: { status: 'warning', problems: [{ level: 'warning', code: 'resource-missing', text: TEXT }] }, pauses: [], counts: {}, check: { checkedAt: new Date(NOW - 60_000).toISOString(), total: 1, received: [0] },
    } as unknown as RouterSummary;
    const [observation] = routerObservations({ terraformRouters: [{ name: 'dmt-dev', region: 'eu-west-1', controller: 'c' }] as never, installed: [], summaries: [summary], managerAccount: MANAGER, now: NOW });
    expect(observation!.problems).toEqual([{
      code: 'resource-missing', level: 'warning', text: TEXT,
      hint: 'Offboard a workload whose resource was deleted; tag a resource that lost its dormeto:workload tag again (its value is the workload\'s id). Until then the workload naps and wakes nothing.',
    }]);
  });
});
