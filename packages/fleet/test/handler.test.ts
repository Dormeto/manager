// The queue of router events: each record ingested on its own; only failed ones come back.
import { describe, expect, it } from 'vitest';
import { processRecords } from '../src/ingest.js';

describe('router events queue', () => {
  it('ingests each record and reports only the failed ones', async () => {
    const seen: string[] = [];
    const ingest = async (event: { detail: { workloadId?: string } }) => {
      if (event.detail.workloadId === 'bad') throw new Error('boom');
      seen.push(event.detail.workloadId ?? '?');
    };
    const record = (id: string, workloadId: string) => ({ messageId: id, body: JSON.stringify({ account: '1', region: 'eu-west-1', 'detail-type': 'Workload state changed', detail: { workloadId } }) });
    const result = await processRecords([record('m1', 'a'), record('m2', 'bad'), { messageId: 'm3', body: 'not json' }, record('m4', 'b')], ingest as never, { warn: () => {} });
    expect(seen).toEqual(['a', 'b']);
    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'm2' }, { itemIdentifier: 'm3' }] });
  });
});
