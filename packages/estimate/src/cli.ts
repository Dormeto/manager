// The estimate command (vision docs/specs/2026-10-10-savings-estimate-design.md §3, §8): the options, the accounts, the
// three phases with their progress, the reports and the summary. Exit code 0, 1 when AWS refuses (credentials, an
// organization call), 2 on a bad option (accounts given that cannot be estimated too). AWS comes through EstimateAws (bin.ts wires the SDK; the tests, fakes).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Credentials } from '@dormeto/discovery/aws';
import type { Discounts, StoppedItem } from '@dormeto/fleet';
import { reachProfiles, type AccountsPorts } from './accounts.js';
import { createCache, type PriceCache } from './cache.js';
import { discoverAll, type Progress, type RegionPorts } from './discover.js';
import { estimateAll } from './estimate.js';
import { USAGE, UsageError, parseOptions, type Options } from './options.js';
import { jsonReport, markdownReport, summaryLines } from './report.js';
import { requestsAll, type CloudWatchPort } from './requests.js';
import { excludeByTags } from './tags.js';
import { uptimeAll } from './uptime.js';

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
  // The AWS of each profile given: an account is read with the profile reaching it.
  aws: (options: Options, profile: string) => EstimateAws;
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
    const awsByProfile = new Map(options.profiles.map((profile) => [profile, deps.aws(options, profile)]));
    const reached = await reachProfiles(options.profiles.map((profile) => ({ profile, ports: awsByProfile.get(profile)!.accounts })), { role: options.role, only: options.accounts });
    // An account's AWS: the profile reaching it
    const awsOf = (account: string) => awsByProfile.get(reached.accounts.find((a) => a.account === account)?.profile ?? options.profiles[0]!)!;
    const aws: Pick<EstimateAws, 'regionsOf' | 'portsOf' | 'cloudwatchOf'> = {
      regionsOf: (account, credentials) => awsOf(account).regionsOf(account, credentials),
      portsOf: (account, region, credentials) => awsOf(account).portsOf(account, region, credentials),
      cloudwatchOf: (account, region, credentials) => awsOf(account).cloudwatchOf(account, region, credentials),
    };
    const key = reached.organization ?? reached.accounts[0]!.account;
    const cache = createCache({ dir: join(deps.cacheRoot, key), now: deps.now });
    const counted = options.accounts ? `${reached.accounts.length} of its ${reached.listed} accounts, --accounts` : `${reached.accounts.length} accounts`;
    const what = reached.organization ? `the organization ${reached.organization} (${counted})`
      : reached.accounts.length === 1 ? `the account ${key}` : `the accounts ${reached.accounts.map((a) => a.account).join(', ')}`;
    deps.log(`Estimating ${what}; cache ${join(deps.cacheRoot, key)}`);
    if (reached.why) deps.log(reached.why);
    const progress: Progress = (p) => deps.log(`  ${p.phase} ${p.account} ${p.region}: ${p.error ? `failed (${p.error})` : `${p.workloads} workload${p.workloads === 1 ? '' : 's'}`}${p.from === 'cache' ? ' (cache)' : ''}`);
    deps.log('Phase 1: discovery');
    const discovered = await discoverAll({ reached, regions: options.regions, regionsOf: aws.regionsOf, portsOf: aws.portsOf, cache, refresh: options.refresh, now: deps.now, progress });
    // Excluded by their tags before their requests are read.
    const { regions, excluded } = excludeByTags(discovered.regions, options.excludeTags);
    const credentialsOf = async (account: string) => (await reached.accounts.find((a) => a.account === account)?.credentials()) ?? null;
    deps.log('Phase 2: requests');
    const cloudwatchOf = async (account: string, region: string) => aws.cloudwatchOf(account, region, await credentialsOf(account));
    const requests = await requestsAll({ regions, cloudwatchOf, cache, refresh: options.refresh, now: deps.now, progress });
    // When the EC2 instances without an Auto Scaling group ran, over the same period.
    const uptime = options.ec2Uptime ? await uptimeAll({ regions, requests, cloudwatchOf, cache, refresh: options.refresh, now: deps.now, progress }) : null;
    deps.log('Phase 3: estimate');
    // The prices are public: any profile reads them
    const book = awsByProfile.get(options.profiles[0]!)!.prices(cache.prices);
    const { out, profiles: _profiles, ...kept } = options;
    const estimate = await estimateAll({
      reached, regions, requests, hourly: (region, item) => book.hourly(region, item, options.discounts), priceFailure: () => book.failure?.() ?? null,
      baseline: options.baseline, options: kept, now: deps.now(), excluded, uptime,
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
    // Accounts given that cannot be estimated: a bad option, known once AWS has said which accounts there are.
    if (err instanceof UsageError) {
      deps.error(err.message);
      return 2;
    }
    deps.error(`${(err as Error).name}: ${(err as Error).message}`);
    return 1;
  }
}
