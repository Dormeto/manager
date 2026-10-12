import { describe, expect, it } from 'vitest';
import type { OrganizationsPort } from '../src/org.js';
import { runDiscovery, type RunDeps } from '../src/run.js';
import { createStore } from '../src/store.js';
import type { DiscoveryConfig, OrgInventory, ScannedRule } from '../src/types.js';
import { fakeDynamo } from './dynamo-fake.js';
import { A, B, C, INVENTORY, config, filter, rule } from './fixtures.js';

const T0 = Date.UTC(2026, 9, 4, 12, 0);
const HOUR = 3_600_000;

// Organizations answering from an inventory (fixtures: A at the root, B five OUs deep, C in the prod OU).
function organizationsOf(inventory: OrgInventory) {
  const calls: string[] = [];
  const port: OrganizationsPort = {
    async listRoots() { calls.push('roots'); return { Roots: Object.entries(inventory.ous).filter(([, o]) => o.parent === null).map(([Id, o]) => ({ Id, Name: o.name })) }; },
    async listOrganizationalUnitsForParent({ ParentId }) { return { OrganizationalUnits: Object.entries(inventory.ous).filter(([, o]) => o.parent === ParentId).map(([Id, o]) => ({ Id, Name: o.name })) }; },
    async listAccountsForParent({ ParentId }) { return { Accounts: inventory.accounts.filter((a) => a.ouPath.at(-1) === ParentId).map((a) => ({ Id: a.id, Name: a.name, State: 'ACTIVE' })) }; },
    async listTagsForResource({ ResourceId }) { calls.push(`tags ${ResourceId}`); return { Tags: Object.entries(inventory.accounts.find((a) => a.id === ResourceId)!.tags).map(([Key, Value]) => ({ Key, Value })) }; },
  };
  return { port, calls };
}

function setup({ cfg, deny = [], failScan = [], regions = ['eu-west-1', 'eu-central-1'], delayMs = 0 }: {
  cfg?: DiscoveryConfig; deny?: string[]; failScan?: string[]; regions?: string[]; delayMs?: number;
} = {}) {
  const dynamo = fakeDynamo();
  let now = T0;
  const store = createStore({ dynamo, table: 't', now: () => now });
  const org = organizationsOf(INVENTORY);
  const assumed: string[] = [];
  const scanned: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const deps: RunDeps = {
    store,
    organizations: org.port,
    managerAccount: A.id,
    now: () => now,
    log: { info() {}, warn() {}, error() {} },
    async assumeRole(account) {
      assumed.push(account);
      if (deny.includes(account)) throw Object.assign(new Error('not authorized to perform: sts:AssumeRole'), { name: 'AccessDenied' });
      return { account };
    },
    async enabledRegions() { return regions; },
    async scan(credentials, where): Promise<ScannedRule[]> {
      expect(credentials).toEqual({ account: where.account });
      scanned.push(`${where.account}/${where.region}`);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, delayMs));
      inFlight -= 1;
      if (failScan.includes(`${where.account}/${where.region}`)) throw Object.assign(new Error('Rate exceeded'), { name: 'Throttling' });
      return [rule({ id: `rule-${where.account}-${where.region}`, account: where.account, region: where.region })];
    },
  };
  return { deps, store, dynamo, org, assumed, scanned, flight: () => maxInFlight, advance: (ms: number) => { now += ms; }, ready: cfg ? store.putConfig(cfg, 'admin@example.com') : Promise.resolve() };
}

const AB = config({ filters: [filter('ab', [{ accountIds: [A.id, B.id] }])] });

describe('runDiscovery', () => {
  it('scans the pairs of the perimeter with one AssumeRole per account, and records the run', async () => {
    const s = setup({ cfg: AB });
    await s.ready;
    const run = await runDiscovery(s.deps, { source: 'manual', by: 'ops@example.com' });
    expect(s.assumed.sort()).toEqual([A.id, B.id]);
    expect(s.scanned.sort()).toEqual([`${A.id}/eu-west-1`, `${A.id}/eu-west-3`, `${B.id}/eu-west-1`, `${B.id}/eu-west-3`]);
    expect(run).toMatchObject({ trigger: 'manual', by: 'ops@example.com', status: 'ok', counts: { 'pending-onboarding': 4 } });
    expect(run.skipped).toEqual([{ reason: 'no filter includes this account', accounts: 1, pairs: 2 }]);
    expect(run.targets.map((t) => t.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect((await s.store.lastRun())!.startedAt).toBe(run.startedAt);
    expect((await s.store.listCandidates()).length).toBe(4);
    expect((await s.store.getInventory())!.accounts.length).toBe(3);
  });

  it('deletes the rule candidates of earlier versions that now belong to a target group candidate, without any gone', async () => {
    const s = setup({ cfg: config({ regions: ['eu-west-1'], filters: [filter('a', [{ accountIds: [A.id] }])] }) });
    await s.ready;
    const ruleRef = (id: string) => ({ id, listener: 'HTTPS:443', priority: '10', conditions: 'host shop.example.com', hosts: ['shop.example.com'], managed: false });
    s.deps.scan = async (_c, where) => [rule({ id: `tg-${where.account}`, account: where.account, region: where.region, rules: [ruleRef('rule-old'), ruleRef('rule-other')] })];
    await s.store.putCandidates([{
      ...rule({ id: 'rule-old', account: A.id, region: 'eu-west-1', rules: [] }), accountName: 'tools', ouPath: A.ouPath, scope: 'in', scopeReason: 'in',
      status: 'pending-onboarding', statusReason: 'eligible', firstSeenAt: '2026-10-03T12:00:00.000Z', lastSeenAt: '2026-10-03T12:00:00.000Z', history: [],
    }]);
    const run = await runDiscovery(s.deps, { source: 'manual' });
    expect((await s.store.listCandidates()).map((c) => [c.id, c.status])).toEqual([[`tg-${A.id}`, 'pending-onboarding']]);
    expect(run.counts).toEqual({ 'pending-onboarding': 1 });
  });

  it('carries the dismissal, first seen date and history of merged rule candidates into their target group candidate', async () => {
    const s = setup({ cfg: config({ regions: ['eu-west-1'], filters: [filter('a', [{ accountIds: [A.id] }])] }) });
    await s.ready;
    const ruleRef = (id: string) => ({ id, listener: 'HTTPS:443', priority: '10', conditions: 'host shop.example.com', hosts: ['shop.example.com'], managed: false });
    s.deps.scan = async (_c, where) => [rule({ id: `tg-${where.account}`, account: where.account, region: where.region, rules: [ruleRef('rule-a'), ruleRef('rule-b')] })];
    const stored = (id: string, firstSeenAt: string, extra: object) => ({
      ...rule({ id, account: A.id, region: 'eu-west-1', rules: [] }), accountName: 'tools', ouPath: A.ouPath, scope: 'in' as const, scopeReason: 'in',
      status: 'ineligible' as const, statusReason: 'target group shared by 2 rules', firstSeenAt, lastSeenAt: firstSeenAt,
      history: [{ at: firstSeenAt, status: 'ineligible' as const, reason: 'target group shared by 2 rules' }], ...extra,
    });
    await s.store.putCandidates([
      stored('rule-a', '2026-10-02T12:00:00.000Z', {}),
      stored('rule-b', '2026-10-01T12:00:00.000Z', { dismissed: { by: 'ops@example.com', at: '2026-10-03T12:00:00.000Z', note: 'legacy' } }),
    ]);
    await runDiscovery(s.deps, { source: 'manual' });
    const [merged] = await s.store.listCandidates();
    expect([merged!.id, merged!.status, merged!.firstSeenAt, merged!.dismissed?.note]).toEqual([`tg-${A.id}`, 'dismissed', '2026-10-01T12:00:00.000Z', 'legacy']);
    expect(merged!.history.map((h) => h.status)).toEqual(['ineligible', 'ineligible', 'dismissed']);
  });

  it('never assumes a role in a globally excluded account', async () => {
    const s = setup({ cfg: { ...AB, globalExcludes: [{ accountIds: [B.id] }] } });
    await s.ready;
    await runDiscovery(s.deps, { source: 'manual' });
    expect(s.assumed).toEqual([A.id]);
  });

  it('never assumes a role in an account whose only included regions are globally excluded', async () => {
    const s = setup({ cfg: config({ globalExcludes: [{ regions: ['eu-west-3'] }], filters: [filter('ab', [{ accountIds: [A.id] }, { accountIds: [B.id], regions: ['eu-west-3'] }])] }) });
    await s.ready;
    await runDiscovery(s.deps, { source: 'manual' });
    expect(s.assumed).toEqual([A.id]);
  });

  it('reports every pair of an account without the role, and leaves its known candidates untouched', async () => {
    const s = setup({ cfg: AB });
    await s.ready;
    await runDiscovery(s.deps, { source: 'manual' });
    const before = (await s.store.listCandidates()).find((c) => c.account === B.id)!;
    s.advance(HOUR);
    s.deps.assumeRole = async (account) => {
      if (account === B.id) throw Object.assign(new Error('denied'), { name: 'AccessDenied' });
      return { account };
    };
    const run = await runDiscovery(s.deps, { source: 'manual' });
    expect(run.status).toBe('partial');
    expect(run.targets.filter((t) => t.account === B.id).map((t) => [t.region, t.status, t.error])).toEqual([
      ['eu-west-1', 'error', 'no access: deploy DmtDiscoveryRole to this account'],
      ['eu-west-3', 'error', 'no access: deploy DmtDiscoveryRole to this account'],
    ]);
    expect((await s.store.listCandidates()).find((c) => c.id === before.id)).toEqual(before);
  });

  it('keeps candidates of an account without the role untouched with regions ["*"] too', async () => {
    const s = setup({ cfg: { ...AB, regions: ['*'] } });
    await s.ready;
    await runDiscovery(s.deps, { source: 'manual' });
    const before = await s.store.listCandidates();
    s.advance(HOUR);
    s.deps.assumeRole = async (account) => {
      if (account === B.id) throw Object.assign(new Error('denied'), { name: 'AccessDenied' });
      return { account };
    };
    const run = await runDiscovery(s.deps, { source: 'manual' });
    expect(run.targets.filter((t) => t.account === B.id && t.status === 'error').length).toBeGreaterThan(0);
    const after = await s.store.listCandidates();
    expect(after.filter((c) => c.account === B.id)).toEqual(before.filter((c) => c.account === B.id));
  });

  it('records a failing scan on its pair only; the run is partial', async () => {
    const s = setup({ cfg: AB, failScan: [`${A.id}/eu-west-3`] });
    await s.ready;
    const run = await runDiscovery(s.deps, { source: 'manual' });
    expect(run.status).toBe('partial');
    expect(run.targets.find((t) => t.account === A.id && t.region === 'eu-west-3')).toMatchObject({ status: 'error', error: 'Throttling: Rate exceeded' });
    expect(run.targets.filter((t) => t.status === 'ok').length).toBe(3);
  });

  it('scans at most 8 pairs at a time', async () => {
    const regions = Array.from({ length: 20 }, (_, i) => `eu-test-${i + 1}`);
    const s = setup({ cfg: config({ regions, filters: [filter('a', [{ accountIds: [A.id] }])] }), delayMs: 5 });
    await s.ready;
    await runDiscovery(s.deps, { source: 'manual' });
    expect(s.scanned.length).toBe(20);
    expect(s.flight()).toBe(8);
  });

  it('uses the enabled regions of each account with regions ["*"]', async () => {
    const s = setup({ cfg: config({ regions: ['*'], filters: [filter('a', [{ accountIds: [A.id] }])] }), regions: ['us-east-1'] });
    await s.ready;
    await runDiscovery(s.deps, { source: 'manual' });
    expect(s.scanned).toEqual([`${A.id}/us-east-1`]);
  });

  it('skips a scheduled run before the refresh period, unless the last run failed; a manual run always runs', async () => {
    const s = setup({ cfg: AB });
    await s.ready;
    await runDiscovery(s.deps, { source: 'schedule' });
    s.advance(HOUR);
    const skipped = await runDiscovery(s.deps, { source: 'schedule' });
    expect([skipped.status, skipped.skippedReason]).toEqual(['skipped', 'not due']);
    expect((await s.store.lastRun())!.startedAt).not.toBe(skipped.startedAt);
    expect((await runDiscovery(s.deps, { source: 'manual' })).status).toBe('ok');
    s.advance(24 * HOUR);
    expect((await runDiscovery(s.deps, { source: 'schedule' })).status).toBe('ok');
  });

  it('skips a run while another holds the lock, recording it for a manual run only', async () => {
    const s = setup({ cfg: AB });
    await s.ready;
    await s.store.acquireLock('other');
    const manual = await runDiscovery(s.deps, { source: 'manual' });
    expect([manual.status, manual.skippedReason]).toEqual(['skipped', 'another run is in progress']);
    expect(s.scanned).toEqual([]);
    expect((await s.store.lastRun())!.skippedReason).toBe('another run is in progress');
  });

  it('records a failed run and releases the lock when the organization cannot be read', async () => {
    const s = setup({ cfg: AB });
    await s.ready;
    s.deps.organizations = { ...s.org.port, listRoots: async () => { throw Object.assign(new Error('no delegation'), { name: 'AccessDeniedException' }); } };
    const run = await runDiscovery(s.deps, { source: 'manual' });
    expect([run.status, run.error]).toEqual(['failed', 'AccessDeniedException: no delegation']);
    expect(await s.store.acquireLock('next')).toBe(true);
  });

  it('scans only the manager account in single-account mode, without calling Organizations', async () => {
    const s = setup({ cfg: config({ mode: 'account', filters: [filter('all', [{}])] }) });
    await s.ready;
    await runDiscovery(s.deps, { source: 'manual' });
    expect(s.org.calls).toEqual([]);
    expect(s.assumed).toEqual([A.id]);
  });

  it('reads account tags only when a criterion uses them, and records the lint of the run', async () => {
    const s = setup({ cfg: config({ filters: [filter('dev', [{ accountTags: { env: ['dev'] } }, { hosts: ['*.example.org'] }])] }) });
    await s.ready;
    const run = await runDiscovery(s.deps, { source: 'manual' });
    expect(s.org.calls.some((c) => c.startsWith('tags'))).toBe(true);
    expect(s.assumed.sort()).toEqual([A.id, B.id, C.id].sort());
    expect(run.lint.map((f) => [f.code, f.include])).toEqual([['include-matches-nothing', 2]]);
  });
});
