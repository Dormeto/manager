// In-memory DynamoDB for one partition, evaluating the condition expressions the operation records use.
type Value = { S?: string; N?: string };
type Item = Record<string, Value>;

export function fakeDynamo() {
  const items = new Map<string, Item>();
  const fail = (name: string) => Object.assign(new Error(name), { name });
  const num = (v?: Value) => Number(v?.N ?? 'NaN');
  const check = (condition: string | undefined, existing: Item | undefined, values: Record<string, Value>) => {
    if (!condition) return true;
    const ok = {
      'attribute_not_exists(sk) OR expiresAt < :now': () => !existing || num(existing.expiresAt) < num(values[':now']),
      'attribute_not_exists(sk) OR expiresAt < :now OR #owner = :owner': () => !existing || num(existing.expiresAt) < num(values[':now']) || existing.owner?.S === values[':owner']!.S,
      '#owner = :owner': () => existing?.owner?.S === values[':owner']!.S,
      'operationId = :id': () => existing?.operationId?.S === values[':id']!.S,
      'attribute_not_exists(sk) OR version = :version': () => !existing || existing.version?.N === values[':version']!.N,
    }[condition];
    if (!ok) throw new Error(`fake: unsupported condition ${condition}`);
    return ok();
  };
  async function send(command: { constructor: { name: string }; input: Record<string, any> }) {
    const { input } = command;
    switch (command.constructor.name) {
      case 'GetItemCommand': return { Item: items.get(input.Key.sk.S) };
      case 'PutItemCommand': {
        if (!check(input.ConditionExpression, items.get(input.Item.sk.S), input.ExpressionAttributeValues ?? {})) throw fail('ConditionalCheckFailedException');
        items.set(input.Item.sk.S, input.Item);
        return {};
      }
      case 'DeleteItemCommand': {
        if (!check(input.ConditionExpression, items.get(input.Key.sk.S), input.ExpressionAttributeValues ?? {})) throw fail('ConditionalCheckFailedException');
        items.delete(input.Key.sk.S);
        return {};
      }
      case 'QueryCommand': {
        const prefix = input.ExpressionAttributeValues[':prefix'].S as string;
        return { Items: [...items.keys()].filter((k) => k.startsWith(prefix)).sort().map((k) => items.get(k)) };
      }
      default: throw new Error(`fake: unsupported ${command.constructor.name}`);
    }
  }
  return { items, send };
}
