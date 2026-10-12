// The estimate command (vision docs/specs/2026-10-10-savings-estimate-design.md §3, §8): the options, the accounts, the
// three phases with their progress, the reports and the summary. Exit code 0, 1 when AWS refuses (credentials, an
// organization call), 2 on a bad option. AWS comes through EstimateAws (bin.ts wires the SDK; the tests, fakes).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Credentials } from '@dormeto/discovery/aws';
import type { Discounts, StoppedItem } from '@dormeto/fleet';
import { reachAccounts, type AccountsPorts } from './accounts.js';
import { createCache, type PriceCache } from './cache.js';
import { discoverAll, type Progress, type RegionPorts } from './discover.js';
import { estimateAll } from './estimate.js';
import { USAGE, UsageError, parseOptions, type Options } from './options.js';
import { jsonReport, markdownReport, summaryLines } from './report.js';
import { requestsAll, type CloudWatchPort } from './requests.js';

export interface EstimateAws {
  accounts: AccountsPorts;
  regionsOf(account: string, credentials: Credentials | null): Promise<string[]>;
  portsOf(account: string, region: string, credentials: Credentials | null): RegionPorts;
  cloudwatchOf(account: string, region: string, credentials: Credentials | null): CloudWatchPort;
  // failure: a price lookup AWS refused, if any (unpriced workloads then say so).
  prices(cache: PriceCache): { hourly(region: string, item: StoppedItem, discounts: Discounts): Promise<number | null>; failure?(): string | null };
}
export interface CliDeps {
  now: () => number;
  cacheRoot: string;
  log: (line: string) => void;
  error: (line: string) => void;
  aws: (options: Options) => EstimateAws;
  writeFile?: (path: string, text: string) => Promise<void>;
}

const save = async (path: string, text: string) => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
};

export async function main(argv: string[], deps: CliDeps): Promise<number> {
  let options: Options;
  try {
    options = parseOptions(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    deps.error(err.message);
    deps.error(USAGE);
    return 2;
  }
  try {
    const aws = deps.aws(options);
    const reached = await reachAccounts(aws.accounts, { role: options.role });
    const key = reached.organization ?? reached.accounts[0]!.account;
    const cache = createCache({ dir: join(deps.cacheRoot, key), now: deps.now });
    deps.log(`Estimating ${reached.organization ? `the organization ${reached.organization} (${reached.accounts.length} accounts)` : `the account ${key}`}; cache ${join(deps.cacheRoot, key)}`);
    if (reached.why) deps.log(reached.why);
    const progress: Progress = (p) => deps.log(`  ${p.phase} ${p.account} ${p.region}: ${p.error ? `failed (${p.error})` : `${p.workloads} workload${p.workloads === 1 ? '' : 's'}`}${p.from === 'cache' ? ' (cache)' : ''}`);
    deps.log('Phase 1: discovery');
    const { regions } = await discoverAll({ reached, regions: options.regions, regionsOf: aws.regionsOf, portsOf: aws.portsOf, cache, refresh: options.refresh, now: deps.now, progress });
    const credentialsOf = async (account: string) => (await reached.accounts.find((a) => a.account === account)?.credentials()) ?? null;
    deps.log('Phase 2: requests');
    const requests = await requestsAll({ regions, cloudwatchOf: async (account, region) => aws.cloudwatchOf(account, region, await credentialsOf(account)), cache, refresh: options.refresh, now: deps.now, progress });
    deps.log('Phase 3: estimate');
    const book = aws.prices(cache.prices);
    const { out, profile: _profile, ...kept } = options;
    const estimate = await estimateAll({
      reached, regions, requests, hourly: (region, item) => book.hourly(region, item, options.discounts), priceFailure: () => book.failure?.() ?? null,
      baseline: options.baseline, options: kept, now: deps.now(),
    });
    const date = new Date(deps.now()).toISOString().slice(0, 10);
    const md = join(out, `estimate-${date}.md`);
    const json = join(out, `estimate-${date}.json`);
    const write = deps.writeFile ?? save;
    await write(md, markdownReport(estimate));
    await write(json, jsonReport(estimate));
    for (const line of summaryLines(estimate)) deps.log(line);
    deps.log(`Reports: ${md} and ${json}`);
    return 0;
  } catch (err) {
    deps.error(`${(err as Error).name}: ${(err as Error).message}`);
    return 1;
  }
}
