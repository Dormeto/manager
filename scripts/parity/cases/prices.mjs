// The product's prices (fleet src/prices.ts, src/savings.ts, api src/spot.ts): the price book over recorded Price List
// and Spot price history answers, the baseline's hours and a period's savings; the cases of fleet test/prices.test.ts
// and test/savings.test.ts, and the edge cases of the spec's §6 (nothing priced, Spot, discounts, business hours).
import { error, filtersOf, product } from './aws.mjs';
import { pricesOf } from './replay.mjs';

export const name = 'prices';

const HOUR = 3_600_000;
const NONE = { compute: 0, databases: 0 };
const EU = 'eu-west-1';
const T3 = { kind: 'ec2', type: 't3.medium', count: 1, os: 'Linux' };
const DB = { kind: 'rds', class: 'db.t4g.micro', engine: 'postgres', multiAz: false };
const PARIS = { kind: 'business-hours', timeZone: 'Europe/Paris' };
const FARGATE_PRICES = { 'Fargate-vCPU-Hours:perCPU': '0.0404800000', 'Fargate-GB-Hours': '0.0044450000', 'Fargate-ARM-vCPU-Hours:perCPU': '0.0323800000', 'Fargate-ARM-GB-Hours': '0.0035600000' };
const fargate = { kind: 'fargate', vcpu: 0.5, memoryGb: 1, count: 2, arch: 'x86_64', os: 'Linux' };
const pods = { kind: 'k8s-pods', count: 2, cpu: 0.5, memoryGb: 1, nodeType: 'm5.large', os: 'Linux', autoscaled: true, allocatable: { cpu: 1.93, memoryGb: 6.886 } };

// The Price List answering by its filters (as prices.test.ts's setup), Spot price history by region and input.
const model = (answers, spot = () => []) => (call, input) => {
  if (call === 'pricing.getProducts') return { PriceList: answers(filtersOf(input)) };
  if (call === 'spot.history') return { SpotPriceHistory: spot(input.region, input.input) };
  return undefined;
};
const FARGATE = (f) => (f.ServiceCode === 'AmazonECS' && FARGATE_PRICES[f['~usagetype']] ? [product({ usagetype: `EU-${f['~usagetype']}` }, FARGATE_PRICES[f['~usagetype']], 'hours')] : []);
const M5 = (f) => (f.ServiceCode === 'AmazonEC2' && f.instanceType === 'm5.large' && f.operatingSystem === 'Linux' ? [product({}, '0.1070000000')] : []);

export function cases(now) {
  const T = Date.parse(now);
  const at = (ms) => new Date(T + ms).toISOString();
  const hourly = (title, lookups, answers, { spot, cache = {} } = {}) => ({
    name: `hourly: ${title}`,
    input: { function: 'hourly', now, cache, lookups: lookups.map(([item, discounts = NONE, region = EU]) => ({ region, item, discounts })) },
    model: model(answers, spot),
  });
  return [
    hourly('EC2 by type, region and OS, times the count; asked once, then from the book', [[{ ...T3, count: 2 }], [T3]],
      (f) => (f.ServiceCode === 'AmazonEC2' && f.instanceType === 't3.medium' && f.regionCode === EU && f.operatingSystem === 'Linux' ? [product({ instanceType: 't3.medium' }, '0.0456000000')] : [])),
    hourly('Fargate by vCPU and GB hours, x86 or ARM, times the count', [[fargate], [{ kind: 'fargate', vcpu: 1, memoryGb: 2, count: 1, arch: 'arm64', os: 'Linux' }]], FARGATE),
    hourly('RDS by class, engine and deployment, Aurora Serverless v2 by ACU', [[DB], [{ ...DB, multiAz: true }], [{ kind: 'aurora-serverless', engine: 'aurora-mysql', acu: 0.5 }]], (f) => {
      if (f.ServiceCode !== 'AmazonRDS') return [];
      if (f['~usagetype'] === 'Aurora:ServerlessV2Usage' && f.databaseEngine === 'Aurora MySQL') return [product({}, '0.1400000000', 'ACU-Hr')];
      if (f.instanceType === 'db.t4g.micro' && f.databaseEngine === 'PostgreSQL') return [product({}, f.deploymentOption === 'Multi-AZ' ? '0.0350000000' : '0.0170000000')];
      return [];
    }),
    hourly('nothing priced: another OS, Oracle, an unknown item, a type the API does not return (cached as such)', [
      [{ kind: 'ec2', type: 'm5.large', count: 1, os: 'Red Hat Enterprise Linux' }], [{ kind: 'rds', class: 'db.m5.large', engine: 'oracle-ee', multiAz: false }],
      [{ kind: 'unknown', backend: 'ecs:x', reason: 'denied' }], [{ kind: 'ec2', type: 'x9.huge', count: 1, os: 'Linux' }], [{ kind: 'ec2', type: 'x9.huge', count: 1, os: 'Linux' }],
    ], () => []),
    hourly('a throttled API prices nothing for that item, without caching it', [[T3]], () => { throw error('ThrottlingException', 'Rate exceeded'); }),
    hourly('several products of different prices are no price; of one price, that price', [[{ kind: 'rds', class: 'db.r6g.large', engine: 'aurora-postgresql', multiAz: false }], [T3]],
      (f) => (f.ServiceCode === 'AmazonRDS' ? [product({}, '0.2900000000'), product({}, '0.3770000000')] : [product({}, '0.0456000000'), product({}, '0.0456000000')])),
    hourly('Multi-AZ RDS asked by its usage type', [[{ ...DB, multiAz: true }]], () => [product({}, '0.0350000000')]),
    hourly('Spot: the latest price of each zone averaged, times the count; cached a day', [[{ ...T3, count: 2, spot: true }]], () => [], {
      spot: () => [
        { AvailabilityZone: 'eu-west-1a', SpotPrice: '0.020000', Timestamp: at(-HOUR) },
        { AvailabilityZone: 'eu-west-1a', SpotPrice: '0.030000', Timestamp: at(-3 * HOUR) },
        { AvailabilityZone: 'eu-west-1b', SpotPrice: '0.018000', Timestamp: at(-2 * HOUR) },
      ],
    }),
    hourly('Spot: Windows asked as Windows; another OS, or no answer, is no Spot price (none cached a day)', [
      [{ kind: 'ec2', type: 'm5.large', count: 1, os: 'Windows', spot: true }], [{ kind: 'ec2', type: 'm5.large', count: 1, os: 'Red Hat Enterprise Linux', spot: true }],
      [{ kind: 'ec2', type: 'x9.huge', count: 1, os: 'Linux', spot: true }],
    ], () => [], { spot: (_r, input) => (input.ProductDescriptions[0] === 'Windows' ? [{ AvailabilityZone: 'eu-west-1a', SpotPrice: '0.050000', Timestamp: now }] : []) }),
    hourly('Spot in a region the account has not enabled: nothing priced, nothing cached', [[{ ...T3, spot: true }, NONE, 'ap-east-2'], [{ ...T3, spot: true }, NONE, 'ap-east-2']], () => [], {
      spot: () => { throw error('OptInRequired', 'You are not subscribed to this service'); },
    }),
    hourly('Fargate Spot at 30% of the on-demand price', [[{ ...fargate, spot: true }], [fargate]], FARGATE),
    hourly('discounts: compute off on-demand EC2 and Fargate, databases off RDS and Aurora, none off Spot', [
      [{ ...T3, count: 2 }, { compute: 20, databases: 30 }], [fargate, { compute: 20, databases: 30 }], [DB, { compute: 20, databases: 30 }],
      [{ kind: 'aurora-serverless', engine: 'aurora-mysql', acu: 0.5 }, { compute: 20, databases: 30 }], [{ ...T3, count: 2, spot: true }, { compute: 20, databases: 30 }],
      [{ ...fargate, spot: true }, { compute: 20, databases: 30 }], [{ ...T3, count: 2 }, { compute: 20, databases: 30 }], [{ ...T3, count: 2 }],
    ], (f) => {
      if (f.ServiceCode === 'AmazonEC2') return [product({}, '0.0456000000')];
      if (f.ServiceCode === 'AmazonRDS') return [product({}, f['~usagetype'] === 'Aurora:ServerlessV2Usage' ? '0.1400000000' : '0.0170000000')];
      return FARGATE(f);
    }, { spot: () => [{ AvailabilityZone: 'eu-west-1a', SpotPrice: '0.019000', Timestamp: now }] }),
    hourly('pods on nodes: their share of the node times its price and the pods; Spot pods at the Spot price', [
      [pods], [{ ...pods, cpu: 0.1, memoryGb: 4 }], [{ ...pods, cpu: 3 }], [{ ...pods, spot: true }, { compute: 20, databases: 0 }], [pods, { compute: 20, databases: 0 }],
    ], M5, { spot: () => [{ AvailabilityZone: 'eu-west-1a', SpotPrice: '0.040000', Timestamp: now }] }),
    hourly('pods on nodes no autoscaler removes save nothing; without the node\'s type or allocatable, no price', [
      [{ ...pods, autoscaled: false }], [{ ...pods, nodeType: null }], [{ ...pods, allocatable: { cpu: 0, memoryGb: 0 } }], [{ ...pods, nodeType: 'x9.huge' }],
    ], M5),
    hourly('prices already in the cache, one of them none (null): read, never asked', [[T3], [{ kind: 'ec2', type: 'm5.large', count: 1, os: 'Linux' }]], () => [], {
      cache: { 'eu-west-1#ec2#t3.medium#Linux': 0.0456, 'eu-west-1#ec2#m5.large#Linux': null },
    }),
    { name: 'baselineHours: always, every hour', input: { function: 'baselineHours', from: '2026-10-08T00:00:00.000Z', to: '2026-10-08T10:00:00.000Z', baseline: { kind: 'always' } } },
    { name: 'baselineHours: business hours across a weekend in Paris', input: { function: 'baselineHours', from: '2026-10-09T16:00:00.000Z', to: '2026-10-12T08:00:00.000Z', baseline: PARIS } },
    { name: 'baselineHours: business hours after Paris goes back to UTC+1', input: { function: 'baselineHours', from: '2026-10-26T06:30:00.000Z', to: '2026-10-26T07:30:00.000Z', baseline: PARIS } },
    { name: 'baselineHours: business hours the Monday before, at UTC+2', input: { function: 'baselineHours', from: '2026-10-19T06:30:00.000Z', to: '2026-10-19T07:30:00.000Z', baseline: PARIS } },
    { name: 'baselineHours: business hours over 14 days in New York', input: { function: 'baselineHours', from: '2026-09-28T08:00:00.000Z', to: now, baseline: { kind: 'business-hours', timeZone: 'America/New_York' } } },
    { name: 'baselineHours: an empty period', input: { function: 'baselineHours', from: now, to: now, baseline: { kind: 'always' } } },
    {
      name: 'savingsOf: each asleep phase\'s hours by what it stopped, the items summed',
      input: {
        function: 'savingsOf', baseline: { kind: 'always' }, prices: [{ item: T3, usd: 0.0456 }, { item: DB, usd: 0.017 }],
        phases: [
          { state: 'AWAKE', from: '2026-10-08T00:00:00.000Z', to: '2026-10-08T02:00:00.000Z' },
          { state: 'ASLEEP', from: '2026-10-08T02:00:00.000Z', to: '2026-10-08T12:00:00.000Z', stopped: [T3, DB] },
          { state: 'ASLEEP', from: '2026-10-08T14:00:00.000Z', to: '2026-10-08T16:00:00.000Z', stopped: [T3] },
        ],
      },
    },
    {
      name: 'savingsOf: what it could not price, never as nothing saved',
      input: {
        function: 'savingsOf', baseline: { kind: 'always' }, prices: [{ item: T3, usd: 0.0456 }, { item: { kind: 'unknown', backend: 'ecs:web', reason: 'denied' }, usd: null }],
        phases: [
          { state: 'ASLEEP', from: '2026-10-08T00:00:00.000Z', to: '2026-10-08T05:00:00.000Z' },
          { state: 'ASLEEP', from: '2026-10-08T06:00:00.000Z', to: '2026-10-08T08:00:00.000Z', stopped: [T3, { kind: 'unknown', backend: 'ecs:web', reason: 'denied' }] },
        ],
      },
    },
    {
      name: 'savingsOf: only the baseline\'s hours',
      input: { function: 'savingsOf', baseline: PARIS, prices: [{ item: T3, usd: 0.0456 }], phases: [{ state: 'ASLEEP', from: '2026-10-09T16:00:00.000Z', to: '2026-10-12T08:00:00.000Z', stopped: [T3] }] },
    },
    { name: 'DORMETO_COST: Dormeto\'s cost a month', input: { function: 'DORMETO_COST' } },
  ];
}

export async function run(product, input, ports) {
  switch (input.function) {
    case 'hourly': {
      // The cache (the estimate's prices.json): a price per key, null when AWS has none; the book's puts kept apart.
      const cache = new Map(Object.entries(input.cache));
      const put = {};
      const store = {
        getPrice: async (key) => (cache.has(key) ? { usd: cache.get(key) } : null),
        putPrice: async (key, usd, days) => { cache.set(key, usd); put[key] = { usd, days }; },
      };
      const book = product.createPriceBook({ pricing: ports.pricing, spot: ports.spot, store, now: () => Date.parse(input.now) });
      const prices = [];
      for (const { region, item, discounts } of input.lookups) prices.push(await book.hourly(region, item, discounts));
      return { prices, cache: put };
    }
    case 'baselineHours': return product.baselineHours(input.from, input.to, input.baseline);
    case 'savingsOf': return product.savingsOf(input.phases, { hourly: pricesOf(input.prices), baseline: input.baseline });
    case 'DORMETO_COST': return product.DORMETO_COST;
    default: throw new Error(`unknown function ${input.function}`);
  }
}

export const readme = `The product's prices (\`packages/fleet/src/prices.ts\`, \`savings.ts\`, \`packages/api/src/spot.ts\`; Go
\`internal/prices\`). \`input.function\` names the function:

- \`hourly\` (Go \`prices.NewBook(pricing, spot, cache, now)\` then \`(*Book).Hourly\`): one price book made at
  \`input.now\` over the recorded answers and a cache holding \`input.cache\` (\`{key: usd or null}\`: prices already
  there, fresh), then asked each of \`input.lookups\` in order (\`{region, item, discounts}\`, \`discounts\` as
  \`{compute, databases}\` percentages: \`hourly(region, item, discounts)\`). Output: \`{prices, cache}\` — the price of
  each lookup (USD an hour, or null), and every price the book put in the cache (\`{key: {usd, days}}\`, \`days\` as
  the book passes it: 30 for a list price, 1 for Spot; the cache itself keeps a null a day).
- \`baselineHours\` (Go \`prices.BaselineHours\`): \`{from, to, baseline}\`. Output: hours.
- \`savingsOf\` (Go \`prices.SavingsOf\`): \`{phases, baseline, prices}\`, \`prices\` in place of the \`hourly\` callback as
  in \`replay\` (\`[{item, usd}]\`). Output: the \`Savings\` (\`usd\`, \`hours\`, \`items\`, \`unpriced\`).
- \`DORMETO_COST\` (Go \`prices.DormetoCost\`): no input. Output: Dormeto's cost a month by part.`;
