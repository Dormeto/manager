// In-memory DynamoDB for one partition: the commands and condition expressions the discovery store uses.
type Value = { S?: string; N?: string; B?: Uint8Array };
type Item = Record<string, Value>;

// DynamoDB item size: attribute names plus values (strings, numbers as text, binary bytes); the limit is 400 KB.
export function itemSize(item: Record<string, { S?: string; N?: string; B?: Uint8Array }>): number {
  return Object.entries(item).reduce((n, [name, v]) => n + Buffer.byteLength(name) + (v.B ? v.B.byteLength : Buffer.byteLength(v.S ?? v.N ?? '')), 0);
}

export function fakeDynamo({ pageSize = 1000, unprocessedOnce = false } = {}) {
  const items = new Map<string, Item>();
  const calls: string[] = [];
  let unprocessed = unprocessedOnce;
  const fail = (name: string) => Object.assign(new Error(name), { name });
  const send = async (command: { constructor: { name: string }; input: Record<string, any> }) => {
    const { input } = command;
    const name = command.constructor.name;
    calls.push(name);
    switch (name) {
      case 'GetItemCommand':
        return { Item: items.get(input.Key.sk.S) };
      case 'PutItemCommand': {
        if (itemSize(input.Item) > 400 * 1024) throw fail('ValidationException');
        const existing = items.get(input.Item.sk.S);
        if (input.ConditionExpression === 'attribute_not_exists(sk) OR expiresAt < :now' && existing
          && !(Number(existing.expiresAt?.N) < Number(input.ExpressionAttributeValues[':now'].N))) throw fail('ConditionalCheckFailedException');
        items.set(input.Item.sk.S, input.Item);
        return {};
      }
      case 'DeleteItemCommand': {
        const existing = items.get(input.Key.sk.S);
        if (input.ConditionExpression === 'runId = :id' && existing?.runId?.S !== input.ExpressionAttributeValues[':id'].S) throw fail('ConditionalCheckFailedException');
        items.delete(input.Key.sk.S);
        return {};
      }
      case 'QueryCommand': {
        const prefix = input.ExpressionAttributeValues[':prefix'].S as string;
        let keys = [...items.keys()].filter((k) => k.startsWith(prefix)).sort();
        if (input.ScanIndexForward === false) keys.reverse();
        const startAfter = input.ExclusiveStartKey?.sk.S;
        if (startAfter) keys = keys.slice(keys.indexOf(startAfter) + 1);
        const limit = Math.min(input.Limit ?? Infinity, pageSize);
        const page = keys.slice(0, limit);
        return { Items: page.map((k) => items.get(k)), LastEvaluatedKey: keys.length > limit ? { pk: { S: 'T#default' }, sk: { S: page.at(-1) } } : undefined };
      }
      case 'BatchWriteItemCommand': {
        const requests = input.RequestItems[Object.keys(input.RequestItems)[0]!] as { PutRequest: { Item: Item } }[];
        if (requests.length > 25) throw fail('ValidationException');
        const kept = unprocessed ? requests.slice(-1) : [];
        unprocessed = false;
        for (const r of requests.slice(0, requests.length - kept.length)) items.set(r.PutRequest.Item.sk!.S!, r.PutRequest.Item);
        return kept.length ? { UnprocessedItems: { [Object.keys(input.RequestItems)[0]!]: kept } } : {};
      }
      default:
        throw new Error(`unexpected command ${name}`);
    }
  };
  return { send, items, calls };
}
