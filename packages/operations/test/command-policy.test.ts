// The command role's policy against the calls the operations make in a member account (packaging design §5).
import { describe, expect, it } from 'vitest';
import { ACCOUNT, FORWARDER_CALLS, allows, role } from './command-policy.js';
import { ensureClusterAccess } from '../src/cluster-access.js';

describe('the command role\'s policy', () => {
  it('allows every call the forwarder\'s installation and removal make, and passes router roles to EventBridge only as such', () => {
    for (const [action, resource, context] of FORWARDER_CALLS) expect(allows(action, resource, context), `${action} ${resource}`).toBe(true);
    // Never a role outside the routers' path, never to another service than those the routers use.
    expect(allows('iam:PassRole', `arn:aws:iam::${ACCOUNT}:role/Admin`, { 'iam:PassedToService': 'events.amazonaws.com' })).toBe(false);
    expect(allows('iam:PassRole', role, { 'iam:PassedToService': 'ec2.amazonaws.com' })).toBe(false);
    expect(allows('iam:CreateRole', role)).toBe(false);
    expect(allows('events:PutRule', `arn:aws:events:eu-west-3:${ACCOUNT}:rule/customer-rule`)).toBe(false);
  });
});

describe('the command role\'s EKS access entries (Kubernetes workloads, R10.5)', () => {
  const cluster = `arn:aws:eks:eu-west-1:${ACCOUNT}:cluster/eks-demo`;
  const routerRole = `arn:aws:iam::${ACCOUNT}:role/dormeto/router/dmtr-dev-eu-west-1-controller`;
  const discovery = `arn:aws:iam::${ACCOUNT}:role/DmtDiscoveryRole`;
  const entry = (name: string) => `arn:aws:eks:eu-west-1:${ACCOUNT}:access-entry/eks-demo/role/${ACCOUNT}/${name}/8ec7a1b2`;
  const VIEW = 'arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy';

  it('creates the entries of the router roles in the group dormeto:router and of DmtDiscoveryRole, nothing else', () => {
    expect(allows('eks:CreateAccessEntry', cluster, { 'eks:principalArn': routerRole, 'eks:kubernetesGroups': ['dormeto:router'] })).toBe(true);
    expect(allows('eks:CreateAccessEntry', cluster, { 'eks:principalArn': discovery })).toBe(true);
    expect(allows('eks:CreateAccessEntry', cluster, { 'eks:principalArn': routerRole, 'eks:kubernetesGroups': ['system:masters'] })).toBe(false);
    expect(allows('eks:CreateAccessEntry', cluster, { 'eks:principalArn': routerRole, 'eks:kubernetesGroups': ['dormeto:router', 'system:masters'] })).toBe(false);
    expect(allows('eks:CreateAccessEntry', cluster, { 'eks:principalArn': `arn:aws:iam::${ACCOUNT}:role/Admin`, 'eks:kubernetesGroups': ['dormeto:router'] })).toBe(false);
    expect(allows('eks:CreateAccessEntry', `arn:aws:eks:eu-west-1:999999999999:cluster/other`, { 'eks:principalArn': routerRole, 'eks:kubernetesGroups': ['dormeto:router'] })).toBe(false);
  });

  it('gives DmtDiscoveryRole the view policy, cluster-wide, and no other policy to anyone', () => {
    expect(allows('eks:AssociateAccessPolicy', entry('DmtDiscoveryRole'), { 'eks:policyArn': VIEW, 'eks:accessScope': 'cluster' })).toBe(true);
    expect(allows('eks:AssociateAccessPolicy', entry('DmtDiscoveryRole'), { 'eks:policyArn': 'arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy', 'eks:accessScope': 'cluster' })).toBe(false);
    expect(allows('eks:AssociateAccessPolicy', entry('dmtr-dev-eu-west-1-controller'), { 'eks:policyArn': VIEW, 'eks:accessScope': 'cluster' })).toBe(false);
  });

  it('removes only the entries of the router roles and DmtDiscoveryRole, and reads clusters and entries', () => {
    expect(allows('eks:DeleteAccessEntry', entry('dmtr-dev-eu-west-1-controller'))).toBe(true);
    expect(allows('eks:DeleteAccessEntry', entry('DmtDiscoveryRole'))).toBe(true);
    expect(allows('eks:DeleteAccessEntry', entry('Admin'))).toBe(false);
    for (const action of ['eks:ListClusters', 'eks:DescribeCluster', 'eks:DescribeAccessEntry', 'eks:ListAssociatedAccessPolicies']) expect(allows(action, cluster), action).toBe(true);
  });

  it('allows every call the access entries step makes', async () => {
    const calls: [string, string, Record<string, string | string[]>][] = [];
    const record = (action: string, resource: (i: any) => string, context: (i: any) => Record<string, string | string[]> = () => ({})) => async (i: any) => { calls.push([action, resource(i), context(i)]); return {}; };
    const notFound = async () => { throw Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' }); };
    await ensureClusterAccess({
      listClusters: async () => ({ clusters: ['eks-demo'] }),
      describeCluster: async () => ({ cluster: { accessConfig: { authenticationMode: 'API' }, resourcesVpcConfig: { endpointPublicAccess: true, publicAccessCidrs: ['0.0.0.0/0'] } } }),
      describeAccessEntry: notFound,
      createAccessEntry: record('eks:CreateAccessEntry', () => cluster, (i) => ({ 'eks:principalArn': i.principalArn, ...(i.kubernetesGroups ? { 'eks:kubernetesGroups': i.kubernetesGroups } : {}) })),
      listAssociatedAccessPolicies: async () => ({ associatedAccessPolicies: [] }),
      associateAccessPolicy: record('eks:AssociateAccessPolicy', (i) => entry(i.principalArn.split('/').at(-1)), (i) => ({ 'eks:policyArn': i.policyArn, 'eks:accessScope': i.accessScope.type })),
    }, { routerRoles: [routerRole], discoveryRole: discovery });
    expect(calls.length).toBe(3);
    for (const [action, resource, context] of calls) expect(allows(action, resource, context), `${action} ${JSON.stringify(context)}`).toBe(true);
  });
});
