import { describe, expect, it } from 'vitest';
import { createRecords, type Operation } from '../src/records.js';
import { fakeDynamo } from './dynamo-fake.js';

const T0 = Date.UTC(2026, 9, 5, 12, 0);
const MIN = 60_000;

function setup() {
  const dynamo = fakeDynamo();
  let now = T0;
  const records = createRecords({ dynamo, table: 't', now: () => now });
  return { dynamo, records, advance: (ms: number) => { now += ms; } };
}

const operation = (id: string, over: Partial<Operation> = {}): Operation => ({
  id, type: 'onboard', target: { targetGroupArn: 'arn:tg' }, input: {}, status: 'running', steps: [{ name: 'lock', status: 'pending' }], cursor: 0,
  holds: { locks: [], slots: [] }, activeKey: 'TG#arn:tg', context: {}, by: 'ops@example.com', createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(), ...over,
});

describe('operation records', () => {
  it('stores operations, kept 90 days, and lists the newest first', async () => {
    const { records, dynamo, advance } = setup();
    await records.putOperation(operation('a'));
    advance(MIN);
    await records.putOperation(operation('b', { createdAt: new Date(T0 + MIN).toISOString() }));
    expect((await records.getOperation('a'))!.id).toBe('a');
    expect(await records.getOperation('nope')).toBeNull();
    expect((await records.listOperations()).map((o) => o.id)).toEqual(['b', 'a']);
    expect(dynamo.items.get('OP#a')!.expiresAt).toEqual({ N: String(T0 / 1000 + 90 * 86_400) });
  });

  it('claims a target for one operation: a second claim names the running one; the claim expires', async () => {
    const { records, advance } = setup();
    expect(await records.claimActive('TG#arn:tg', 'op1', 60 * MIN)).toEqual({ ok: true });
    expect(await records.claimActive('TG#arn:tg', 'op2', 60 * MIN)).toEqual({ ok: false, operationId: 'op1' });
    await records.releaseActive('TG#arn:tg', 'op2');
    expect(await records.claimActive('TG#arn:tg', 'op2', 60 * MIN), 'only its owner releases it').toEqual({ ok: false, operationId: 'op1' });
    advance(61 * MIN);
    expect(await records.claimActive('TG#arn:tg', 'op2', 60 * MIN)).toEqual({ ok: true });
  });

  it('locks: one owner at a time, again by its owner, free after release or expiry', async () => {
    const { records, advance } = setup();
    expect(await records.acquireLock('LB#arn:lb', 'exec1', 30 * MIN)).toBe(true);
    expect(await records.acquireLock('LB#arn:lb', 'exec2', 30 * MIN)).toBe(false);
    expect(await records.acquireLock('LB#arn:lb', 'exec1', 30 * MIN)).toBe(true);
    await records.releaseLock('LB#arn:lb', 'exec2');
    expect(await records.acquireLock('LB#arn:lb', 'exec2', 30 * MIN)).toBe(false);
    await records.releaseLock('LB#arn:lb', 'exec1');
    expect(await records.acquireLock('LB#arn:lb', 'exec2', 30 * MIN)).toBe(true);
    advance(31 * MIN);
    expect(await records.acquireLock('LB#arn:lb', 'exec3', 30 * MIN)).toBe(true);
  });

  it('slots: at most N holders per account and region, expired holders freed', async () => {
    const { records, advance } = setup();
    for (const owner of ['a', 'b', 'c']) expect(await records.acquireSlot('SLOT#1#eu', owner, 3, 30 * MIN)).toBe(true);
    expect(await records.acquireSlot('SLOT#1#eu', 'd', 3, 30 * MIN)).toBe(false);
    expect(await records.acquireSlot('SLOT#1#eu', 'b', 3, 30 * MIN)).toBe(true);
    await records.releaseSlot('SLOT#1#eu', 'b');
    expect(await records.acquireSlot('SLOT#1#eu', 'd', 3, 30 * MIN)).toBe(true);
    expect(await records.acquireSlot('SLOT#1#eu', 'e', 3, 30 * MIN)).toBe(false);
    advance(31 * MIN);
    expect(await records.acquireSlot('SLOT#1#eu', 'e', 3, 30 * MIN)).toBe(true);
  });

  it('registers installed routers by account and region', async () => {
    const { records } = setup();
    const router = { name: 'dmt-dev', account: '121014831971', region: 'eu-west-3', controller: 'arn:c', onboarder: 'arn:o', version: '0.18.0', build: 'abc', installedBy: 'ops', installedAt: 'x' };
    await records.putRouter(router);
    expect(await records.listRouters()).toEqual([router]);
    expect(await records.getRouter('121014831971', 'eu-west-3')).toEqual(router);
    await records.deleteRouter('121014831971', 'eu-west-3');
    expect(await records.listRouters()).toEqual([]);
  });
});
