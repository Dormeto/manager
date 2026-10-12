// Alarm items of the watchdog (R6a): T#default / ALARM#<subject id>, written with versions. An open alarm stays until
// its subject is clear; a cleared one keeps its damping record and expires 7 days later.
import { DeleteItemCommand, PutItemCommand, QueryCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import type { Alarm, AlarmStore } from './watchdog.js';

const PK = 'T#default';
const PREFIX = 'ALARM#';
const CLEARED_DAYS = 7;
type Item = Record<string, AttributeValue>;
interface DynamoSender { send(command: object): Promise<any> }

async function conditional(write: () => Promise<unknown>): Promise<boolean> {
  try {
    await write();
    return true;
  } catch (err) {
    if ((err as Error).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

export function createAlarmStore({ dynamo, table, now = Date.now }: { dynamo: DynamoSender; table: string; now?: () => number }): AlarmStore & { open(): Promise<Alarm[]> } {
  const key = (id: string) => ({ pk: { S: PK }, sk: { S: `${PREFIX}${id}` } });
  async function list() {
    const items: Item[] = [];
    let start: Item | undefined;
    do {
      const page = await dynamo.send(new QueryCommand({
        TableName: table, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': { S: PK }, ':prefix': { S: PREFIX } }, ...(start ? { ExclusiveStartKey: start } : {}),
      }));
      items.push(...(page.Items ?? []));
      start = page.LastEvaluatedKey;
    } while (start);
    return items.map((i) => ({ alarm: JSON.parse(i.data!.S!) as Alarm, version: Number(i.version?.N ?? 0) }));
  }
  return {
    list,
    async put(alarm, version) {
      const expires: Item = alarm.level === 'ok' ? { expiresAt: { N: String(Math.floor(now() / 1000) + CLEARED_DAYS * 86_400) } } : {};
      return conditional(() => dynamo.send(new PutItemCommand({
        TableName: table, Item: { ...key(alarm.subject.id), data: { S: JSON.stringify(alarm) }, version: { N: String(version + 1) }, ...expires },
        ConditionExpression: 'attribute_not_exists(sk) OR version = :version', ExpressionAttributeValues: { ':version': { N: String(version) } },
      })));
    },
    async remove(id, version) {
      return conditional(() => dynamo.send(new DeleteItemCommand({
        TableName: table, Key: key(id), ConditionExpression: 'attribute_not_exists(version) OR version = :version', ExpressionAttributeValues: { ':version': { N: String(version) } },
      })));
    },
    // Open alarms, errors first, then by subject.
    async open() {
      const rank = { error: 0, warning: 1, ok: 2 } as const;
      return (await list()).map((x) => x.alarm).filter((a) => a.level !== 'ok')
        .sort((a, b) => rank[a.level] - rank[b.level] || a.subject.id.localeCompare(b.subject.id));
    },
  };
}
