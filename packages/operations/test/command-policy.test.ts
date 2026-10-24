// The command role's policy against the calls the operations make in a member account (packaging design §5).
import { describe, expect, it } from 'vitest';
import { ACCOUNT, FORWARDER_CALLS, KUBE_PROXY_CALLS, KUBE_REGION, allows, clusterGroup, kubeFunction, proxyGroup, role, sharedVpc, vpc } from './command-policy.js';
import { ensureClusterAccess, removeClusterAccess, type EksPort } from '../src/cluster-access.js';

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

describe('the command role\'s Kubernetes proxies (R10.6)', () => {
  it('allows every call that creates, updates and removes a proxy', () => {
    for (const [action, resource, context] of KUBE_PROXY_CALLS) expect(allows(action, resource, context), `${action} ${resource}`).toBe(true);
  });

  it('touches only the security groups it tags, and the cluster groups EKS tags', () => {
    const group = (id: string) => `arn:aws:ec2:${KUBE_REGION}:${ACCOUNT}:security-group/${id}`;
    for (const action of ['ec2:RevokeSecurityGroupEgress', 'ec2:AuthorizeSecurityGroupEgress', 'ec2:DeleteSecurityGroup']) {
      expect(allows(action, proxyGroup), action).toBe(false);
      expect(allows(action, group('sg-0other'), { 'aws:ResourceTag/dormeto:role': 'something-else' }), action).toBe(false);
    }
    for (const action of ['ec2:AuthorizeSecurityGroupIngress', 'ec2:RevokeSecurityGroupIngress']) {
      expect(allows(action, clusterGroup), action).toBe(false);
      // The proxy's own group is not a cluster group, and tagged for the proxy it gets no ingress.
      expect(allows(action, proxyGroup, { 'aws:ResourceTag/dormeto:role': 'kubernetes-proxy' }), action).toBe(false);
    }
    // A group is created tagged for the proxy only, and tagged at creation only.
    expect(allows('ec2:CreateSecurityGroup', group('sg-new'))).toBe(false);
    expect(allows('ec2:CreateSecurityGroup', group('sg-new'), { 'aws:RequestTag/dormeto:role': 'other' })).toBe(false);
    expect(allows('ec2:CreateTags', proxyGroup)).toBe(false);
    expect(allows('ec2:CreateTags', proxyGroup, { 'ec2:CreateAction': 'RunInstances' })).toBe(false);
    expect(allows('ec2:CreateTags', `arn:aws:ec2:${KUBE_REGION}:${ACCOUNT}:instance/i-0abc`, { 'ec2:CreateAction': 'CreateSecurityGroup' })).toBe(false);
    expect(allows('ec2:DeleteVpc', vpc)).toBe(false);
  });

  // Ruling 25: CreateSecurityGroup is authorized against the VPC's ARN, which carries the VPC owner's account; a VPC shared
  // through RAM from a network account is another owner's (an account can only use its own VPCs and those shared with it).
  it('creates the proxy\'s group in a VPC another account shares with it, the group itself in its own account only', () => {
    expect(allows('ec2:CreateSecurityGroup', sharedVpc)).toBe(true);
    const otherGroup = `arn:aws:ec2:${KUBE_REGION}:333333333333:security-group/sg-0other0`;
    expect(allows('ec2:CreateSecurityGroup', otherGroup, { 'aws:RequestTag/dormeto:role': 'kubernetes-proxy' })).toBe(false);
    expect(allows('ec2:CreateTags', otherGroup, { 'ec2:CreateAction': 'CreateSecurityGroup' })).toBe(false);
    for (const action of ['ec2:RevokeSecurityGroupEgress', 'ec2:AuthorizeSecurityGroupEgress', 'ec2:DeleteSecurityGroup']) {
      expect(allows(action, otherGroup, { 'aws:ResourceTag/dormeto:role': 'kubernetes-proxy' }), action).toBe(false);
    }
    for (const action of ['ec2:AuthorizeSecurityGroupIngress', 'ec2:RevokeSecurityGroupIngress']) {
      expect(allows(action, otherGroup, { 'aws:ResourceTag/aws:eks:cluster-name': 'eks-demo' }), action).toBe(false);
    }
  });

  it('manages only the routers\' functions', () => {
    const other = `arn:aws:lambda:${KUBE_REGION}:${ACCOUNT}:function:customer-kube-eks-demo`;
    for (const action of ['lambda:CreateFunction', 'lambda:UpdateFunctionCode', 'lambda:DeleteFunction']) expect(allows(action, other), action).toBe(false);
    expect(allows('lambda:CreateFunction', kubeFunction)).toBe(true);
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
    // DmtDiscoveryRole only reads, through its view policy: never in a group (the final review's minor 9: a compromised
    // command role could have put it in dormeto:router).
    expect(allows('eks:CreateAccessEntry', cluster, { 'eks:principalArn': discovery, 'eks:kubernetesGroups': ['dormeto:router'] })).toBe(false);
    expect(allows('eks:CreateAccessEntry', cluster, { 'eks:principalArn': discovery, 'eks:kubernetesGroups': ['system:masters'] })).toBe(false);
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
      deleteAccessEntry: notFound,
      listAssociatedAccessPolicies: async () => ({ associatedAccessPolicies: [] }),
      associateAccessPolicy: record('eks:AssociateAccessPolicy', (i) => entry(i.principalArn.split('/').at(-1)), (i) => ({ 'eks:policyArn': i.policyArn, 'eks:accessScope': i.accessScope.type })),
    }, { routerRoles: [routerRole], discoveryRole: discovery });
    expect(calls.length).toBe(3);
    for (const [action, resource, context] of calls) expect(allows(action, resource, context), `${action} ${JSON.stringify(context)}`).toBe(true);
  });

  // The entry's ARN names the role without its path (read on dev-eks: access-entry/<cluster>/role/<account>/<name>/<id>).
  it('allows every call removing a router makes', async () => {
    const calls: [string, string][] = [];
    await removeClusterAccess({
      listClusters: async () => ({ clusters: ['eks-demo'] }),
      describeCluster: async () => ({ cluster: { accessConfig: { authenticationMode: 'API' } } }),
      deleteAccessEntry: async (i: { principalArn: string }) => { calls.push(['eks:DeleteAccessEntry', entry(i.principalArn.split('/').at(-1)!)]); return {}; },
    } as unknown as EksPort, { routerRoles: [routerRole] });
    expect(calls).toEqual([['eks:DeleteAccessEntry', entry('dmtr-dev-eu-west-1-controller')]]);
    for (const [action, resource] of calls) expect(allows(action, resource), action).toBe(true);
  });
});
