// Discovery items of the manager table (spec section 6), partition T#default.
import { BatchWriteItemCommand, DeleteItemCommand, GetItemCommand, PutItemCommand, QueryCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Candidate, DiscoveryConfig, Exclusion, OrgInventory, RunRecord } from './types.js';

const PK = 'T#default';
const RETENTION_S = 90 * 86_400;
const LOCK_MS = 15 * 60_000;
// An expired exclusion stays listed (shown as expired) for 30 days.
const EXPIRED_EXCLUSION_S = 30 * 86_400;
type Item = Record<string, AttributeValue>;

export interface StoredConfig {
  config: DiscoveryConfig;
  updatedAt: string;
  updatedBy: string;
}

export interface DiscoveryStore {
  getConfig(): Promise<StoredConfig | null>;
  putConfig(config: DiscoveryConfig, by: string): Promise<void>;
  acquireLock(runId: string): Promise<boolean>;
  releaseLock(runId: string): Promise<void>;
  lastRun(options?: { completed?: boolean }): Promise<RunRecord | null>;
  putRun(run: RunRecord): Promise<void>;
  listCandidates(): Promise<Candidate[]>;
  getCandidate(id: string): Promise<Candidate | null>;
  putCandidates(candidates: Candidate[]): Promise<void>;
  deleteCandidates(ids: string[]): Promise<void>;
  getInventory(): Promise<OrgInventory | null>;
  putInventory(inventory: OrgInventory): Promise<void>;
  listExclusions(): Promise<Exclusion[]>;
  getExclusion(id: string): Promise<Exclusion | null>;
  putExclusion(exclusion: Exclusion): Promise<void>;
  deleteExclusion(id: string): Promise<void>;
}

// Any DynamoDB client: only send() is used.
export interface DynamoSender {
  send(command: object): Promise<any>;
}

const seconds = (ms: number) => Math.floor(ms / 1000);

export function createStore({ dynamo, table, now = Date.now, lockMs = LOCK_MS }: { dynamo: DynamoSender; table: string; now?: () => number; lockMs?: number }): DiscoveryStore {
  const key = (sk: string) => ({ pk: { S: PK }, sk: { S: sk } });
  const get = async (sk: string): Promise<Item | undefined> => (await dynamo.send(new GetItemCommand({ TableName: table, Key: key(sk), ConsistentRead: true }))).Item;
  const put = (item: Item) => dynamo.send(new PutItemCommand({ TableName: table, Item: item }));
  // Runs and the inventory grow with the organization: stored gzipped (binary) to stay far below the 400 KB item limit.
  const data = <T>(item: Item | undefined): T | null => {
    if (item?.data?.B) return JSON.parse(gunzipSync(item.data.B).toString('utf8')) as T;
    return item?.data?.S ? (JSON.parse(item.data.S) as T) : null;
  };
  const packed = (value: unknown): AttributeValue => ({ B: gzipSync(JSON.stringify(value)) });

  async function query(prefix: string, { forward = true, limit }: { forward?: boolean; limit?: number } = {}, stop?: (items: Item[]) => boolean): Promise<Item[]> {
    const items: Item[] = [];
    let start: Item | undefined;
    do {
      const page = await dynamo.send(new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': { S: PK }, ':prefix': { S: prefix } },
        ScanIndexForward: forward,
        ...(limit ? { Limit: limit } : {}),
        ...(start ? { ExclusiveStartKey: start } : {}),
      }));
      items.push(...(page.Items ?? []));
      start = page.LastEvaluatedKey;
    } while (start && !stop?.(items));
    return items;
  }

  // BatchWriteItem by 25, retrying unprocessed requests with a backoff.
  async function batchWrite(all: object[]): Promise<void> {
    for (let i = 0; i < all.length; i += 25) {
      let requests = all.slice(i, i + 25);
      for (let attempt = 0; requests.length; attempt += 1) {
        if (attempt > 5) throw new Error(`${requests.length} discovery items not written`);
        const { UnprocessedItems } = await dynamo.send(new BatchWriteItemCommand({ RequestItems: { [table]: requests as never } }));
        requests = (UnprocessedItems?.[table] ?? []) as object[];
        if (requests.length) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
      }
    }
  }

  const candidateItem = (c: Candidate): Item => ({
    ...key(`DISC#C#${c.id}`),
    status: { S: c.status },
    data: { S: JSON.stringify(c) },
    ...(c.goneAt ? { expiresAt: { N: String(seconds(Date.parse(c.goneAt)) + RETENTION_S) } } : {}),
  });

  return {
    async getConfig() {
      const item = await get('DISC#CONFIG');
      const config = data<DiscoveryConfig>(item);
      return config ? { config, updatedAt: item!.updatedAt?.S ?? '', updatedBy: item!.updatedBy?.S ?? '' } : null;
    },
    async putConfig(config, by) {
      await put({ ...key('DISC#CONFIG'), data: { S: JSON.stringify(config) }, updatedAt: { S: new Date(now()).toISOString() }, updatedBy: { S: by } });
    },
    async acquireLock(runId) {
      try {
        await dynamo.send(new PutItemCommand({
          TableName: table,
          Item: { ...key('DISC#LOCK'), runId: { S: runId }, expiresAt: { N: String(seconds(now() + lockMs)) } },
          ConditionExpression: 'attribute_not_exists(sk) OR expiresAt < :now',
          ExpressionAttributeValues: { ':now': { N: String(seconds(now())) } },
        }));
        return true;
      } catch (err) {
        if ((err as Error).name === 'ConditionalCheckFailedException') return false;
        throw err;
      }
    },
    async releaseLock(runId) {
      try {
        await dynamo.send(new DeleteItemCommand({ TableName: table, Key: key('DISC#LOCK'), ConditionExpression: 'runId = :id', ExpressionAttributeValues: { ':id': { S: runId } } }));
      } catch (err) {
        if ((err as Error).name !== 'ConditionalCheckFailedException') throw err;
      }
    },
    async lastRun({ completed = false } = {}) {
      const keep = (item: Item) => !completed || item.status?.S !== 'skipped';
      const items = await query('DISC#RUN#', { forward: false, limit: 20 }, (found) => found.some(keep));
      return data<RunRecord>(items.find(keep));
    },
    async putRun(run) {
      await put({ ...key(`DISC#RUN#${run.startedAt}`), status: { S: run.status }, data: packed(run), expiresAt: { N: String(seconds(Date.parse(run.startedAt)) + RETENTION_S) } });
    },
    async listCandidates() {
      return (await query('DISC#C#')).map((item) => data<Candidate>(item)!).filter(Boolean);
    },
    async getCandidate(id) {
      return data<Candidate>(await get(`DISC#C#${id}`));
    },
    async putCandidates(candidates) {
      await batchWrite(candidates.map((c) => ({ PutRequest: { Item: candidateItem(c) } })));
    },
    async deleteCandidates(ids) {
      await batchWrite(ids.map((id) => ({ DeleteRequest: { Key: key(`DISC#C#${id}`) } })));
    },
    async getInventory() {
      return data<OrgInventory>(await get('DISC#ORG'));
    },
    async putInventory(inventory) {
      await put({ ...key('DISC#ORG'), data: packed(inventory), updatedAt: { S: new Date(now()).toISOString() } });
    },
    async listExclusions() {
      return (await query('EXCL#')).map((item) => data<Exclusion>(item)!).filter(Boolean);
    },
    async getExclusion(id) {
      return data<Exclusion>(await get(`EXCL#${id}`));
    },
    async putExclusion(exclusion) {
      await put({
        ...key(`EXCL#${exclusion.id}`),
        data: { S: JSON.stringify(exclusion) },
        ...(exclusion.expiresAt ? { expiresAt: { N: String(seconds(Date.parse(exclusion.expiresAt)) + EXPIRED_EXCLUSION_S) } } : {}),
      });
    },
    async deleteExclusion(id) {
      await dynamo.send(new DeleteItemCommand({ TableName: table, Key: key(`EXCL#${id}`) }));
    },
  };
}
