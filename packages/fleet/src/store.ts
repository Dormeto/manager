// Routers and their workloads as they report (vision scale design §4), partition T#default: RS#<account>#<region> per
// router, WS#<account>#<region>#<workloadId> per workload. Written from the router events, read by the API. Each
// workload's state history (R8) in its own partition HIST#<account>#<region>#<workloadId>, sorted by time.
import { DeleteItemCommand, GetItemCommand, PutItemCommand, QueryCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import type { Discounts, StoppedItem } from './prices.js';
import { checkMinutesOf, type IdleWindowAdvice } from './idle.js';

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
  stateAt?: string; // when its state began: the last state change applied, or the router's (0.26.0)
  historySince?: string; // the time of its first history entry (R8)
  [field: string]: unknown;
}

// A state transition (R8): from the router's event, or inferred from a check when the event was lost (or not yet in).
export interface HistoryEntry {
  account: string;
  region: string;
  router: string;
  workloadId: string;
  from: string | null; // null: the first entry, when the manager first saw the workload
  to: string;
  at: string;
  cause?: string;
  wakeId?: string;
  durationMs?: number; // a wake's, on AWAKE
  failure?: { kind: string; step: string; backend?: string; message: string; at?: string };
  by?: string; // who asked it from the manager
  inferred?: boolean;
  stopped?: StoppedItem[]; // what the nap stopped (ASLEEP, routers 0.27.0: R9)
}
// The entries of a period read at most (a request's bound).
export const HISTORY_MAX = 5000;

// A workload's savings of one UTC day (R9): pk SAV#<date>, sk <account>#<region>#<workloadId>, kept history_days.
export interface SavingsDay {
  account: string; region: string; router: string; workloadId: string; name?: string;
  usd: number;
  asleepHours: number; // asleep, whatever the baseline
  hours: number; // asleep within the baseline
  unpriced: { reason: string; hours: number }[];
}
// What the daily job computed last (T#default / SAVINGS), read by the Overview in one request.
export interface SavingsSummary {
  computedAt: string;
  day: string; // the latest day computed
  baseline: { kind: string; timeZone?: string };
  last30: { usd: number; asleepHours: number; days: { date: string; usd: number }[] };
  month: { month: string; usd: number };
  cumulative: { usd: number; since: string; lastDay: string };
  counted: Record<string, number>; // each day's total (review I1: a day run again replaces its amount, in any order)
  failed?: number; // workloads whose day could not be computed, at the latest run
  top: { account: string; region: string; router: string; workloadId: string; name?: string; usd: number }[];
  unpriced: { workloads: number; hours: number };
  workloads: number;
  dormeto: { usdMonth: number };
  discounts?: Discounts; // those of its latest day (R9.5); none before 0.8.0
}
// The discounts for commitments (R9.5), set by administrators (T#default / SAVINGS#SETTINGS).
export interface SavingsSettings extends Discounts { updatedAt: string | null; updatedBy: string | null }

// The manager's daily update check (design 2026-10-18-daily-update-check-design.md), set by administrators (UPDATE#CHECK).
export interface UpdateCheck { enabled: boolean; alert: boolean; updatedAt?: string; updatedBy?: string }
// The last check (UPDATE#RESULT): latest is the newest version above the running one, null when up to date; notified, the
// last version sent to the alert topic.
export interface UpdateResult { checkedAt: string; running: string; latest: string | null; error?: string; notified?: string }

// A custom group's grants (tags design §4), set by administrators (GROUP#<name>): the same shape as the API's grants.
export interface Group {
  name: string;
  description: string;
  grants: { tags: Record<string, string>; permissions: ('read' | 'wake' | 'nap')[] }[];
  updatedAt: string | null;
  updatedBy: string | null;
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

export function createFleetStore({ dynamo, table, now = Date.now, historyDays = 400 }: { dynamo: DynamoSender; table: string; now?: () => number; historyDays?: number }) {
  const historyPk = (account: string, region: string, id: string) => ({ S: `HIST#${account}#${region}#${id}` });
  const key = (sk: string) => ({ pk: { S: PK }, sk: { S: sk } });
  const expiresAt = () => ({ N: String(Math.floor(now() / 1000) + SUMMARY_DAYS * 86_400) });
  const routerKey = (account: string, region: string) => `RS#${account}#${region}`;
  const workloadKey = (account: string, region: string, id: string) => `WS#${account}#${region}#${id}`;
  const data = <T>(item: Item | undefined): T | null => (item?.data?.S ? (JSON.parse(item.data.S) as T) : null);
  const groupOf = (item: Item): Group => {
    const d = data<{ description?: string; grants?: Group['grants'] }>(item);
    return { name: item.sk!.S!.slice('GROUP#'.length), description: d?.description ?? '', grants: d?.grants ?? [], updatedAt: item.updatedAt?.S ?? null, updatedBy: item.updatedBy?.S ?? null };
  };
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

    // One item per transition (R8): a duplicate event writes the same item. An inferred entry never replaces another: the
    // event's, with its cause and details, wins whenever it comes. False when an inferred entry was already there.
    async putHistory(entry: HistoryEntry): Promise<boolean> {
      const item = {
        pk: historyPk(entry.account, entry.region, entry.workloadId), sk: { S: `${entry.at}#${entry.to}` }, data: { S: JSON.stringify(entry) },
        expiresAt: { N: String(Math.floor(Date.parse(entry.at) / 1000) + historyDays * 86_400) },
      };
      if (!entry.inferred) {
        await dynamo.send(new PutItemCommand({ TableName: table, Item: item }));
        return true;
      }
      return conditional(() => dynamo.send(new PutItemCommand({ TableName: table, Item: item, ConditionExpression: 'attribute_not_exists(sk)' })));
    },

    // A period's entries, oldest first: the newest max of them (review I2: the latest days are what people look at), then
    // truncated.
    async listHistory(account: string, region: string, id: string, from: string, to: string, { max = HISTORY_MAX }: { max?: number } = {}): Promise<{ entries: HistoryEntry[]; truncated: boolean }> {
      const entries: HistoryEntry[] = [];
      let start: Item | undefined;
      do {
        const page = await dynamo.send(new QueryCommand({
          TableName: table, KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to', ScanIndexForward: false, Limit: Math.min(1000, max - entries.length + 1),
          ExpressionAttributeValues: { ':pk': historyPk(account, region, id), ':from': { S: from }, ':to': { S: `${to}~` } }, ...(start ? { ExclusiveStartKey: start } : {}),
        }));
        entries.push(...(page.Items ?? []).map((i: Item) => data<HistoryEntry>(i)!).filter(Boolean));
        start = page.LastEvaluatedKey;
      } while (start && entries.length <= max);
      return { entries: entries.slice(0, max).reverse(), truncated: entries.length > max };
    },

    // Savings (R9): a day item per workload, idempotent by key; the job's summary.
    async putSavingsDay(date: string, day: SavingsDay): Promise<void> {
      await dynamo.send(new PutItemCommand({
        TableName: table, Item: {
          pk: { S: `SAV#${date}` }, sk: { S: `${day.account}#${day.region}#${day.workloadId}` }, data: { S: JSON.stringify(day) },
          expiresAt: { N: String(Math.floor(Date.parse(`${date}T00:00:00.000Z`) / 1000) + historyDays * 86_400) },
        },
      }));
    },
    async listSavingsDay(date: string): Promise<SavingsDay[]> {
      const days: SavingsDay[] = [];
      let start: Item | undefined;
      do {
        const page = await dynamo.send(new QueryCommand({
          TableName: table, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': { S: `SAV#${date}` } }, ...(start ? { ExclusiveStartKey: start } : {}),
        }));
        days.push(...(page.Items ?? []).map((i: Item) => data<SavingsDay>(i)!).filter(Boolean));
        start = page.LastEvaluatedKey;
      } while (start);
      return days;
    },
    async getSavingsSummary(): Promise<SavingsSummary | null> {
      const { Item } = await dynamo.send(new GetItemCommand({ TableName: table, Key: key('SAVINGS') }));
      return data<SavingsSummary>(Item);
    },
    async putSavingsSummary(summary: SavingsSummary): Promise<void> {
      await dynamo.send(new PutItemCommand({ TableName: table, Item: { ...key('SAVINGS'), data: { S: JSON.stringify(summary) } } }));
    },

    // The discounts for commitments (R9.5): 0 and 0 until an administrator sets them.
    async getSavingsSettings(): Promise<SavingsSettings> {
      // Consistent: an administrator's change is seen at once (final review 5).
      const { Item } = await dynamo.send(new GetItemCommand({ TableName: table, Key: key('SAVINGS#SETTINGS'), ConsistentRead: true }));
      const d = data<Discounts>(Item);
      return { compute: d?.compute ?? 0, databases: d?.databases ?? 0, updatedAt: Item?.updatedAt?.S ?? null, updatedBy: Item?.updatedBy?.S ?? null };
    },
    async putSavingsSettings(discounts: Discounts, by: string): Promise<void> {
      await dynamo.send(new PutItemCommand({
        TableName: table, Item: { ...key('SAVINGS#SETTINGS'), data: { S: JSON.stringify({ compute: discounts.compute, databases: discounts.databases }) }, updatedAt: { S: new Date(now()).toISOString() }, updatedBy: { S: by } },
      }));
    },

    // The daily update check: off until an administrator turns it on. Consistent reads: turning it off stops the next run.
    async getUpdateCheck(): Promise<UpdateCheck> {
      const { Item } = await dynamo.send(new GetItemCommand({ TableName: table, Key: key('UPDATE#CHECK'), ConsistentRead: true }));
      const d = data<{ enabled?: boolean; alert?: boolean }>(Item);
      return { enabled: d?.enabled === true, alert: d?.alert === true, ...(Item?.updatedAt?.S ? { updatedAt: Item.updatedAt.S } : {}), ...(Item?.updatedBy?.S ? { updatedBy: Item.updatedBy.S } : {}) };
    },
    async putUpdateCheck(check: UpdateCheck & { updatedBy: string }): Promise<void> {
      await dynamo.send(new PutItemCommand({
        TableName: table, Item: { ...key('UPDATE#CHECK'), data: { S: JSON.stringify({ enabled: check.enabled, alert: check.alert }) }, updatedAt: { S: new Date(now()).toISOString() }, updatedBy: { S: check.updatedBy } },
      }));
    },
    async getUpdateResult(): Promise<UpdateResult | null> {
      const { Item } = await dynamo.send(new GetItemCommand({ TableName: table, Key: key('UPDATE#RESULT'), ConsistentRead: true }));
      return data<UpdateResult>(Item);
    },
    async putUpdateResult(result: UpdateResult): Promise<void> {
      await dynamo.send(new PutItemCommand({ TableName: table, Item: { ...key('UPDATE#RESULT'), data: { S: JSON.stringify(result) } } }));
    },

    // The custom groups' grants (the API caches them 60 s).
    async listGroups(): Promise<Group[]> {
      return (await query('GROUP#')).map(groupOf).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
    async getGroup(name: string): Promise<Group | null> {
      const { Item } = await dynamo.send(new GetItemCommand({ TableName: table, Key: key(`GROUP#${name}`), ConsistentRead: true }));
      return Item ? groupOf(Item) : null;
    },
    async putGroup(group: Pick<Group, 'name' | 'description' | 'grants'> & { updatedBy: string }): Promise<void> {
      await dynamo.send(new PutItemCommand({
        TableName: table, Item: { ...key(`GROUP#${group.name}`), data: { S: JSON.stringify({ description: group.description, grants: group.grants }) }, updatedAt: { S: new Date(now()).toISOString() }, updatedBy: { S: group.updatedBy } },
      }));
    },
    async deleteGroup(name: string): Promise<void> {
      await dynamo.send(new DeleteItemCommand({ TableName: table, Key: key(`GROUP#${name}`) }));
    },

    // AWS list prices (R9), per region and item: 30 days (a Spot price a day, R9.5); the absence of one a day (a new
    // instance type appears).
    async getPrice(priceKey: string): Promise<{ usd: number | null } | null> {
      const { Item } = await dynamo.send(new GetItemCommand({ TableName: table, Key: key(`PRICE#${priceKey}`) }));
      return Item && Number(Item.expiresAt?.N ?? 0) > now() / 1000 ? { usd: Item.usd?.N ? Number(Item.usd.N) : null } : null;
    },
    async putPrice(priceKey: string, usd: number | null, days = 30): Promise<void> {
      await dynamo.send(new PutItemCommand({
        TableName: table, Item: { ...key(`PRICE#${priceKey}`), ...(usd === null ? {} : { usd: { N: String(usd) } }), expiresAt: { N: String(Math.floor(now() / 1000) + (usd === null ? 1 : days) * 86_400) } },
      }));
    },

    // A workload's idle window advice (R10), kept a day: read when its card is, past its expiresAt no more (DynamoDB
    // deletes an expired item within days).
    async getIdleWindow(account: string, region: string, id: string): Promise<IdleWindowAdvice | null> {
      const { Item } = await dynamo.send(new GetItemCommand({ TableName: table, Key: key(`IDLE#${account}#${region}#${id}`) }));
      return Item && Number(Item.expiresAt?.N ?? 0) > now() / 1000 ? data<IdleWindowAdvice>(Item) : null;
    },
    async putIdleWindow(account: string, region: string, id: string, advice: IdleWindowAdvice): Promise<void> {
      await dynamo.send(new PutItemCommand({
        TableName: table, Item: { ...key(`IDLE#${account}#${region}#${id}`), data: { S: JSON.stringify(advice) }, expiresAt: { N: String(Math.floor(now() / 1000) + 86_400) } },
      }));
    },

    // The last entry before a time: the state a period starts in.
    async historyBefore(account: string, region: string, id: string, at: string): Promise<HistoryEntry | null> {
      const { Items = [] } = await dynamo.send(new QueryCommand({
        TableName: table, KeyConditionExpression: 'pk = :pk AND sk < :before', ScanIndexForward: false, Limit: 1,
        ExpressionAttributeValues: { ':pk': historyPk(account, region, id), ':before': { S: at } },
      }));
      return data<HistoryEntry>(Items[0]);
    },
  };
}

export type FleetStore = ReturnType<typeof createFleetStore>;

// A router reports while its last check is at most 3 periods of its schedule old (5 minutes by default).
export function reporting(router: { checkedAt: string | null; checkSchedule: string | null }, now = Date.now()): boolean {
  if (!router.checkedAt) return false;
  return now - Date.parse(router.checkedAt) <= 3 * checkMinutesOf(router.checkSchedule) * 60_000;
}
