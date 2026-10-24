// The prefix of the Kubernetes proxies' function names in an account and region (private EKS endpoints): <router name>-kube-
// of the router the manager knows there, installed or reporting (spec section 5): written in Terraform (ROUTERS) or
// installed (the table's ROUTER# records), else one that reports to the manager (its summary in the fleet store, recent as
// the API counts it); none when there is no router. routersOf is operations', the summaries and `reporting` the fleet's
// (discovery depends on neither package: relative paths).
import { routersOf, type TerraformRouter } from '../../operations/src/routers.js';
import type { Records } from '../../operations/src/records.js';
import { reporting as reports, type RouterSummary } from '../../fleet/src/store.js';

type Summary = Pick<RouterSummary, 'account' | 'region' | 'name' | 'checkedAt' | 'checkSchedule'>;

export async function proxyPrefixOf(terraform: TerraformRouter[], records: Pick<Records, 'listRouters'>, where: { account: string; region: string },
  { reporting = [], now = Date.now() }: { reporting?: Summary[]; now?: number } = {}): Promise<string | null> {
  const router = (await routersOf(terraform, records)).find((r) => r.account === where.account && r.region === where.region);
  if (router) return `${router.name}-kube-`;
  const reported = reporting.find((s) => s.account === where.account && s.region === where.region && reports(s, now));
  return reported ? `${reported.name}-kube-` : null;
}

// The handler's lookup: the table's installed routers and the routers' summaries read once a minute at most (never a failed
// read: the next scan reads again); a failed read costs that scan its proxies (no prefix: a private cluster gets the
// "install the router" reason), never the scan.
export function createProxyPrefixes({ terraform, records, fleet, log, now = Date.now }: {
  terraform: TerraformRouter[];
  records: Pick<Records, 'listRouters'>;
  fleet?: { listRouters(): Promise<Summary[]> };
  log: { warn(event: string, data?: object): void };
  now?: () => number;
}) {
  let known: { at: number; read: Promise<[Awaited<ReturnType<Records['listRouters']>>, Summary[]]> } | undefined;
  return async (where: { account: string; region: string }): Promise<string | null> => {
    try {
      if (!known || now() - known.at > 60_000) {
        const entry = { at: now(), read: Promise.all([records.listRouters(), fleet ? fleet.listRouters() : Promise.resolve([])]) };
        known = entry;
        entry.read.catch(() => { if (known === entry) known = undefined; });
      }
      const [routers, reporting] = await known.read;
      return await proxyPrefixOf(terraform, { listRouters: async () => routers }, where, { reporting, now: now() });
    } catch (err) {
      log.warn('router-lookup-failed', { account: where.account, region: where.region, error: String((err as Error)?.message ?? err) });
      return null;
    }
  };
}
