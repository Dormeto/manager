// The prefix of the Kubernetes proxies' function names in an account and region (private EKS endpoints): <router name>-kube-
// of the router the manager knows there, written in Terraform (ROUTERS) or installed (the table's ROUTER# records); none
// when there is no router. routersOf is operations' (discovery does not depend on that package: relative path).
import { routersOf, type TerraformRouter } from '../../operations/src/routers.js';
import type { Records } from '../../operations/src/records.js';

export async function proxyPrefixOf(terraform: TerraformRouter[], records: Pick<Records, 'listRouters'>, where: { account: string; region: string }): Promise<string | null> {
  const router = (await routersOf(terraform, records)).find((r) => r.account === where.account && r.region === where.region);
  return router ? `${router.name}-kube-` : null;
}

// The handler's lookup: the table's routers read once a minute at most (never a failed read: the next scan reads again); a
// failed read costs that scan its proxies (no prefix: a private cluster gets the "install the router" reason), never the scan.
export function createProxyPrefixes({ terraform, records, log, now = Date.now }: {
  terraform: TerraformRouter[];
  records: Pick<Records, 'listRouters'>;
  log: { warn(event: string, data?: object): void };
  now?: () => number;
}) {
  let known: { at: number; routers: ReturnType<Records['listRouters']> } | undefined;
  return async (where: { account: string; region: string }): Promise<string | null> => {
    try {
      if (!known || now() - known.at > 60_000) {
        const entry = { at: now(), routers: records.listRouters() };
        known = entry;
        entry.routers.catch(() => { if (known === entry) known = undefined; });
      }
      const routers = await known.routers;
      return await proxyPrefixOf(terraform, { listRouters: async () => routers }, where);
    } catch (err) {
      log.warn('router-lookup-failed', { account: where.account, region: where.region, error: String((err as Error)?.message ?? err) });
      return null;
    }
  };
}
