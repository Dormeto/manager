// In-memory DynamoDB: the commands and condition expressions the stores use. Items of the T#default partition are kept by
// their sort key (as before the account partitions), the others by `<pk>|<sk>`; the gsi1 index is queried like a table.
type Value = { S?: string; N?: string; B?: Uint8Array };
type Item = Record<string, Value>;

// DynamoDB item size: attribute names plus values (strings, numbers as text, binary bytes); the limit is 400 KB.
export function itemSize(item: Record<string, { S?: string; N?: string; B?: Uint8Array }>): number {
  return Object.entries(item).reduce((n, [name, v]) => n + Buffer.byteLength(name) + (v.B ? v.B.byteLength : Buffer.byteLength(v.S ?? v.N ?? '')), 0);
}

// laggingIndex: queries on gsi1 see the table as it was at the last settleIndex() (DynamoDB's indexes are eventually
// consistent), the table itself is always current.
// An item written with versions: unversioned (new or older) or at the version read.
const VERSIONED = 'attribute_not_exists(version) OR version = :version';

export function fakeDynamo({ pageSize = 1000, unprocessedOnce = false, laggingIndex = false } = {}) {
  const items = new Map<string, Item>();
  let indexed = new Map<string, Item>();
  const settleIndex = () => { indexed = new Map(items); };
  const calls: string[] = [];
  let unprocessed = unprocessedOnce;
  const fail = (name: string) => Object.assign(new Error(name), { name });
  const keyOf = (k: { pk?: Value; sk?: Value }) => (k.pk?.S === 'T#default' || !k.pk ? k.sk!.S! : `${k.pk.S}|${k.sk!.S}`);
  const send = async (command: { constructor: { name: string }; input: Record<string, any> }) => {
    const { input } = command;
    const name = command.constructor.name;
    calls.push(name);
    switch (name) {
      case 'GetItemCommand':
        return { Item: items.get(keyOf(input.Key)) };
      case 'PutItemCommand': {
        if (itemSize(input.Item) > 400 * 1024) throw fail('ValidationException');
        const existing = items.get(keyOf(input.Item));
        if (input.ConditionExpression === 'attribute_not_exists(sk) OR expiresAt < :now' && existing
          && !(Number(existing.expiresAt?.N) < Number(input.ExpressionAttributeValues[':now'].N))) throw fail('ConditionalCheckFailedException');
        if (input.ConditionExpression === 'attribute_not_exists(sk) OR version = :version' && existing
          && existing.version?.N !== input.ExpressionAttributeValues[':version'].N) throw fail('ConditionalCheckFailedException');
        if (input.ConditionExpression === 'attribute_exists(sk) AND (attribute_not_exists(version) OR version = :version)'
          && (!existing || (existing.version && existing.version.N !== input.ExpressionAttributeValues[':version'].N))) throw fail('ConditionalCheckFailedException');
        if (input.ConditionExpression === VERSIONED && existing?.version && existing.version.N !== input.ExpressionAttributeValues[':version'].N) throw fail('ConditionalCheckFailedException');
        items.set(keyOf(input.Item), input.Item);
        return {};
      }
      case 'DeleteItemCommand': {
        const existing = items.get(keyOf(input.Key));
        if (input.ConditionExpression === 'runId = :id' && existing?.runId?.S !== input.ExpressionAttributeValues[':id'].S) throw fail('ConditionalCheckFailedException');
        if (input.ConditionExpression === VERSIONED && existing?.version && existing.version.N !== input.ExpressionAttributeValues[':version'].N) throw fail('ConditionalCheckFailedException');
        items.delete(keyOf(input.Key));
        return {};
      }
      case 'QueryCommand': {
        // pk = :pk [AND begins_with(sk, :prefix)], or on gsi1: gsi1pk = :pk [AND begins_with(gsi1sk, :prefix)].
        const index = input.IndexName === 'gsi1';
        const [hash, range] = index ? ['gsi1pk', 'gsi1sk'] : ['pk', 'sk'];
        const pk = (input.ExpressionAttributeValues[':pk']?.S ?? 'T#default') as string;
        const prefix = (input.ExpressionAttributeValues[':prefix']?.S ?? '') as string;
        let found = [...(index && laggingIndex ? indexed : items).values()].filter((i) => (i[hash]?.S ?? (hash === 'pk' ? 'T#default' : undefined)) === pk && (i[range]?.S ?? '').startsWith(prefix))
          .sort((a, b) => (a[range]!.S! < b[range]!.S! ? -1 : 1));
        if (input.ScanIndexForward === false) found.reverse();
        // After the start key's position, as DynamoDB does (the item there may have moved or gone since).
        const start = input.ExclusiveStartKey;
        if (start) {
          const at = start[range]?.S ?? '';
          found = found.filter((i) => (input.ScanIndexForward === false ? i[range]!.S! < at : i[range]!.S! > at));
        }
        const limit = Math.min(input.Limit ?? Infinity, pageSize);
        const page = found.slice(0, limit);
        if (input.Select === 'COUNT') {
          const lastCounted = page.at(-1);
          return { Count: page.length, LastEvaluatedKey: lastCounted && found.length > limit ? { pk: lastCounted.pk ?? { S: 'T#default' }, sk: lastCounted.sk!, ...(index ? { gsi1pk: lastCounted.gsi1pk!, gsi1sk: lastCounted.gsi1sk! } : {}) } : undefined };
        }
        const last = page.at(-1);
        const lastKey = last && found.length > limit
          ? { pk: last.pk ?? { S: 'T#default' }, sk: last.sk!, ...(index ? { gsi1pk: last.gsi1pk!, gsi1sk: last.gsi1sk! } : {}) }
          : undefined;
        return { Items: page, LastEvaluatedKey: lastKey };
      }
      case 'BatchGetItemCommand': {
        const table = Object.keys(input.RequestItems)[0]!;
        const keys = input.RequestItems[table].Keys as Item[];
        if (keys.length > 100) throw fail('ValidationException');
        return { Responses: { [table]: keys.map((k) => items.get(keyOf(k))).filter(Boolean) } };
      }
      case 'BatchWriteItemCommand': {
        const requests = input.RequestItems[Object.keys(input.RequestItems)[0]!] as ({ PutRequest: { Item: Item } } | { DeleteRequest: { Key: Item } })[];
        if (requests.length > 25) throw fail('ValidationException');
        const kept = unprocessed ? requests.slice(-1) : [];
        unprocessed = false;
        for (const r of requests.slice(0, requests.length - kept.length)) {
          if ('PutRequest' in r) items.set(keyOf(r.PutRequest.Item), r.PutRequest.Item);
          else items.delete(keyOf(r.DeleteRequest.Key));
        }
        return kept.length ? { UnprocessedItems: { [Object.keys(input.RequestItems)[0]!]: kept } } : {};
      }
      default:
        throw new Error(`unexpected command ${name}`);
    }
  };
  return { send, items, calls, settleIndex };
}
