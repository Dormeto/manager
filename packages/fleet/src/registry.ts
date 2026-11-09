// The registry of the routers the manager knows by installation (a router installed by the manager, or registered for
// a Google Cloud project): one item per router in the manager table, `ROUTER#<account>#<region>` under T#default, the
// router as JSON in `data`. Operations writes and reads it, the API registers a Google Cloud connection's routers, and
// discovery keeps the Google Cloud ones up to date: they share this format.
import type { AttributeValue } from '@aws-sdk/client-dynamodb';

export const REGISTRY_PK = 'T#default';
export const ROUTER_PREFIX = 'ROUTER#';

// The Kubernetes proxies the manager made for a router's clusters whose endpoint is private (R10.6).
export interface ProxyRecord {
  cluster: string;
  function: string;
  role: string;
  logGroup: string;
  securityGroupId: string | null;
  clusterSecurityGroupId: string;
  vpcId: string;
  deletedAt?: string;
}

export interface InstalledRouter {
  name: string;
  account: string;
  region: string;
  controller: string; // function ARNs
  onboarder: string;
  version: string;
  build: string;
  installedBy: string;
  cloud?: 'gcp'; // a Google Cloud router (Google Cloud design §3): `account` is its project, `controller` its URL, `onboarder` empty
  installedAt: string;
  uninstalling?: boolean; // an uninstall runs: no new onboarding
  // The EKS clusters of its account and region, as its last check found them (R10.5: the router's view).
  clusters?: { name: string; reachable: boolean; allowed: boolean; missing: string[]; reason?: string; via?: 'direct' | 'proxy'; proxy?: { name: string; version: string | null }; checkedAt: string }[];
  // The Kubernetes proxies the manager made for its clusters whose endpoint is private (R10.6): what their removals delete.
  proxies?: ProxyRecord[];
}

export const routerSort = (account: string, region: string) => `${ROUTER_PREFIX}${account}#${region}`;
export const routerKey = (account: string, region: string) => ({ pk: { S: REGISTRY_PK }, sk: { S: routerSort(account, region) } });
export const routerItem = (router: InstalledRouter): Record<string, AttributeValue> => ({ ...routerKey(router.account, router.region), data: { S: JSON.stringify(router) } });
export const routerOf = (item: Record<string, AttributeValue> | undefined): InstalledRouter | null => (item?.data?.S ? (JSON.parse(item.data.S) as InstalledRouter) : null);
