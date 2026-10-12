// Router events queue → summaries (vision scale design §4).
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { createIngest, processRecords } from './ingest.js';
import { createFleetStore } from './store.js';

// HISTORY_DAYS: how long the state history is kept (R8, the manager module's history_days).
const store = createFleetStore({ dynamo: new DynamoDBClient({}), table: process.env.TABLE ?? '', historyDays: Number(process.env.HISTORY_DAYS) || 400 });
const log = { warn: (event: string, data: object) => console.log(JSON.stringify({ level: 'warn', event, ...data })) };
const ingest = createIngest({ store, log });

export const handler = async (event: { Records?: { messageId: string; body: string }[] }) => processRecords(event.Records ?? [], ingest, log);
