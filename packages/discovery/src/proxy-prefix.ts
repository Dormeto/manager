// The prefix of the Kubernetes proxies' function names in an account and region (private EKS endpoints): <router name>-kube-
// of the router the manager knows there, written in Terraform (ROUTERS) or installed (the table's ROUTER# records); none
// when there is no router. routersOf is operations' (discovery does not depend on that package: relative path).
import { routersOf, type TerraformRouter } from '../../operations/src/routers.js';
import type { Records } from '../../operations/src/records.js';

export async function proxyPrefixOf(terraform: TerraformRouter[], records: Pick<Records, 'listRouters'>, where: { account: string; region: string }): Promise<string | null> {
  const router = (await routersOf(terraform, records)).find((r) => r.account === where.account && r.region === where.region);
  return router ? `${router.name}-kube-` : null;
}
