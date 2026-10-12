// Router events queue → summaries (vision scale design §4).
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { createIngest, processRecords } from './ingest.js';
import { createFleetStore } from './store.js';

const store = createFleetStore({ dynamo: new DynamoDBClient({}), table: process.env.TABLE ?? '' });
const ingest = createIngest({ store });
const log = { warn: (event: string, data: object) => console.log(JSON.stringify({ level: 'warn', event, ...data })) };

export const handler = async (event: { Records?: { messageId: string; body: string }[] }) => processRecords(event.Records ?? [], ingest, log);
