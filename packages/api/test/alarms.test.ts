import { describe, expect, it } from 'vitest';
import { fakeDynamo } from '../../discovery/test/dynamo-fake.js';
import { createAlarmStore } from '../src/alarms.js';
import type { Alarm } from '../src/watchdog.js';

const NOW = Date.UTC(2026, 9, 8, 12, 0);
const alarm = (level: Alarm['level'], id = 'router#1#eu-west-1'): Alarm => ({
  subject: { id, kind: 'router', name: 'dmt-dev', account: '1', region: 'eu-west-1' }, level, since: new Date(NOW).toISOString(),
  problems: level === 'ok' ? [] : [{ code: 'silent', level, text: 'no report received', since: new Date(NOW).toISOString() }], notified: [], cleared: {},
});

describe('alarm store', () => {
  it('writes an alarm once per version read, lists and removes it', async () => {
    const dynamo = fakeDynamo();
    const store = createAlarmStore({ dynamo, table: 't', now: () => NOW });
    expect(await store.put(alarm('error'), 0)).toBe(true);
    expect(await store.put(alarm('warning'), 0), 'another run wrote it first').toBe(false);
    const [read] = await store.list();
    expect(read).toEqual({ alarm: alarm('error'), version: 1 });
    expect(await store.put(alarm('warning'), 1)).toBe(true);
    expect(await store.remove('router#1#eu-west-1', 1)).toBe(false);
    expect(await store.remove('router#1#eu-west-1', 2)).toBe(true);
    expect(await store.list()).toEqual([]);
  });

  it('lets a cleared alarm expire 7 days later (its damping is over long before); an open one never', async () => {
    const dynamo = fakeDynamo();
    const store = createAlarmStore({ dynamo, table: 't', now: () => NOW });
    await store.put(alarm('ok', 'a'), 0);
    await store.put(alarm('error', 'b'), 0);
    const items = (dynamo as unknown as { items: Map<string, Record<string, { N?: string }>> }).items;
    expect(items.get('ALARM#a')!.expiresAt!.N).toBe(String(NOW / 1000 + 7 * 86_400));
    expect(items.get('ALARM#b')!.expiresAt).toBeUndefined();
  });

  it('gives the open alarms only, errors first', async () => {
    const store = createAlarmStore({ dynamo: fakeDynamo(), table: 't', now: () => NOW });
    await store.put(alarm('warning', 'w'), 0);
    await store.put(alarm('ok', 'o'), 0);
    await store.put(alarm('error', 'e'), 0);
    expect((await store.open()).map((a) => a.subject.id)).toEqual(['e', 'w']);
  });
});
