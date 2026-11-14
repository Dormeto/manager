// Router events queue → summaries (vision scale design §4): an AWS router's events (`dormeto.router`), and a Google Cloud
// router's as the manager's API relays them (`dormeto.router.gcp`, router push design §3.2), with the settings pushed to
// a router whose check says it is behind (§6.2). At each watchdog run, the probe of the Google Cloud routers that are silent
// or never reported (§6.3, §6.4): the watchdog invokes the function with `{ task: 'probe' }` and waits for its answer.
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { createGoogle, createGoogleSource, type GoogleConnection } from '@dormeto/google';
import { bySource, createGoogleReports, createSettingsPush } from './google-report.js';
import { createIngest, processRecords } from './ingest.js';
import { createProbe } from './probe.js';
import { createRegistry } from './registry.js';
import { createSettingsJson, S3_OPTIONS } from './settings-json.js';
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

// The Google Cloud connection (`DISC#GOOGLE`, written by `dormeto gcp connect`), read at each probe and settings push; one
// Google instance per execution environment keeps its tokens between invocations.
const googleSource = createGoogleSource({
  async read() {
    const item = (await dynamo.send(new GetItemCommand({ TableName: table, Key: { pk: { S: 'T#default' }, sk: { S: 'DISC#GOOGLE' } }, ConsistentRead: true }))).Item;
    return item?.data?.S ? (JSON.parse(item.data.S) as GoogleConnection) : null;
  },
  create: (connection) => createGoogle({ connection }),
});

// The organization's settings.json in the lists bucket, read at most once a probe, and by the push after a check.
const settings = createSettingsJson({ s3: new S3Client(S3_OPTIONS), bucket: process.env.LISTS_BUCKET });
const registry = createRegistry({ dynamo, table });
// Where a Google Cloud router reports (the relay's route and its token's audience), sent with the settings it is pushed.
const events = process.env.EVENTS_URL && process.env.EVENTS_AUDIENCE ? { url: process.env.EVENTS_URL, audience: process.env.EVENTS_AUDIENCE } : undefined;
const env = process.env.ENV ?? 'dev';

const probe = createProbe({ store, registry, google: googleSource, settings, env, routerVersion: process.env.ROUTER_VERSION, events, log });

// The relay's events, from the manager's own account only (MANAGER_ACCOUNT).
const reports = createGoogleReports({
  ownAccount: process.env.MANAGER_ACCOUNT, ingest, log,
  push: createSettingsPush({ settings, registry, google: googleSource, events, env, routerVersion: process.env.ROUTER_VERSION, log }),
});
const route = bySource({ ingest, reports });

export const handler = async (event: { task?: string; Records?: { messageId: string; body: string }[] }) =>
  (event.task === 'probe' ? probe() : processRecords(event.Records ?? [], route, log));
