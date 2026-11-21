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
      hint: 'Offboard a workload whose resource was deleted; tag a resource that lost its dormeto:workload tag again (its value is the workload\'s id): the router finds it again at the next check. Until then the workload naps and wakes nothing.',
    }]);
  });
});

// The review's M5: idle signals stored at the organization's level while a router does not know them (the gate acts only at a
// write; a router may join or report an older version later). Its health carries a warning naming what it drops.
describe('a router that does not know the organization\'s idle signals', () => {
  const summary = (region: string, version: string | null) => ({
    account: MANAGER, region, name: `dmt-${region}`, version, build: 'b', checkSchedule: 'rate(5 minutes)', checkedAt: new Date(NOW - 60_000).toISOString(), durationMs: 1,
    health: { status: 'ok', problems: [] }, pauses: [], counts: {}, check: { checkedAt: new Date(NOW - 60_000).toISOString(), total: 1, received: [0] },
  }) as unknown as RouterSummary;
  const routers = [{ name: 'dmt-new', region: 'eu-west-1', controller: 'c' }, { name: 'dmt-old', region: 'eu-west-2', controller: 'c' }, { name: 'dmt-unknown', region: 'eu-west-3', controller: 'c' }];
  const observe = (idleLevels: string[]) => routerObservations({
    terraformRouters: routers as never, installed: [], summaries: [summary('eu-west-1', '0.42.0'), summary('eu-west-2', '0.41.2'), summary('eu-west-3', null)], managerAccount: MANAGER, now: NOW, idleLevels,
  }).map((o) => [o.subject.name, o.problems]);

  it('warns on each such router, naming the levels it ignores, its HTTP settings included', () => {
    const warning = (version: string) => [{
      code: 'idle-signals-unknown', level: 'warning',
      text: `the organization's idle signals are set (the defaults, type batch) and this router (${version}) does not know them: it ignores those levels whole, their HTTP settings included`,
      hint: 'Upgrade the router to 0.42.0 or later, or remove the idle signals from those levels.',
    }];
    expect(observe(['the defaults', 'type batch'])).toEqual([['dmt-new', []], ['dmt-old', warning('0.41.2')], ['dmt-unknown', warning('version not known')]]);
  });

  it('says nothing while no idle signal is stored', () => {
    expect(observe([])).toEqual([['dmt-new', []], ['dmt-old', []], ['dmt-unknown', []]]);
  });

  it('names the levels that hold idle signals in settings.json', async () => {
    const { idleLevelsOf } = await import('../src/watchdog.js');
    expect(idleLevelsOf({ workloads: { defaults: { idleMinutes: 30, idleCpuPercent: 5 }, types: [{ name: 'web', settings: { waitSeconds: 10 } }, { name: 'batch', settings: { idleMetric: 'off' } }] } })).toEqual(['the defaults', 'type batch']);
    expect(idleLevelsOf(null)).toEqual([]);
  });
});

describe('a Google Cloud router and the organization\'s idle signals (plan 5)', () => {
  const installed = (version: string) => ({ name: 'dmtr-europe-west2', account: 'dormeto-dev', region: 'europe-west2', controller: 'https://c', onboarder: '', version, build: '', installedBy: 'cli', cloud: 'gcp', installedAt: new Date(NOW - 3_600_000).toISOString() });
  const summary = (version: string) => ({
    account: 'dormeto-dev', region: 'europe-west2', name: 'dmtr-europe-west2', version, build: 'b', checkSchedule: 'rate(5 minutes)', checkedAt: new Date(NOW - 60_000).toISOString(), durationMs: 1,
    health: { status: 'ok', problems: [] }, pauses: [], counts: {}, check: { checkedAt: new Date(NOW - 60_000).toISOString(), total: 1, received: [0] },
  }) as unknown as RouterSummary;
  const observe = (version: string) => routerObservations({ terraformRouters: [], installed: [installed(version)] as never, summaries: [summary(version)], managerAccount: MANAGER, now: NOW, idleLevels: ['the defaults'] })[0]!.problems;

  it('warns while it is before its cloud\'s first version that knows them, never for being Google Cloud', () => {
    expect(observe('0.41.0')).toEqual([{
      code: 'idle-signals-unknown', level: 'warning',
      text: 'the organization\'s idle signals are set (the defaults) and this router (0.41.0) does not know them: it is given those levels without them',
      hint: 'Upgrade the router to 0.42.0 or later with the CLI (dormeto gcp routers install), or remove the idle signals from those levels.',
    }]);
    expect(observe('0.42.0')).toEqual([]);
  });

  it('says what to do about a Cloud SQL resource it cannot read', () => {
    const s = { ...summary('0.42.0'), health: { status: 'warning', problems: [{ level: 'warning', code: 'cloud-sql-unreadable', text: '1 standalone workload with a Cloud SQL instance the router cannot read: install it with --with cloud-sql' }] } } as unknown as RouterSummary;
    expect(routerObservations({ terraformRouters: [], installed: [installed('0.42.0')] as never, summaries: [s], managerAccount: MANAGER, now: NOW })[0]!.problems[0]).toMatchObject({ code: 'cloud-sql-unreadable', hint: expect.stringContaining('--with cloud-sql') });
  });
});
