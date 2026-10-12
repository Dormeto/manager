// Discovery items of the manager table (spec section 6): configuration, runs, inventory and exclusions in partition
// T#default; candidates in the partition of their account (CAND#<account>), indexed by status on gsi1 (scale design §4).
import { BatchGetItemCommand, BatchWriteItemCommand, DeleteItemCommand, GetItemCommand, PutItemCommand, QueryCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { gunzipSync, gzipSync } from 'node:zlib';
import { CANDIDATE_STATUSES, type AccountScan, type Candidate, type DiscoveryConfig, type Exclusion, type OrgInventory, type RunRecord, type Status } from './types.js';

const PK = 'T#default';
const RETENTION_S = 90 * 86_400;
const LOCK_MS = 15 * 60_000;
// An expired exclusion stays listed (shown as expired) for 30 days.
const EXPIRED_EXCLUSION_S = 30 * 86_400;
// Writes of an item of several writers (an exclusion, the counts) tried before giving up, when others keep changing it.
const VERSIONED_WRITES = 5;
const COUNTS = 'DISC#COUNTS';
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
  getRun(startedAt: string): Promise<RunRecord | null>;
  putRun(run: RunRecord): Promise<void>;
  listCandidates(): Promise<Candidate[]>;
  // A page of the candidates of a status, in account, region and id order; within an account, or an account and region.
  pageCandidates(page: { status: Status; limit: number; cursor?: string; account?: string; region?: string }): Promise<{ candidates: Candidate[]; cursor: string | null }>;
  // Candidates changed between runs (dismissals, exclusions, operations): written, and the counts moved by their status.
  replaceCandidates(after: Candidate[], before: Candidate[]): Promise<void>;
  // Candidates per status: set by each run, moved by each change between runs (scale design §5).
  getCounts(): Promise<{ counts: Partial<Record<Status, number>>; at: string } | null>;
  putCounts(counts: Partial<Record<Status, number>>): Promise<void>;
  accountCandidates(account: string): Promise<Candidate[]>;
  getCandidate(id: string): Promise<Candidate | null>;
  putCandidates(candidates: Candidate[]): Promise<void>;
  deleteCandidates(candidates: Pick<Candidate, 'id' | 'account' | 'region'>[]): Promise<void>;
  getAccountScan(account: string): Promise<AccountScan | null>;
  putAccountScan(scan: AccountScan): Promise<void>;
  deleteAccountScan(account: string): Promise<void>;
  listAccountScans(): Promise<AccountScan[]>;
  // The scan states of these accounts, read by key and consistent (a run's results, right after its last account).
  getAccountScans(accounts: string[]): Promise<AccountScan[]>;
  countCandidates(): Promise<Partial<Record<Status, number>>>;
  getInventory(): Promise<OrgInventory | null>;
  putInventory(inventory: OrgInventory): Promise<void>;
  listExclusions(): Promise<Exclusion[]>;
  getExclusion(id: string): Promise<Exclusion | null>;
  putExclusion(exclusion: Exclusion): Promise<void>;
  // Read, change and write back, again on the newer version when another writer changed it in between; null when gone.
  updateExclusion(id: string, change: (exclusion: Exclusion) => Exclusion | Promise<Exclusion>): Promise<Exclusion | null>;
  deleteExclusion(id: string): Promise<void>;
}

// Any DynamoDB client: only send() is used.
export interface DynamoSender {
  send(command: object): Promise<any>;
}

const seconds = (ms: number) => Math.floor(ms / 1000);

// Candidate ids are load balancer ARNs (target group or rule): arn:<partition>:elasticloadbalancing:<region>:<account>:...
const locate = (id: string) => {
  const [, , , region, account] = id.split(':');
  return { account: account ?? '', region: region ?? '' };
};
const candidateKey = (account: string, region: string, id: string) => ({ pk: { S: `CAND#${account}` }, sk: { S: `${region}#${id}` } });
const ACCOUNT_SCAN = '#ACCOUNT';

export class InvalidCursor extends Error {
  constructor() {
    super('invalid cursor');
    this.name = 'InvalidCursor';
  }
}
// A page position as the API hands it out: the index key, base64url JSON.
const encodeCursor = (key: Item | undefined) => (key ? Buffer.from(JSON.stringify(key)).toString('base64url') : null);
function decodeCursor(cursor: string | undefined, status: string): Item | undefined {
  if (!cursor) return undefined;
  try {
    const key = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Item;
    if (key.gsi1pk?.S !== `CS#${status}` || !key.pk?.S?.startsWith('CAND#') || !key.sk?.S || !key.gsi1sk?.S) throw new InvalidCursor();
    return key;
  } catch {
    throw new InvalidCursor();
  }
}

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
  const countsItem = (value: { counts: Partial<Record<Status, number>>; at: string }, version: number): Item => ({ ...key(COUNTS), data: { S: JSON.stringify(value) }, version: { N: String(version) } });

  // Read, change and write back an item of several writers, again on the newer version when another one changed it in
  // between; null (nothing written) when there is no such item.
  async function updateVersioned<T>(sk: string, toItem: (value: T, version: number) => Item, change: (value: T) => T | Promise<T>): Promise<T | null> {
    for (let attempt = 1; ; attempt += 1) {
      const item = await get(sk);
      const current = data<T>(item);
      if (!current) return null;
      const version = item!.version?.N ?? '0';
      const next = await change(structuredClone(current));
      try {
        await dynamo.send(new PutItemCommand({
          TableName: table, Item: toItem(next, Number(version) + 1),
          ConditionExpression: 'attribute_exists(sk) AND (attribute_not_exists(version) OR version = :version)',
          ExpressionAttributeValues: { ':version': { N: version } },
        }));
        return next;
      } catch (err) {
        if ((err as Error).name !== 'ConditionalCheckFailedException' || attempt >= VERSIONED_WRITES) throw err;
      }
    }
  }

  const exclusionItem = (exclusion: Exclusion, version: number): Item => ({
    ...key(`EXCL#${exclusion.id}`),
    data: { S: JSON.stringify(exclusion) },
    version: { N: String(version) },
    ...(exclusion.expiresAt ? { expiresAt: { N: String(seconds(Date.parse(exclusion.expiresAt)) + EXPIRED_EXCLUSION_S) } } : {}),
  });

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

  // Every page of a query (base table or gsi1).
  async function queryAll(input: Record<string, unknown>): Promise<Item[]> {
    const items: Item[] = [];
    let start: Item | undefined;
    do {
      const page = await dynamo.send(new QueryCommand({ TableName: table, ...input, ...(start ? { ExclusiveStartKey: start } : {}) }));
      items.push(...(page.Items ?? []));
      start = page.LastEvaluatedKey;
    } while (start);
    return items;
  }

  const candidateItem = (c: Candidate): Item => ({
    ...candidateKey(c.account, c.region, c.id),
    gsi1pk: { S: `CS#${c.status}` },
    gsi1sk: { S: `${c.account}#${c.region}#${c.id}` },
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
    async getRun(startedAt) {
      return data<RunRecord>(await get(`DISC#RUN#${startedAt}`));
    },
    async putRun(run) {
      await put({ ...key(`DISC#RUN#${run.startedAt}`), status: { S: run.status }, data: packed(run), expiresAt: { N: String(seconds(Date.parse(run.startedAt)) + RETENTION_S) } });
    },
    // Every candidate, status by status (each candidate has one).
    async listCandidates() {
      const items = (await Promise.all(CANDIDATE_STATUSES.map((status) => queryAll({
        IndexName: 'gsi1', KeyConditionExpression: 'gsi1pk = :pk', ExpressionAttributeValues: { ':pk': { S: `CS#${status}` } },
      })))).flat();
      return items.map((item) => data<Candidate>(item)!).filter(Boolean);
    },
    async pageCandidates({ status, limit, cursor, account, region }) {
      const prefix = account ? `${account}#${region ? `${region}#` : ''}` : '';
      const page = await dynamo.send(new QueryCommand({
        TableName: table, IndexName: 'gsi1',
        KeyConditionExpression: prefix ? 'gsi1pk = :pk AND begins_with(gsi1sk, :prefix)' : 'gsi1pk = :pk',
        ExpressionAttributeValues: { ':pk': { S: `CS#${status}` }, ...(prefix ? { ':prefix': { S: prefix } } : {}) },
        Limit: limit, ...(cursor ? { ExclusiveStartKey: decodeCursor(cursor, status) } : {}),
      }));
      return { candidates: ((page.Items ?? []) as Item[]).map((item) => data<Candidate>(item)!).filter(Boolean), cursor: encodeCursor(page.LastEvaluatedKey) };
    },
    async accountCandidates(account) {
      const items = await queryAll({ KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': { S: `CAND#${account}` } } });
      return items.filter((item) => item.sk?.S !== ACCOUNT_SCAN).map((item) => data<Candidate>(item)!).filter(Boolean);
    },
    async getCandidate(id) {
      const { account, region } = locate(id);
      const out = await dynamo.send(new GetItemCommand({ TableName: table, Key: candidateKey(account, region, id), ConsistentRead: true }));
      return data<Candidate>(out.Item);
    },
    async putCandidates(candidates) {
      await batchWrite(candidates.map((c) => ({ PutRequest: { Item: candidateItem(c) } })));
    },
    async replaceCandidates(after, before) {
      await batchWrite(after.map((c) => ({ PutRequest: { Item: candidateItem(c) } })));
      const was = new Map(before.map((c) => [c.id, c.status]));
      const moves: Partial<Record<Status, number>> = {};
      for (const c of after) {
        const from = was.get(c.id);
        if (from === c.status) continue;
        if (from) moves[from] = (moves[from] ?? 0) - 1;
        moves[c.status] = (moves[c.status] ?? 0) + 1;
      }
      if (!Object.keys(moves).length) return;
      await updateVersioned<{ counts: Partial<Record<Status, number>>; at: string }>(COUNTS, countsItem, ({ counts, at }) => {
        const next = { ...counts };
        for (const [status, n] of Object.entries(moves) as [Status, number][]) {
          next[status] = Math.max(0, (next[status] ?? 0) + n);
          if (!next[status]) delete next[status];
        }
        return { counts: next, at };
      });
    },
    async getCounts() {
      return data<{ counts: Partial<Record<Status, number>>; at: string }>(await get(COUNTS));
    },
    async putCounts(counts) {
      await put(countsItem({ counts, at: new Date(now()).toISOString() }, 1));
    },
    async deleteCandidates(candidates) {
      await batchWrite(candidates.map((c) => ({ DeleteRequest: { Key: candidateKey(c.account, c.region, c.id) } })));
    },
    async getAccountScan(account) {
      const out = await dynamo.send(new GetItemCommand({ TableName: table, Key: { pk: { S: `CAND#${account}` }, sk: { S: ACCOUNT_SCAN } }, ConsistentRead: true }));
      return data<AccountScan>(out.Item);
    },
    // Indexed (gsi1 ACCT): the run's finalize step reads every account's result.
    async putAccountScan(scan) {
      await put({ pk: { S: `CAND#${scan.account}` }, sk: { S: ACCOUNT_SCAN }, gsi1pk: { S: 'ACCT' }, gsi1sk: { S: scan.account }, data: { S: JSON.stringify(scan) } });
    },
    async deleteAccountScan(account) {
      await dynamo.send(new DeleteItemCommand({ TableName: table, Key: { pk: { S: `CAND#${account}` }, sk: { S: ACCOUNT_SCAN } } }));
    },
    async getAccountScans(accounts) {
      const found: AccountScan[] = [];
      for (let i = 0; i < accounts.length; i += 100) {
        let keys: Item[] = accounts.slice(i, i + 100).map((account) => ({ pk: { S: `CAND#${account}` }, sk: { S: ACCOUNT_SCAN } }));
        for (let attempt = 0; keys.length; attempt += 1) {
          if (attempt >= 5) throw new Error(`account scans unread after ${attempt} attempts`);
          const out = await dynamo.send(new BatchGetItemCommand({ RequestItems: { [table]: { Keys: keys, ConsistentRead: true } } }));
          found.push(...((out.Responses?.[table] ?? []) as Item[]).map((item) => data<AccountScan>(item)!).filter(Boolean));
          keys = (out.UnprocessedKeys?.[table]?.Keys ?? []) as Item[];
        }
      }
      return found;
    },
    async listAccountScans() {
      const items = await queryAll({ IndexName: 'gsi1', KeyConditionExpression: 'gsi1pk = :pk', ExpressionAttributeValues: { ':pk': { S: 'ACCT' } } });
      return items.map((item) => data<AccountScan>(item)!).filter(Boolean);
    },
    // Candidates per status, counted on the index (no item read back).
    async countCandidates() {
      const counts: Partial<Record<Status, number>> = {};
      await Promise.all(CANDIDATE_STATUSES.map(async (status) => {
        let n = 0;
        let start: Item | undefined;
        do {
          const page = await dynamo.send(new QueryCommand({
            TableName: table, IndexName: 'gsi1', KeyConditionExpression: 'gsi1pk = :pk', ExpressionAttributeValues: { ':pk': { S: `CS#${status}` } }, Select: 'COUNT',
            ...(start ? { ExclusiveStartKey: start } : {}),
          }));
          n += page.Count ?? 0;
          start = page.LastEvaluatedKey;
        } while (start);
        if (n) counts[status] = n;
      }));
      return Object.fromEntries(CANDIDATE_STATUSES.filter((st) => counts[st]).map((st) => [st, counts[st]!])) as Partial<Record<Status, number>>;
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
      await put(exclusionItem(exclusion, 1));
    },
    // The API, the workflow and expiry write the same exclusion: each write is conditional on the version it read.
    async updateExclusion(id, change) {
      return updateVersioned<Exclusion>(`EXCL#${id}`, exclusionItem, change);
    },
    async deleteExclusion(id) {
      await dynamo.send(new DeleteItemCommand({ TableName: table, Key: key(`EXCL#${id}`) }));
    },
  };
}
