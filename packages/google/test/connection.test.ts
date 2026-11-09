// The connection's record, read from DynamoDB as the operations function and the access check do.
import { describe, expect, it } from 'vitest';
import { readConnection } from '../src/index.js';

const sending = (item: unknown) => {
  const sent: { input: unknown }[] = [];
  return { sent, dynamo: { send: async (command: { input: unknown }) => { sent.push(command); return { Item: item }; } } as never };
};

describe('readConnection', () => {
  it('reads the data of T#default, DISC#GOOGLE, consistently', async () => {
    const { sent, dynamo } = sending({ data: { S: JSON.stringify({ project: 'dormeto-host' }) } });
    expect(await readConnection({ dynamo, table: 'tbl' })()).toEqual({ project: 'dormeto-host' });
    expect(sent[0]!.input).toEqual({ TableName: 'tbl', Key: { pk: { S: 'T#default' }, sk: { S: 'DISC#GOOGLE' } }, ConsistentRead: true });
  });

  it('is null while there is no record', async () => {
    expect(await readConnection({ dynamo: sending(undefined).dynamo, table: 'tbl' })()).toBeNull();
  });
});
