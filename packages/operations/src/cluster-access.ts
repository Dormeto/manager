// A router's access to the EKS clusters of its account and region (vision docs/specs/2026-10-11-kubernetes-design.md,
// section 4): its roles in the Kubernetes group dormeto:router, whose rights come from the ClusterRole Dormeto publishes
// (supposed there, checked by the router's clusterCheck), and DmtDiscoveryRole with AmazonEKSViewPolicy. Made by API calls of
// DmtCommandRole, whose statement EksAccessEntries allows these roles, this group and this policy only. A cluster on
// aws-auth only, or one the router cannot reach, is left with what to do. Removing the router removes its roles' entries:
// EKS keeps an entry whose role is gone, and that entry does not work for a role made again with the same ARN.

// Loose SDK shapes: the adapter (aws.ts) passes the commands' inputs and outputs through.
type Call = (input: any) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export type EksPort = Record<'listClusters' | 'describeCluster' | 'describeAccessEntry' | 'createAccessEntry' | 'deleteAccessEntry' | 'listAssociatedAccessPolicies' | 'associateAccessPolicy', Call>;

export const ROUTER_GROUP = 'dormeto:router';
const viewPolicy = (partition: string) => `arn:${partition}:eks::aws:cluster-access-policy/AmazonEKSViewPolicy`;
const PRIVATE = 'its endpoint is private (or limited to some addresses): Dormeto reaches it with the in-cluster agent (R10.6)';

// ready: the router can be checked there (an endpoint it reaches; on aws-auth only, the customer maps its roles).
export interface ClusterAccess {
  cluster: string;
  status: 'done' | 'skipped';
  ready: boolean;
  detail: string;
}

const denied = (err: unknown) => /AccessDenied|not authorized/i.test(`${(err as Error).name} ${(err as Error).message}`);
const deniedError = (name: string, err: unknown) => new Error(`the command role may not manage the access entries of cluster ${name}: apply the access module (or the AWS CLI script) of the manager's release again (statement EksAccessEntries): ${(err as Error).message}`);
const notFound = (err: unknown) => (err as Error).name === 'ResourceNotFoundException';

async function clusterNames(eks: EksPort): Promise<string[]> {
  const names: string[] = [];
  let next: string | undefined;
  do {
    const page = await eks.listClusters(next ? { nextToken: next } : {});
    names.push(...(page.clusters ?? []));
    next = page.nextToken;
  } while (next);
  return names;
}

async function entryOf(eks: EksPort, clusterName: string, principalArn: string): Promise<{ kubernetesGroups?: string[] } | null> {
  try {
    return (await eks.describeAccessEntry({ clusterName, principalArn })).accessEntry ?? null;
  } catch (err) {
    if (notFound(err)) return null;
    throw err;
  }
}

// Every cluster of the region: the entries made where missing, each cluster's outcome.
export async function ensureClusterAccess(eks: EksPort, { routerRoles, discoveryRole, partition = 'aws' }: { routerRoles: string[]; discoveryRole: string; partition?: string }): Promise<ClusterAccess[]> {
  const results: ClusterAccess[] = [];
  for (const name of await clusterNames(eks)) {
    const { cluster = {} } = await eks.describeCluster({ name });
    const vpc = cluster.resourcesVpcConfig ?? {};
    if ((cluster.accessConfig?.authenticationMode ?? 'CONFIG_MAP') === 'CONFIG_MAP') {
      results.push({ cluster: name, status: 'skipped', ready: true, detail: `cluster ${name}: authentication mode CONFIG_MAP (aws-auth only): switch it to API_AND_CONFIG_MAP, or map the router's roles to the group ${ROUTER_GROUP} in aws-auth` });
      continue;
    }
    if (!(vpc.endpointPublicAccess && (vpc.publicAccessCidrs ?? []).includes('0.0.0.0/0'))) {
      results.push({ cluster: name, status: 'skipped', ready: false, detail: `cluster ${name}: ${PRIVATE}` });
      continue;
    }
    try {
      const created: string[] = [];
      const notes: string[] = [];
      for (const principalArn of routerRoles) {
        const entry = await entryOf(eks, name, principalArn);
        if (!entry) {
          await eks.createAccessEntry({ clusterName: name, principalArn, kubernetesGroups: [ROUTER_GROUP], type: 'STANDARD' });
          created.push(principalArn);
        } else if (!(entry.kubernetesGroups ?? []).includes(ROUTER_GROUP)) notes.push(`${principalArn} has an access entry without the group ${ROUTER_GROUP} (left as it is)`);
      }
      let discovery = false;
      if (!(await entryOf(eks, name, discoveryRole))) {
        await eks.createAccessEntry({ clusterName: name, principalArn: discoveryRole, type: 'STANDARD' });
        discovery = true;
      }
      const { associatedAccessPolicies = [] } = await eks.listAssociatedAccessPolicies({ clusterName: name, principalArn: discoveryRole });
      if (!associatedAccessPolicies.some((p: { policyArn?: string }) => p.policyArn === viewPolicy(partition))) {
        await eks.associateAccessPolicy({ clusterName: name, principalArn: discoveryRole, policyArn: viewPolicy(partition), accessScope: { type: 'cluster' } });
        discovery = true;
      }
      const made = [
        ...(created.length ? [`${created.length} router role${created.length === 1 ? '' : 's'} (group ${ROUTER_GROUP})`] : []),
        ...(discovery ? ['DmtDiscoveryRole (AmazonEKSViewPolicy)'] : []),
      ];
      const detail = made.length ? `cluster ${name}: access entries created for ${made.join(' and ')}` : `cluster ${name}: access entries in place`;
      results.push({ cluster: name, status: made.length ? 'done' : 'skipped', ready: true, detail: [detail, ...notes].join('; ') });
    } catch (err) {
      if (denied(err)) throw deniedError(name, err);
      throw err;
    }
  }
  return results;
}

// Every cluster of the region: the router roles' entries deleted (DmtDiscoveryRole's stay, discovery goes on).
export async function removeClusterAccess(eks: EksPort, { routerRoles }: { routerRoles: string[] }): Promise<ClusterAccess[]> {
  const results: ClusterAccess[] = [];
  for (const name of await clusterNames(eks)) {
    const { cluster = {} } = await eks.describeCluster({ name });
    if ((cluster.accessConfig?.authenticationMode ?? 'CONFIG_MAP') === 'CONFIG_MAP') {
      results.push({ cluster: name, status: 'skipped', ready: true, detail: `cluster ${name}: authentication mode CONFIG_MAP (aws-auth only): remove the router's roles from aws-auth` });
      continue;
    }
    let removed = 0;
    for (const principalArn of routerRoles) {
      try {
        await eks.deleteAccessEntry({ clusterName: name, principalArn });
        removed += 1;
      } catch (err) {
        if (notFound(err)) continue;
        if (denied(err)) throw deniedError(name, err);
        throw err;
      }
    }
    results.push(removed
      ? { cluster: name, status: 'done', ready: true, detail: `cluster ${name}: access entries of ${removed} router role${removed === 1 ? '' : 's'} removed` }
      : { cluster: name, status: 'skipped', ready: true, detail: `cluster ${name}: no access entry of the router` });
  }
  return results;
}
