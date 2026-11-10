// Lambda entry point of the daily savings job (R9b), run at 00:30 UTC by EventBridge Scheduler, or by hand with
// { "day": "YYYY-MM-DD" }: AWS SDK v3 clients provided by the nodejs24.x runtime (not bundled).
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { GetProductsCommand, PricingClient, type GetProductsCommandInput } from '@aws-sdk/client-pricing';
import { createFleetStore, createPriceBook } from '@dormeto/fleet';
import { catalogPort, createGoogle, createGoogleSource, type GoogleConnection } from '@dormeto/google';
import { baselineOf } from './baseline.js';
import { createSpotPort } from './spot.js';
import { createSavingsJob } from './savings-job.js';

const log = (level: string) => (event: string, data: object = {}) => console.log(JSON.stringify({ level, event, ...data }));
const dynamo = new DynamoDBClient({});
const table = process.env.TABLE ?? '';
const fleet = createFleetStore({ dynamo, table, historyDays: Number(process.env.HISTORY_DAYS) || 400 });
// The Price List API answers in us-east-1, for every region.
const pricing = new PricingClient({ region: 'us-east-1' });
// The Google Cloud connection (`DISC#GOOGLE`, as the API reads it): Google's list prices come from the Cloud Billing Catalog,
// read as the discovery account, here and never in the API (a request would wait for 45 MB of SKUs).
const googleSource = createGoogleSource({
  async read() {
    const item = (await dynamo.send(new GetItemCommand({ TableName: table, Key: { pk: { S: 'T#default' }, sk: { S: 'DISC#GOOGLE' } }, ConsistentRead: true }))).Item;
    return item?.data?.S ? (JSON.parse(item.data.S) as GoogleConnection) : null;
  },
  create: (connection) => createGoogle({ connection }),
});
// Spot prices from the manager's account, in each workload's region (R9.5). Each Google Cloud service's Catalog read is said once.
const prices = createPriceBook({
  pricing: { getProducts: (input) => pricing.send(new GetProductsCommand(input as GetProductsCommandInput)) }, spot: createSpotPort(), store: fleet,
  catalog: catalogPort(googleSource), onCatalogRead: (read) => log('info')('GooglePricesRead', read),
});
const job = createSavingsJob({
  fleet, prices, baseline: baselineOf(process.env.SAVINGS_BASELINE, process.env.SAVINGS_TIMEZONE),
  log: { info: log('info'), warn: log('warn'), error: log('error') },
});

export const handler = async (event: { day?: string } = {}) => job.run({ day: event?.day });
