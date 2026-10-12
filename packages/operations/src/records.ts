// Operations items of the manager table (partition T#default): operation records, the claim of a target by one operation,
// locks with an expiry, slots per account and region, and the registry of the routers the manager installed.
import { DeleteItemCommand, GetItemCommand, PutItemCommand, QueryCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';

const PK = 'T#default';
const RETENTION_S = 90 * 86_400;
type Item = Record<string, AttributeValue>;

export type OperationType = 'install-router' | 'upgrade-router' | 'uninstall-router' | 'onboard' | 'offboard';
export type StepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

export interface Operation {
  id: string;
  type: OperationType;
  target: Record<string, string>;
  input: Record<string, unknown>;
  status: 'running' | 'succeeded' | 'failed';
  steps: { name: string; status: StepStatus; startedAt?: string; finishedAt?: string; detail?: string; attempts?: number; changed?: boolean }[];
  cursor: number;
  holds: { locks: string[]; slots: string[] };
  activeKey: string;
  context: Record<string, unknown>; // learnt during the run (router, load balancer, waker target group)
  by: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  executionArn?: string;
  error?: string;
}

export interface InstalledRouter {
  name: string;
  account: string;
  region: string;
  controller: string; // function ARNs
  onboarder: string;
  version: string;
  build: string;
  installedBy: string;
  installedAt: string;
}

// Any DynamoDB client: only send() is used.
export interface DynamoSender {
  send(command: object): Promise<any>;
}

const seconds = (ms: number) => Math.floor(ms / 1000);
const conflict = (err: unknown) => (err as Error).name === 'ConditionalCheckFailedException';

export function createRecords({ dynamo, table, now = Date.now }: { dynamo: DynamoSender; table: string; now?: () => number }) {
  const key = (sk: string) => ({ pk: { S: PK }, sk: { S: sk } });
  const get = async (sk: string): Promise<Item | undefined> => (await dynamo.send(new GetItemCommand({ TableName: table, Key: key(sk), ConsistentRead: true }))).Item;
  const data = <T>(item: Item | undefined): T | null => (item?.data?.S ? (JSON.parse(item.data.S) as T) : null);
  async function query(prefix: string): Promise<Item[]> {
    const items: Item[] = [];
    let start: Item | undefined;
    do {
      const page = await dynamo.send(new QueryCommand({
        TableName: table, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': { S: PK }, ':prefix': { S: prefix } }, ...(start ? { ExclusiveStartKey: start } : {}),
      }));
      items.push(...(page.Items ?? []));
      start = page.LastEvaluatedKey;
    } while (start);
    return items;
  }
  // A conditional put: false when the condition does not hold.
  async function putIf(item: Item, condition: string, values: Item): Promise<boolean> {
    try {
      await dynamo.send(new PutItemCommand({ TableName: table, Item: item, ConditionExpression: condition, ExpressionAttributeValues: values, ...(condition.includes('#owner') ? { ExpressionAttributeNames: { '#owner': 'owner' } } : {}) }));
      return true;
    } catch (err) {
      if (conflict(err)) return false;
      throw err;
    }
  }
  async function deleteIf(sk: string, condition: string, values: Item) {
    try {
      await dynamo.send(new DeleteItemCommand({ TableName: table, Key: key(sk), ConditionExpression: condition, ExpressionAttributeValues: values, ...(condition.includes('#owner') ? { ExpressionAttributeNames: { '#owner': 'owner' } } : {}) }));
    } catch (err) {
      if (!conflict(err)) throw err;
    }
  }

  return {
    async putOperation(op: Operation) {
      await dynamo.send(new PutItemCommand({
        TableName: table,
        Item: { ...key(`OP#${op.id}`), data: { S: JSON.stringify(op) }, status: { S: op.status }, expiresAt: { N: String(seconds(Date.parse(op.createdAt)) + RETENTION_S) } },
      }));
    },
    async getOperation(id: string) {
      return data<Operation>(await get(`OP#${id}`));
    },
    async listOperations(limit = 100) {
      return (await query('OP#')).map((i) => data<Operation>(i)!).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
    },

    // One operation per target (target group, router, account-region): a second request learns the running operation.
    async claimActive(activeKey: string, operationId: string, ttlMs: number): Promise<{ ok: true } | { ok: false; operationId: string }> {
      const item = { ...key(`ACTIVE#${activeKey}`), operationId: { S: operationId }, expiresAt: { N: String(seconds(now() + ttlMs)) } };
      if (await putIf(item, 'attribute_not_exists(sk) OR expiresAt < :now', { ':now': { N: String(seconds(now())) } })) return { ok: true };
      const holder = await get(`ACTIVE#${activeKey}`);
      return { ok: false, operationId: holder?.operationId?.S ?? 'unknown' };
    },
    async releaseActive(activeKey: string, operationId: string) {
      await deleteIf(`ACTIVE#${activeKey}`, 'operationId = :id', { ':id': { S: operationId } });
    },

    // A lock held by one owner (an execution) until released or expired; its owner may take it again.
    async acquireLock(lockKey: string, owner: string, leaseMs: number) {
      return putIf(
        { ...key(`LOCK#${lockKey}`), owner: { S: owner }, expiresAt: { N: String(seconds(now() + leaseMs)) } },
        'attribute_not_exists(sk) OR expiresAt < :now OR #owner = :owner',
        { ':now': { N: String(seconds(now())) }, ':owner': { S: owner } },
      );
    },
    async releaseLock(lockKey: string, owner: string) {
      await deleteIf(`LOCK#${lockKey}`, '#owner = :owner', { ':owner': { S: owner } });
    },

    // At most `max` holders, each with an expiry (a holder whose workflow died frees its slot); optimistic on a version.
    async acquireSlot(slotKey: string, owner: string, max: number, leaseMs: number) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const item = await get(`SLOT#${slotKey}`);
        const holders = Object.fromEntries(Object.entries(data<Record<string, number>>(item) ?? {}).filter(([, expires]) => expires > now()));
        if (!(owner in holders) && Object.keys(holders).length >= max) return false;
        holders[owner] = now() + leaseMs;
        const version = Number(item?.version?.N ?? 0);
        const next = { ...key(`SLOT#${slotKey}`), data: { S: JSON.stringify(holders) }, version: { N: String(version + 1) } };
        if (await putIf(next, 'attribute_not_exists(sk) OR version = :version', { ':version': { N: String(version) } })) return true;
      }
      return false;
    },
    async releaseSlot(slotKey: string, owner: string) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const item = await get(`SLOT#${slotKey}`);
        const holders = data<Record<string, number>>(item) ?? {};
        if (!(owner in holders)) return;
        delete holders[owner];
        const version = Number(item?.version?.N ?? 0);
        const next = { ...key(`SLOT#${slotKey}`), data: { S: JSON.stringify(holders) }, version: { N: String(version + 1) } };
        if (await putIf(next, 'attribute_not_exists(sk) OR version = :version', { ':version': { N: String(version) } })) return;
      }
    },

    async putRouter(router: InstalledRouter) {
      await dynamo.send(new PutItemCommand({ TableName: table, Item: { ...key(`ROUTER#${router.account}#${router.region}`), data: { S: JSON.stringify(router) } } }));
    },
    async getRouter(account: string, region: string) {
      return data<InstalledRouter>(await get(`ROUTER#${account}#${region}`));
    },
    async listRouters() {
      return (await query('ROUTER#')).map((i) => data<InstalledRouter>(i)!);
    },
    async deleteRouter(account: string, region: string) {
      await dynamo.send(new DeleteItemCommand({ TableName: table, Key: key(`ROUTER#${account}#${region}`) }));
    },
  };
}

export type Records = ReturnType<typeof createRecords>;
