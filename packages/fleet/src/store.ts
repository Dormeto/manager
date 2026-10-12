// Routers and their workloads as they report (vision scale design §4), partition T#default: RS#<account>#<region> per
// router, WS#<account>#<region>#<workloadId> per workload. Written from the router events, read by the API.
import { DeleteItemCommand, GetItemCommand, PutItemCommand, QueryCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';

const PK = 'T#default';
const VERSIONED = 'attribute_not_exists(version) OR version = :version';
// A conditional write: false when its condition failed.
async function conditional(write: () => Promise<unknown>): Promise<boolean> {
  try {
    await write();
    return true;
  } catch (err) {
    if ((err as Error).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}
type Item = Record<string, AttributeValue>;

export interface RouterSummary {
  account: string;
  region: string;
  name: string;
  version: string | null;
  build: string | null;
  checkSchedule: string | null;
  checkedAt: string;
  durationMs: number | null;
  health: Record<string, unknown> | null;
  pauses: unknown[];
  counts: Record<string, number>;
  // The chunks received of the last check: its workloads are complete once every chunk is in.
  check: { checkedAt: string; total: number; received: number[] };
}

export interface WorkloadSummary {
  account: string;
  region: string;
  router: string;
  workloadId: string;
  name?: string;
  state?: string;
  targetGroupArn?: string;
  checkedAt?: string; // the check that wrote it
  stateAt?: string; // the last state change applied
  [field: string]: unknown;
}

// A workload whose last wake failed (R7b): its failure until a successful wake.
export interface FailureEntry {
  account: string;
  region: string;
  router: string;
  workloadId: string;
  name?: string;
  url?: string | null;
  wakeId?: string;
  failure: { kind: string; step: string; backend?: string; message: string; at: string };
  consecutiveFailures?: number;
  nextAttemptAt?: string;
}
const failureKey = (account: string, region: string, id: string) => `WF#${account}#${region}#${id}`;

// Any DynamoDB client: only send() is used.
export interface DynamoSender {
  send(command: object): Promise<any>;
}

// Summaries expire this long after their last write (the table's TTL): those of a router uninstalled or gone leave.
const SUMMARY_DAYS = 7;

export function createFleetStore({ dynamo, table, now = Date.now }: { dynamo: DynamoSender; table: string; now?: () => number }) {
  const key = (sk: string) => ({ pk: { S: PK }, sk: { S: sk } });
  const expiresAt = () => ({ N: String(Math.floor(now() / 1000) + SUMMARY_DAYS * 86_400) });
  const routerKey = (account: string, region: string) => `RS#${account}#${region}`;
  const workloadKey = (account: string, region: string, id: string) => `WS#${account}#${region}#${id}`;
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

  return {
    async getRouter(account: string, region: string): Promise<{ summary: RouterSummary; version: number } | null> {
      const { Item } = await dynamo.send(new GetItemCommand({ TableName: table, Key: key(routerKey(account, region)), ConsistentRead: true }));
      const summary = data<RouterSummary>(Item);
      return summary ? { summary, version: Number(Item.version?.N ?? 0) } : null;
    },
    // Optimistic: false when another writer changed it since `version` was read.
    async putRouter(summary: RouterSummary, version: number): Promise<boolean> {
      try {
        await dynamo.send(new PutItemCommand({
          TableName: table, Item: { ...key(routerKey(summary.account, summary.region)), data: { S: JSON.stringify(summary) }, version: { N: String(version + 1) }, expiresAt: expiresAt() },
          ConditionExpression: 'attribute_not_exists(sk) OR version = :version', ExpressionAttributeValues: { ':version': { N: String(version) } },
        }));
        return true;
      } catch (err) {
        if ((err as Error).name === 'ConditionalCheckFailedException') return false;
        throw err;
      }
    },
    async listRouters(): Promise<RouterSummary[]> {
      return (await query('RS#')).map((i) => data<RouterSummary>(i)!).filter(Boolean);
    },
    async getWorkload(account: string, region: string, id: string): Promise<WorkloadSummary | null> {
      const { Item } = await dynamo.send(new GetItemCommand({ TableName: table, Key: key(workloadKey(account, region, id)), ConsistentRead: true }));
      return data<WorkloadSummary>(Item);
    },
    // Versioned (several events of a router are ingested at once): a write or delete is refused (false) when another
    // writer changed the workload since `version` was read; summaries written before versions count as version 0.
    async readWorkload(account: string, region: string, id: string): Promise<{ summary: WorkloadSummary; version: number } | null> {
      const { Item } = await dynamo.send(new GetItemCommand({ TableName: table, Key: key(workloadKey(account, region, id)), ConsistentRead: true }));
      const summary = data<WorkloadSummary>(Item);
      return summary ? { summary, version: Number(Item.version?.N ?? 0) } : null;
    },
    async writeWorkload(w: WorkloadSummary, version: number): Promise<boolean> {
      return conditional(() => dynamo.send(new PutItemCommand({
        TableName: table, Item: { ...key(workloadKey(w.account, w.region, w.workloadId)), data: { S: JSON.stringify(w) }, version: { N: String(version + 1) }, expiresAt: expiresAt() },
        ConditionExpression: VERSIONED, ExpressionAttributeValues: { ':version': { N: String(version) } },
      })));
    },
    async deleteWorkload(w: Pick<WorkloadSummary, 'account' | 'region' | 'workloadId'>, version: number): Promise<boolean> {
      return conditional(() => dynamo.send(new DeleteItemCommand({
        TableName: table, Key: key(workloadKey(w.account, w.region, w.workloadId)), ConditionExpression: VERSIONED, ExpressionAttributeValues: { ':version': { N: String(version) } },
      })));
    },
    async routerWorkloads(account: string, region: string): Promise<WorkloadSummary[]> {
      return (await query(`WS#${account}#${region}#`)).map((i) => data<WorkloadSummary>(i)!).filter(Boolean);
    },
    async listWorkloads(): Promise<WorkloadSummary[]> {
      return (await query('WS#')).map((i) => data<WorkloadSummary>(i)!).filter(Boolean);
    },
    // The failure index (R7b): WF#<account>#<region>#<workloadId>, written on failures only, read by the watchdog.
    async getFailure(account: string, region: string, id: string): Promise<{ entry: FailureEntry; version: number } | null> {
      const { Item } = await dynamo.send(new GetItemCommand({ TableName: table, Key: key(failureKey(account, region, id)), ConsistentRead: true }));
      const entry = data<FailureEntry>(Item);
      return entry ? { entry, version: Number(Item.version?.N ?? 0) } : null;
    },
    async putFailure(entry: FailureEntry, version: number): Promise<boolean> {
      return conditional(() => dynamo.send(new PutItemCommand({
        TableName: table, Item: { ...key(failureKey(entry.account, entry.region, entry.workloadId)), data: { S: JSON.stringify(entry) }, version: { N: String(version + 1) } },
        ConditionExpression: 'attribute_not_exists(sk) OR version = :version', ExpressionAttributeValues: { ':version': { N: String(version) } },
      })));
    },
    async deleteFailure(account: string, region: string, id: string, version: number): Promise<boolean> {
      return conditional(() => dynamo.send(new DeleteItemCommand({
        TableName: table, Key: key(failureKey(account, region, id)), ConditionExpression: VERSIONED, ExpressionAttributeValues: { ':version': { N: String(version) } },
      })));
    },
    async listFailures(): Promise<FailureEntry[]> {
      return (await query('WF#')).map((i) => data<FailureEntry>(i)!).filter(Boolean);
    },
  };
}

export type FleetStore = ReturnType<typeof createFleetStore>;

// A router reports while its last check is at most 3 periods of its schedule old (5 minutes by default).
export function reporting(router: { checkedAt: string | null; checkSchedule: string | null }, now = Date.now()): boolean {
  if (!router.checkedAt) return false;
  const rate = /rate\((\d+) (minute|minutes|hour|hours)\)/.exec(router.checkSchedule ?? '');
  const periodMs = rate ? Number(rate[1]) * (rate[2]!.startsWith('hour') ? 3_600_000 : 60_000) : 5 * 60_000;
  return now - Date.parse(router.checkedAt) <= 3 * periodMs;
}
