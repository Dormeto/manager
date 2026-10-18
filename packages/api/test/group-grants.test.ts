// The API's cache of all groups' grants (tags design §4): 60 s per instance, a write by this instance seen at once.
import { describe, expect, it } from 'vitest';
import { createGroupGrants } from '../src/group-grants.js';
import type { Grant } from '../src/access.js';

const g = (team: string): Grant => ({ tags: { team }, permissions: ['read'] });

function setup(failing = false) {
  let clock = 0;
  let groups = [{ name: 'a', grants: [g('a')] }, { name: 'b', grants: [g('b')] }];
  let fail = failing;
  let reads = 0;
  const cache = createGroupGrants({ list: async () => { reads++; if (fail) throw new Error('throttled'); return groups; }, now: () => clock });
  return { cache, reads: () => reads, advance: (ms: number) => { clock += ms; }, set: (next: typeof groups) => { groups = next; }, fail: (on: boolean) => { fail = on; } };
}

describe('group grants cache', () => {
  it('gives the grants of the groups named, in that order, none for an unknown group', async () => {
    const s = setup();
    expect(await s.cache.of(['b', 'a', 'gone'])).toEqual([[g('b')], [g('a')], []]);
    expect(await s.cache.of([])).toEqual([]);
  });

  it('reads once within 60 s, again after, whatever the groups asked', async () => {
    const s = setup();
    await s.cache.of(['a']);
    s.set([{ name: 'a', grants: [g('changed')] }]);
    s.advance(59_999);
    expect(await s.cache.of(['a'])).toEqual([[g('a')]]);
    expect(s.reads()).toBe(1);
    s.advance(1);
    expect(await s.cache.of(['a'])).toEqual([[g('changed')]]);
    expect(s.reads()).toBe(2);
  });

  it('shares one read between simultaneous requests', async () => {
    const s = setup();
    await Promise.all([s.cache.of(['a']), s.cache.of(['b']), s.cache.of(['a'])]);
    expect(s.reads()).toBe(1);
  });

  it('a write by this instance is seen at once', async () => {
    const s = setup();
    await s.cache.of(['a']);
    s.set([{ name: 'a', grants: [g('new')] }]);
    s.cache.changed();
    expect(await s.cache.of(['a'])).toEqual([[g('new')]]);
  });

  it('keeps the last grants when a read fails, and gives none (fails closed) when it never succeeded', async () => {
    const s = setup(true);
    expect(await s.cache.of(['a'])).toEqual([[]]);
    s.fail(false);
    s.advance(10_000);
    expect(await s.cache.of(['a'])).toEqual([[g('a')]]);
    s.fail(true);
    s.advance(60_000);
    expect(await s.cache.of(['a'])).toEqual([[g('a')]]);
  });

  it('after a failure, serves the kept grants and does not retry within 10 s', async () => {
    const s = setup();
    await s.cache.of(['a']);
    s.advance(60_000);
    s.fail(true);
    expect(await s.cache.of(['a'])).toEqual([[g('a')]]);
    expect(s.reads()).toBe(2);
    s.advance(9_999);
    await s.cache.of(['a']);
    expect(s.reads()).toBe(2);
    s.advance(1);
    await s.cache.of(['a']);
    expect(s.reads()).toBe(3);
  });

  it('serves the kept grants for 10 minutes of failures, none after, until a read succeeds', async () => {
    const s = setup();
    await s.cache.of(['a']);
    s.fail(true);
    s.advance(10 * 60_000);
    expect(await s.cache.of(['a'])).toEqual([[g('a')]]);
    s.advance(1);
    s.advance(10_000);
    expect(await s.cache.of(['a'])).toEqual([[]]);
    s.fail(false);
    s.advance(10_000);
    expect(await s.cache.of(['a'])).toEqual([[g('a')]]);
  });

  it('a write during a read is not hidden by the read\'s older result', async () => {
    let release!: () => void;
    let calls = 0;
    let groups = [{ name: 'a', grants: [g('old')] }];
    const cache = createGroupGrants({ list: async () => { calls++; const seen = groups; if (calls === 1) await new Promise<void>((r) => { release = r; }); return seen; } });
    const first = cache.of(['a']);
    groups = [{ name: 'a', grants: [g('new')] }];
    cache.changed();
    release();
    await first;
    expect(await cache.of(['a'])).toEqual([[g('new')]]);
    expect(calls).toBe(2);
  });
});
