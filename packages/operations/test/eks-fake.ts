// EKS as the operations call it (src/cluster-access.ts, src/kube-proxies.ts): clusters, access entries by cluster and
// principal, associated policies; every write recorded.
import type { EksPort } from '../src/cluster-access.js';

// A cluster as DescribeCluster answers it: its endpoint settings (open to every address by default), its VPC, subnets and
// cluster security group (eks-demo's are the command policy test's, test/command-policy.ts), its endpoint and authority.
export const cluster = (name: string, { mode = 'API', public: open = true, cidrs = ['0.0.0.0/0'], private: privateAccess = false, vpc = 'vpc-0a1b2c3d', group, endpoint }: {
  mode?: string; public?: boolean; cidrs?: string[]; private?: boolean; vpc?: string; group?: string; endpoint?: string;
} = {}) => ({
  name, status: 'ACTIVE', endpoint: endpoint ?? `https://${name.toUpperCase()}0A1B.gr7.eu-west-1.eks.amazonaws.com`,
  certificateAuthority: { data: Buffer.from(pem(name)).toString('base64') },
  accessConfig: { authenticationMode: mode },
  resourcesVpcConfig: {
    endpointPublicAccess: open, publicAccessCidrs: cidrs, endpointPrivateAccess: privateAccess, vpcId: vpc, subnetIds: ['subnet-0aaa', 'subnet-0bbb'],
    clusterSecurityGroupId: group ?? (name === 'eks-demo' ? 'sg-0cluster00' : `sg-0cluster-${name}`),
  },
});
// The cluster's certificate authority as PEM (what the proxy's DMT_CA holds).
export const pem = (name: string) => `-----BEGIN CERTIFICATE-----\nMIIC${name}\n-----END CERTIFICATE-----\n`;

// EKS as it answers: entries by cluster and principal, associated policies, every write recorded; deny: error thrown by
// every write; denyList: by the clusters' listing too (a command role without any EKS statement). The clusters are read
// at each call: a test adds or removes some.
export function fakeEks(clusters: ReturnType<typeof cluster>[], { deny, denyList }: { deny?: Error; denyList?: Error } = {}): EksPort & { writes: [string, Record<string, unknown>][]; entries: Map<string, { kubernetesGroups: string[] }>; policies: Map<string, string[]> } {
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
    async listClusters() {
      if (denyList) throw denyList;
      return { clusters: clusters.map((c) => c.name) };
    },
    async describeCluster({ name }) {
      const found = clusters.find((c) => c.name === name);
      if (!found) throw Object.assign(new Error(`No cluster found for name: ${name}.`), { name: 'ResourceNotFoundException' });
      return { cluster: found };
    },
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
    async deleteAccessEntry(input) {
      if (!entries.has(key(input))) throw notFound();
      write('deleteAccessEntry', input);
      entries.delete(key(input));
      policies.delete(key(input));
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
