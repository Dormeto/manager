// The registry of the routers the manager knows by installation (a router installed by the manager, or registered for
// a Google Cloud project): one item per router in the manager table, `ROUTER#<account>#<region>` under T#default, the
// router as JSON in `data`. Operations writes and reads it, the API registers a Google Cloud connection's routers, and
// discovery keeps the Google Cloud ones up to date, the fleet's poll removes an uninstalled Google Cloud router and keeps
// the version of one too old to poll, and the fleet reads one that reported to push it the settings: they share this format.
import { DeleteItemCommand, GetItemCommand, PutItemCommand, QueryCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';

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

// The registry read and written by a DynamoDB client of the manager table (the fleet function's).
export function createRegistry({ dynamo, table }: { dynamo: { send(command: object): Promise<any> }; table: string }) {
  return {
    async list(): Promise<InstalledRouter[]> {
      const routers: InstalledRouter[] = [];
      let start: Record<string, AttributeValue> | undefined;
      do {
        const page = await dynamo.send(new QueryCommand({
          TableName: table, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
          ExpressionAttributeValues: { ':pk': { S: REGISTRY_PK }, ':prefix': { S: ROUTER_PREFIX } }, ...(start ? { ExclusiveStartKey: start } : {}),
        }));
        routers.push(...(page.Items ?? []).map((item: Record<string, AttributeValue>) => routerOf(item)).filter((r: InstalledRouter | null): r is InstalledRouter => r !== null));
        start = page.LastEvaluatedKey;
      } while (start);
      return routers;
    },
    // One router's registration, null when there is none (the fleet's push of the settings to a router that reported).
    async get(account: string, region: string): Promise<InstalledRouter | null> {
      return routerOf((await dynamo.send(new GetItemCommand({ TableName: table, Key: routerKey(account, region), ConsistentRead: true }))).Item);
    },
    async put(router: InstalledRouter): Promise<void> {
      await dynamo.send(new PutItemCommand({ TableName: table, Item: routerItem(router) }));
    },
    // A router's new state, written only while its registration is still there (a disconnect may have removed it since it was read).
    async update(router: InstalledRouter): Promise<boolean> {
      try {
        await dynamo.send(new PutItemCommand({ TableName: table, Item: routerItem(router), ConditionExpression: 'attribute_exists(sk)' }));
        return true;
      } catch (err) {
        if ((err as Error).name === 'ConditionalCheckFailedException') return false;
        throw err;
      }
    },
    // The removal of the registration as it was read: false when it changed or went since (connect or discovery rewrote it).
    async deleteIf(account: string, region: string, read: InstalledRouter): Promise<boolean> {
      try {
        await dynamo.send(new DeleteItemCommand({
          TableName: table, Key: routerKey(account, region), ConditionExpression: '#d = :read',
          ExpressionAttributeNames: { '#d': 'data' }, ExpressionAttributeValues: { ':read': { S: JSON.stringify(read) } },
        }));
        return true;
      } catch (err) {
        if ((err as Error).name === 'ConditionalCheckFailedException') return false;
        throw err;
      }
    },
    async delete(account: string, region: string): Promise<void> {
      await dynamo.send(new DeleteItemCommand({ TableName: table, Key: routerKey(account, region) }));
    },
  };
}

export type Registry = ReturnType<typeof createRegistry>;
