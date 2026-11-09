// Router events queue → summaries (vision scale design §4), and every minute the poll of the Google Cloud routers, which
// push nothing (Google Cloud manager design §6.3): the schedule invokes the function with `{ task: 'poll' }`.
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createGoogle, createGoogleSource, type GoogleConnection } from '@dormeto/google';
import { createIngest, processRecords } from './ingest.js';
import { createPoll } from './poll.js';
import { createRegistry } from './registry.js';
import { createFleetStore } from './store.js';

const table = process.env.TABLE ?? '';
const dynamo = new DynamoDBClient({});
// HISTORY_DAYS: how long the state history is kept (R8, the manager module's history_days).
const store = createFleetStore({ dynamo, table, historyDays: Number(process.env.HISTORY_DAYS) || 400 });
const log = {
  info: (event: string, data: object) => console.log(JSON.stringify({ level: 'info', event, ...data })),
  warn: (event: string, data: object) => console.log(JSON.stringify({ level: 'warn', event, ...data })),
};
const ingest = createIngest({ store, log });

// The Google Cloud connection (`DISC#GOOGLE`, written by `dormeto gcp connect`), read at each poll; one Google instance per
// execution environment keeps its tokens between invocations.
const googleSource = createGoogleSource({
  async read() {
    const item = (await dynamo.send(new GetItemCommand({ TableName: table, Key: { pk: { S: 'T#default' }, sk: { S: 'DISC#GOOGLE' } }, ConsistentRead: true }))).Item;
    return item?.data?.S ? (JSON.parse(item.data.S) as GoogleConnection) : null;
  },
  create: (connection) => createGoogle({ connection }),
});

// The organization's settings.json in the lists bucket (written by the API), with its ETag as S3 gives it: read at most
// once a run by the poll. 3 s to connect, 10 s of silence.
const s3 = new S3Client({ maxAttempts: 2, requestHandler: { connectionTimeout: 3_000, requestTimeout: 10_000 } });
const bucket = process.env.LISTS_BUCKET;
const SETTINGS = 'settings.json';
const absent = (err: unknown) => ['NotFound', 'NoSuchKey'].includes((err as Error).name);
const settings = {
  async etag() {
    if (!bucket) return null;
    try {
      return (await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: SETTINGS }))).ETag ?? null;
    } catch (err) {
      if (absent(err)) return null;
      throw err;
    }
  },
  async read() {
    if (!bucket) return null;
    try {
      const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: SETTINGS }));
      return { etag: out.ETag ?? '', text: await out.Body!.transformToString() };
    } catch (err) {
      if (absent(err)) return null;
      throw err;
    }
  },
};

const poll = createPoll({
  store, ingest, registry: createRegistry({ dynamo, table }), google: googleSource, settings, env: process.env.ENV ?? 'dev', routerVersion: process.env.ROUTER_VERSION, log,
});

export const handler = async (event: { task?: string; Records?: { messageId: string; body: string }[] }) =>
  (event.task === 'poll' ? poll() : processRecords(event.Records ?? [], ingest, log));
