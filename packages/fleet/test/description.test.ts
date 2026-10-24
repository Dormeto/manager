// Descriptions of routers and workloads (descriptions design §2, §3): the checks, the one-line summary, the store items.
import { describe, expect, it } from 'vitest';
import { fakeDynamo } from '../../discovery/test/dynamo-fake.js';
import { createFleetStore } from '../src/index.js';
import { descriptionProblem, summaryOf } from '../src/description.js';

describe('descriptionProblem', () => {
  it('accepts text up to 4,000 characters after trimming, with line feeds and tabs', () => {
    expect(descriptionProblem('')).toBeNull();
    expect(descriptionProblem('# Title\n\n\t- item\n')).toBeNull();
    expect(descriptionProblem(`  ${'a'.repeat(4000)}  `)).toBeNull();
  });
  it('refuses what is not a string, 4,001 characters and control characters other than line feed and tab', () => {
    expect(descriptionProblem(undefined)).toBe('text must be a string');
    expect(descriptionProblem(12)).toBe('text must be a string');
    expect(descriptionProblem('a'.repeat(4001))).toBe('text must be at most 4000 characters');
    expect(descriptionProblem('bell\u0007')).toBe('text must not contain control characters other than line feed and tab');
    expect(descriptionProblem('lone\rreturn')).toBe('text must not contain control characters other than line feed and tab');
    expect(descriptionProblem('csi\u009b')).toBe('text must not contain control characters other than line feed and tab');
    expect(descriptionProblem('nel\u0085')).toBe('text must not contain control characters other than line feed and tab');
    expect(descriptionProblem('del\u007f')).toBe('text must not contain control characters other than line feed and tab');
  });
});

describe('summaryOf', () => {
  it('is the first non-empty line without its Markdown markers', () => {
    expect(summaryOf('\n\n## Payments staging\nmore')).toBe('Payments staging');
    expect(summaryOf('- first item\n- second')).toBe('first item');
    expect(summaryOf('1. step one')).toBe('step one');
    expect(summaryOf('> quoted words')).toBe('quoted words');
    expect(summaryOf('**Owned by payments**')).toBe('Owned by payments');
    expect(summaryOf('*soft*')).toBe('soft');
    expect(summaryOf('* bullet *with* stars')).toBe('bullet *with* stars');
    expect(summaryOf('`code`')).toBe('code');
    expect(summaryOf('  \n  ')).toBe('');
  });
  it('keeps a line whose first and last markers are not one pair', () => {
    expect(summaryOf('**a** and **b**')).toBe('**a** and **b**');
    expect(summaryOf('*a* and *b*')).toBe('*a* and *b*');
    expect(summaryOf('`a` and `b`')).toBe('`a` and `b`');
    expect(summaryOf('**a *b* c**')).toBe('a *b* c');
  });
  it('is cut to 120 characters with an ellipsis', () => {
    const s = summaryOf('x'.repeat(200));
    expect(s).toHaveLength(120);
    expect(s.endsWith('…')).toBe(true);
    expect(summaryOf('y'.repeat(120))).toBe('y'.repeat(120));
  });
});

describe('the description items', () => {
  const setup = () => {
    const dynamo = fakeDynamo();
    return { dynamo, store: createFleetStore({ dynamo, table: 'dmt-dev-manager', now: () => Date.parse('2026-10-24T10:00:00.000Z') }) };
  };
  const workload = { kind: 'workload', account: '1210', region: 'eu-west-1', id: 'shop' } as const;
  const router = { kind: 'router', account: '1210', region: 'eu-west-1' } as const;
  const d = (text: string) => ({ text, by: 'ops@example.com', at: '2026-10-24T10:00:00.000Z' });

  it('puts, gets, lists by kind and deletes (true, then false)', async () => {
    const { store } = setup();
    expect(await store.getDescription(workload)).toBeNull();
    await store.putDescription(workload, d('shop'));
    await store.putDescription({ ...workload, id: 'blog' }, d('blog'));
    await store.putDescription({ ...workload, region: 'eu-west-3' }, d('paris'));
    await store.putDescription(router, d('router'));
    expect(await store.getDescription(workload)).toEqual(d('shop'));
    expect(await store.getDescription(router)).toEqual(d('router'));
    expect([...(await store.listDescriptions('workload')).keys()].sort()).toEqual(['1210#eu-west-1#blog', '1210#eu-west-1#shop', '1210#eu-west-3#shop']);
    expect([...(await store.listDescriptions('router')).entries()]).toEqual([['1210#eu-west-1', d('router')]]);
    expect(await store.deleteDescription(workload)).toBe(true);
    expect(await store.deleteDescription(workload)).toBe(false);
    expect(await store.getDescription(workload)).toBeNull();
  });

  it('lists past a corrupt item (not JSON, or without a text)', async () => {
    const { store, dynamo } = setup();
    await store.putDescription(workload, d('shop'));
    dynamo.items.set('WD#1210#eu-west-1#broken', { pk: { S: 'T#default' }, sk: { S: 'WD#1210#eu-west-1#broken' }, data: { S: '{"text": "cut' } });
    dynamo.items.set('WD#1210#eu-west-1#empty', { pk: { S: 'T#default' }, sk: { S: 'WD#1210#eu-west-1#empty' }, data: { S: '{"by": "ops@example.com"}' } });
    expect([...(await store.listDescriptions('workload')).entries()]).toEqual([['1210#eu-west-1#shop', d('shop')]]);
  });

  it('never expires, unlike the summaries', async () => {
    const { store, dynamo } = setup();
    await store.putDescription(workload, d('shop'));
    expect(JSON.stringify([...dynamo.items.values()])).not.toContain('expiresAt');
  });
});
