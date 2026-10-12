// Fakes of a discovery run: Organizations answering from an inventory, roles, enabled regions and scans.
import { expect } from 'vitest';
import type { OrganizationsPort } from '../src/org.js';
import type { RunDeps } from '../src/run.js';
import { createStore } from '../src/store.js';
import type { DiscoveryConfig, OrgInventory, ScannedRule } from '../src/types.js';
import { fakeDynamo } from './dynamo-fake.js';
import { A, INVENTORY, rule } from './fixtures.js';

export const T0 = Date.UTC(2026, 9, 4, 12, 0);
export const HOUR = 3_600_000;

// Organizations answering from an inventory (fixtures: A at the root, B five OUs deep, C in the prod OU).
export function organizationsOf(inventory: OrgInventory) {
  const calls: string[] = [];
  const port: OrganizationsPort = {
    async listRoots() { calls.push('roots'); return { Roots: Object.entries(inventory.ous).filter(([, o]) => o.parent === null).map(([Id, o]) => ({ Id, Name: o.name })) }; },
    async listOrganizationalUnitsForParent({ ParentId }) { return { OrganizationalUnits: Object.entries(inventory.ous).filter(([, o]) => o.parent === ParentId).map(([Id, o]) => ({ Id, Name: o.name })) }; },
    async listAccountsForParent({ ParentId }) { return { Accounts: inventory.accounts.filter((a) => a.ouPath.at(-1) === ParentId).map((a) => ({ Id: a.id, Name: a.name, State: 'ACTIVE' })) }; },
    async listTagsForResource({ ResourceId }) { calls.push(`tags ${ResourceId}`); return { Tags: Object.entries(inventory.accounts.find((a) => a.id === ResourceId)!.tags).map(([Key, Value]) => ({ Key, Value })) }; },
  };
  return { port, calls };
}

export function setup({ cfg, deny = [], failScan = [], regions = ['eu-west-1', 'eu-central-1'], delayMs = 0 }: {
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

