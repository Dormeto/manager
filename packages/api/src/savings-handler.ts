// Lambda entry point of the daily savings job (R9b), run at 00:30 UTC by EventBridge Scheduler, or by hand with
// { "day": "YYYY-MM-DD" }: AWS SDK v3 clients provided by the nodejs24.x runtime (not bundled).
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetProductsCommand, PricingClient, type GetProductsCommandInput } from '@aws-sdk/client-pricing';
import { createFleetStore, createPriceBook } from '@dormeto/fleet';
import { baselineOf } from './baseline.js';
import { createSavingsJob } from './savings-job.js';

const log = (level: string) => (event: string, data: object = {}) => console.log(JSON.stringify({ level, event, ...data }));
const fleet = createFleetStore({ dynamo: new DynamoDBClient({}), table: process.env.TABLE ?? '', historyDays: Number(process.env.HISTORY_DAYS) || 400 });
// The Price List API answers in us-east-1, for every region.
const pricing = new PricingClient({ region: 'us-east-1' });
const prices = createPriceBook({ pricing: { getProducts: (input) => pricing.send(new GetProductsCommand(input as GetProductsCommandInput)) }, store: fleet });
const job = createSavingsJob({
  fleet, prices, baseline: baselineOf(process.env.SAVINGS_BASELINE, process.env.SAVINGS_TIMEZONE),
  log: { info: log('info'), warn: log('warn'), error: log('error') },
});

export const handler = async (event: { day?: string } = {}) => job.run({ day: event?.day });
