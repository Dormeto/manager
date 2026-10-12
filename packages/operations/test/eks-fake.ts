// EKS as the operations call it (src/cluster-access.ts): clusters, access entries by cluster and principal, associated
// policies; every write recorded.
import type { EksPort } from '../src/cluster-access.js';

export const cluster = (name: string, { mode = 'API', public: open = true, cidrs = ['0.0.0.0/0'] }: { mode?: string; public?: boolean; cidrs?: string[] } = {}) => ({
  name, accessConfig: { authenticationMode: mode }, resourcesVpcConfig: { endpointPublicAccess: open, publicAccessCidrs: cidrs },
});

// EKS as it answers: entries by cluster and principal, associated policies, every write recorded; deny: error thrown by
// every write.
export function fakeEks(clusters: ReturnType<typeof cluster>[], { deny }: { deny?: Error } = {}): EksPort & { writes: [string, Record<string, unknown>][]; entries: Map<string, { kubernetesGroups: string[] }>; policies: Map<string, string[]> } {
  const entries = new Map<string, { kubernetesGroups: string[] }>();
  const policies = new Map<string, string[]>();
  const writes: [string, Record<string, unknown>][] = [];
  const key = (i: { clusterName: string; principalArn: string }) => `${i.clusterName} ${i.principalArn}`;
  const notFound = () => Object.assign(new Error('The specified access entry resource is not found'), { name: 'ResourceNotFoundException' });
  const write = (name: string, input: Record<string, unknown>) => {
    if (deny) throw deny;
    writes.push([name, input]);
  };
  return {
    writes, entries, policies,
    async listClusters() { return { clusters: clusters.map((c) => c.name) }; },
    async describeCluster({ name }) { return { cluster: clusters.find((c) => c.name === name) }; },
    async describeAccessEntry(input) {
      const entry = entries.get(key(input));
      if (!entry) throw notFound();
      return { accessEntry: { principalArn: input.principalArn, ...entry } };
    },
    async createAccessEntry(input) {
      write('createAccessEntry', input);
      entries.set(key(input), { kubernetesGroups: input.kubernetesGroups ?? [] });
      return {};
    },
    async listAssociatedAccessPolicies(input) { return { associatedAccessPolicies: (policies.get(key(input)) ?? []).map((policyArn) => ({ policyArn })) }; },
    async associateAccessPolicy(input) {
      write('associateAccessPolicy', input);
      policies.set(key(input), [...(policies.get(key(input)) ?? []), input.policyArn]);
      return {};
    },
  };
}

