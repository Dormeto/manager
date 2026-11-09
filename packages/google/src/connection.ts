// The connection's record (`DISC#GOOGLE`, `T#default`) as the operations function and the access check read it: the
// item's `data` JSON, null while `dormeto gcp connect` has not made one.
import { GetItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { GoogleConnection } from './google.js';

export function readConnection({ dynamo, table }: { dynamo: Pick<DynamoDBClient, 'send'>; table: string }): () => Promise<GoogleConnection | null> {
  return async () => {
    const item = (await dynamo.send(new GetItemCommand({ TableName: table, Key: { pk: { S: 'T#default' }, sk: { S: 'DISC#GOOGLE' } }, ConsistentRead: true }))).Item;
    return item?.data?.S ? (JSON.parse(item.data.S) as GoogleConnection) : null;
  };
}
