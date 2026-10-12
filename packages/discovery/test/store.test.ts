import { describe, expect, it } from 'vitest';
import { createStore } from '../src/store.js';
import type { Candidate, RunRecord } from '../src/types.js';
import { config, rule } from './fixtures.js';
import { fakeDynamo } from './dynamo-fake.js';

const T0 = Date.UTC(2026, 9, 4, 12, 0);
const DAY_S = 86_400;

function setup(options?: Parameters<typeof fakeDynamo>[0]) {
  const dynamo = fakeDynamo(options);
  let now = T0;
  const store = createStore({ dynamo, table: 'dmt-dev-manager', now: () => now });
  return { store, dynamo, advance: (ms: number) => { now += ms; } };
}

const run = (startedAt: string, status: RunRecord['status'] = 'ok'): RunRecord => ({ startedAt, finishedAt: startedAt, trigger: 'schedule', status, targets: [], counts: {}, lint: [] });
const candidate = (i: number, over: Partial<Candidate> = {}): Candidate => ({
  ...rule({ id: `arn:rule/${String(i).padStart(3, '0')}` }), accountName: 'tools', ouPath: [], scope: 'in', scopeReason: 'in',
  status: 'pending-onboarding', statusReason: 'eligible', firstSeenAt: '2026-10-04T12:00:00.000Z', lastSeenAt: '2026-10-04T12:00:00.000Z', history: [], ...over,
});

describe('discovery store', () => {
  it('stores the configuration with who changed it and when', async () => {
    const { store, dynamo } = setup();
    expect(await store.getConfig()).toBeNull();
    await store.putConfig(config(), 'admin@example.com');
    expect(await store.getConfig()).toEqual({ config: config(), updatedAt: new Date(T0).toISOString(), updatedBy: 'admin@example.com' });
    expect([...dynamo.items.keys()]).toEqual(['DISC#CONFIG']);
  });

  it('takes the run lock once, again after it expires, and releases only its own lock', async () => {
    const { store, advance } = setup();
    expect(await store.acquireLock('run-1')).toBe(true);
    expect(await store.acquireLock('run-2')).toBe(false);
    await store.releaseLock('run-2');
    expect(await store.acquireLock('run-2')).toBe(false);
    advance(15 * 60_000 + 1000);
    expect(await store.acquireLock('run-2')).toBe(true);
    await store.releaseLock('run-2');
    expect(await store.acquireLock('run-3')).toBe(true);
  });

  it('keeps runs 90 days and finds the last one, or the last completed one', async () => {
    const { store, dynamo } = setup({ pageSize: 2 });
    await store.putRun(run('2026-10-03T12:00:00.000Z'));
    for (const at of ['2026-10-04T10:00:00.000Z', '2026-10-04T11:00:00.000Z', '2026-10-04T12:00:00.000Z']) await store.putRun(run(at, 'skipped'));
    expect((await store.lastRun())!.startedAt).toBe('2026-10-04T12:00:00.000Z');
    expect((await store.lastRun({ completed: true }))!.startedAt).toBe('2026-10-03T12:00:00.000Z');
    expect(Number(dynamo.items.get('DISC#RUN#2026-10-03T12:00:00.000Z')!.expiresAt!.N)).toBe(Date.parse('2026-10-03T12:00:00.000Z') / 1000 + 90 * DAY_S);
  });

  it('writes candidates in batches of 25 (retrying unprocessed ones) and reads them back across pages', async () => {
    const { store, dynamo } = setup({ pageSize: 10, unprocessedOnce: true });
    await store.putCandidates(Array.from({ length: 30 }, (_, i) => candidate(i)));
    const all = await store.listCandidates();
    expect(all).toHaveLength(30);
    expect(all[29]!.id).toBe('arn:rule/029');
    expect(dynamo.calls.filter((c) => c === 'BatchWriteItemCommand').length).toBe(3);
    expect((await store.getCandidate('arn:rule/007'))!.status).toBe('pending-onboarding');
    expect(await store.getCandidate('arn:rule/nope')).toBeNull();
  });

  it('expires a gone candidate 90 days after it disappeared', async () => {
    const { store, dynamo } = setup();
    await store.putCandidates([candidate(1, { status: 'gone', goneAt: '2026-10-04T12:00:00.000Z' }), candidate(2)]);
    expect(Number(dynamo.items.get('DISC#C#arn:rule/001')!.expiresAt!.N)).toBe(T0 / 1000 + 90 * DAY_S);
    expect(dynamo.items.get('DISC#C#arn:rule/002')!.expiresAt).toBeUndefined();
  });

  it('stores the organization inventory of the last run', async () => {
    const { store } = setup();
    const inventory = { accounts: [{ id: '111111111111', name: 'tools', ouPath: ['r-1u0b'], tags: {} }], ous: { 'r-1u0b': { name: 'Root', parent: null } } };
    await store.putInventory(inventory);
    expect(await store.getInventory()).toEqual(inventory);
  });
});

describe('discovery store at organization scale', () => {
  it('keeps a run of 4,000 account-regions under the DynamoDB item limit and reads it back', async () => {
    const { store } = setup();
    const targets = Array.from({ length: 4000 }, (_, i) => ({
      account: String(100000000000 + i), region: 'ap-southeast-7', status: 'error' as const,
      error: 'no access: deploy DmtDiscoveryRole to this account',
    }));
    await store.putRun({ ...run('2026-10-04T12:00:00.000Z'), targets });
    expect((await store.lastRun())!.targets).toHaveLength(4000);
  });

  it('keeps the inventory of 3,000 accounts with tags under the item limit', async () => {
    const { store } = setup();
    const accounts = Array.from({ length: 3000 }, (_, i) => ({
      id: String(100000000000 + i), name: `account-${i}-of-a-large-organization`, ouPath: ['r-1u0b', 'ou-1u0b-aaaaaaaa', 'ou-1u0b-bbbbbbbb'],
      tags: { env: 'production', team: `team-${i % 40}`, 'cost-center': `cc-${i % 97}` },
    }));
    await store.putInventory({ accounts, ous: { 'r-1u0b': { name: 'Root', parent: null } } });
    expect((await store.getInventory())!.accounts).toHaveLength(3000);
  });
});
