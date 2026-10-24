// Lambda, IAM, CloudWatch Logs and EC2 of an account and region as the Kubernetes proxies step calls them
// (src/kube-proxies.ts), with the clusters' EKS: a new or updated function Pending (or its update InProgress) for one
// read, network interfaces made once it is Active and released some reads after its deletion, a new role Lambda cannot
// assume at first, and the errors EC2 answers. Every call is recorded as the IAM action, resource and condition context
// the command role's policy is evaluated on (test/command-policy.ts, KUBE_PROXY_CALLS).
import { createHash } from 'node:crypto';
import type { KubeProxyPorts } from '../src/kube-proxies.js';
import { ACCOUNT } from './command-policy.js';
import { fakeEks, type cluster as eksCluster } from './eks-fake.js';

const REGION = 'eu-west-1';
const error = (name: string, message = name) => Object.assign(new Error(message), { name });
const sha = (zip: Uint8Array) => createHash('sha256').update(zip).digest('base64');
const tagMap = (tags: { Key: string; Value: string }[] = []) => Object.fromEntries(tags.map((t) => [t.Key, t.Value]));

// One rule per protocol, ports and source or destination, as EC2 keeps them.
export interface Rule { IpProtocol: string; FromPort?: number; ToPort?: number; CidrIp?: string; CidrIpv6?: string; GroupId?: string; Description?: string }
interface Group { GroupId: string; GroupName: string; VpcId: string; Description: string; Tags: Record<string, string>; ingress: Rule[]; egress: Rule[] }
interface Fn { config: Record<string, any>; tags: Record<string, string>; reads: number; failure?: { code: string; reason: string } }
type Cluster = ReturnType<typeof eksCluster>;
type Call = [string, string, Record<string, string>?];

export const arns = {
  fn: (name: string) => `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${name}`,
  role: (name: string) => `arn:aws:iam::${ACCOUNT}:role/dormeto/router/${name}`,
  logGroup: (name: string) => `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:${name}`,
  vpc: (id: string) => `arn:aws:ec2:${REGION}:${ACCOUNT}:vpc/${id}`,
  group: (id: string) => `arn:aws:ec2:${REGION}:${ACCOUNT}:security-group/${id}`,
};

// Rules of IpPermissions, one per source or destination.
const rulesOf = (permissions: any[]): Rule[] => permissions.flatMap((p) => {
  const base = { IpProtocol: String(p.IpProtocol), ...(p.FromPort !== undefined ? { FromPort: p.FromPort, ToPort: p.ToPort } : {}) };
  return [
    ...(p.IpRanges ?? []).map((r: any) => ({ ...base, CidrIp: r.CidrIp, ...(r.Description ? { Description: r.Description } : {}) })),
    ...(p.Ipv6Ranges ?? []).map((r: any) => ({ ...base, CidrIpv6: r.CidrIpv6, ...(r.Description ? { Description: r.Description } : {}) })),
    ...(p.UserIdGroupPairs ?? []).map((r: any) => ({ ...base, GroupId: r.GroupId, ...(r.Description ? { Description: r.Description } : {}) })),
  ];
});
// As EC2 answers them: rules of the same protocol and ports in one permission.
const permissionsOf = (rules: Rule[]) => {
  const byPorts = new Map<string, any>();
  for (const r of rules) {
    const key = `${r.IpProtocol} ${r.FromPort} ${r.ToPort}`;
    const p = byPorts.get(key) ?? { IpProtocol: r.IpProtocol, ...(r.FromPort !== undefined ? { FromPort: r.FromPort, ToPort: r.ToPort } : {}), IpRanges: [], Ipv6Ranges: [], PrefixListIds: [], UserIdGroupPairs: [] };
    const description = r.Description ? { Description: r.Description } : {};
    if (r.CidrIp) p.IpRanges.push({ CidrIp: r.CidrIp, ...description });
    if (r.CidrIpv6) p.Ipv6Ranges.push({ CidrIpv6: r.CidrIpv6, ...description });
    if (r.GroupId) p.UserIdGroupPairs.push({ GroupId: r.GroupId, UserId: ACCOUNT, ...description });
    byPorts.set(key, p);
  }
  return [...byPorts.values()];
};
// EC2 refuses a rule description with other characters (AWS: a-z, A-Z, 0-9, spaces, and ._-:/()#,@[]+=&;{}!$*).
const checkDescriptions = (rules: Rule[]) => {
  const bad = rules.find((r) => r.Description !== undefined && !/^[a-zA-Z0-9 ._\-:/()#,@[\]+=&;{}!$*]{0,255}$/.test(r.Description));
  if (bad) throw error('InvalidParameterValue', `Invalid rule description. Valid descriptions are strings less than 256 characters from the following set:  a-zA-Z0-9. _-:/()#,@[]+=&;{}!$*: ${bad.Description}`);
};
const sameRule = (a: Rule, b: Rule) => a.IpProtocol === b.IpProtocol && a.FromPort === b.FromPort && a.ToPort === b.ToPort && a.CidrIp === b.CidrIp && a.CidrIpv6 === b.CidrIpv6 && a.GroupId === b.GroupId;

export function fakeKubeAccount(clusters: Cluster[], { now = () => Date.now() }: { now?: () => number } = {}) {
  const state = {
    groups: new Map<string, Group>(),
    // The VPCs' IPv4 blocks (the proxy's egress, spec section 4): vpc-0a1b2c3d has a secondary block, and one disassociated.
    vpcs: new Map<string, { CidrBlock: string; State: string }[]>(),
    functions: new Map<string, Fn>(),
    roles: new Map<string, { path: string; trust: string; boundary?: string; tags: Record<string, string>; policies: Map<string, string> }>(),
    logGroups: new Map<string, { retention?: number; tags: Record<string, string> }>(),
    // Network interfaces by id: the group they are in, and for those of a deleted function the reads left before Lambda
    // releases them.
    interfaces: new Map<string, { groupId: string; function: string; releaseIn?: number }>(),
    newRoles: new Set<string>(), // roles Lambda cannot assume yet (one failed CreateFunction each)
    pendingReads: 1, // reads a new function stays Pending, an update InProgress
    releaseReads: 1, // DescribeNetworkInterfaces reads before a deleted function's interfaces are released
    held: new Set<string>(), // functions whose interfaces Lambda does not release (yet)
    ipv6: false, // the VPC has an IPv6 block: a new group's default egress has ::/0 too
    failNext: null as null | { code: string; reason: string }, // the next new function ends Failed
    failing: new Map<string, { code: string; reason: string }>(), // by function name: each time it is made, it ends Failed
    deny: {} as Record<string, Error>, // by port method: refused (UnauthorizedOperation, AccessDenied)
    calls: [] as Call[], // as IAM evaluates them
    ops: [] as string[], // the port methods called, in order
    proxyGroups: 0,
    eni: 0,
  };
  const record = (op: string, ...calls: Call[]) => {
    state.ops.push(op);
    state.calls.push(...calls);
    if (state.deny[op]) throw state.deny[op];
  };
  // The cluster security group EKS makes (tagged with its cluster's name), admitting its own members.
  const addClusterGroup = (c: Cluster) => {
    const id = c.resourcesVpcConfig.clusterSecurityGroupId;
    if (!state.vpcs.has(c.resourcesVpcConfig.vpcId)) {
      state.vpcs.set(c.resourcesVpcConfig.vpcId, c.resourcesVpcConfig.vpcId === 'vpc-0a1b2c3d'
        ? [{ CidrBlock: '10.0.0.0/16', State: 'associated' }, { CidrBlock: '100.64.0.0/16', State: 'associated' }, { CidrBlock: '10.99.0.0/16', State: 'disassociated' }]
        : [{ CidrBlock: '10.1.0.0/16', State: 'associated' }]);
    }
    state.groups.set(id, { GroupId: id, GroupName: `eks-cluster-sg-${c.name}`, VpcId: c.resourcesVpcConfig.vpcId, Description: 'EKS created security group', Tags: { 'aws:eks:cluster-name': c.name }, ingress: [{ IpProtocol: '-1', GroupId: id }], egress: [{ IpProtocol: '-1', CidrIp: '0.0.0.0/0' }] });
  };
  for (const c of clusters) addClusterGroup(c);
  const groupOf = (id: string) => {
    const g = state.groups.get(id);
    if (!g) throw error('InvalidGroup.NotFound', `The security group '${id}' does not exist`);
    return g;
  };
  const tagged = (g: Group | undefined, key: string): Record<string, string> => (g?.Tags[key] !== undefined ? { [`aws:ResourceTag/${key}`]: g.Tags[key]! } : {});
  const roleContext = (name: string) => ({ 'iam:PermissionsBoundary': state.roles.get(name)?.boundary ?? '' });
  // Lambda reads the network of a function's VPC configuration with the caller's rights.
  const networkReads: Call[] = [['ec2:DescribeSecurityGroups', '*'], ['ec2:DescribeSubnets', '*'], ['ec2:DescribeVpcs', '*']];

  // A function that settles: Pending (or InProgress) for some reads, then Active with its interfaces, or Failed.
  function settle(f: Fn) {
    const c = f.config;
    if (c.State !== 'Pending' && c.LastUpdateStatus !== 'InProgress') return;
    if (f.reads > 0) {
      f.reads -= 1;
      return;
    }
    if (c.State === 'Pending' && f.failure) {
      Object.assign(c, { State: 'Failed', StateReason: f.failure.reason, StateReasonCode: f.failure.code, LastUpdateStatus: 'Failed' });
      return;
    }
    Object.assign(c, { State: 'Active', LastUpdateStatus: 'Successful' });
    for (const key of ['StateReason', 'StateReasonCode', 'LastUpdateStatusReason', 'LastUpdateStatusReasonCode']) delete c[key];
    const groupId = c.VpcConfig.SecurityGroupIds[0];
    for (const [id, eni] of state.interfaces) if (eni.function === c.FunctionName && eni.groupId !== groupId && eni.releaseIn === undefined) state.interfaces.set(id, { ...eni, releaseIn: state.releaseReads });
    if (![...state.interfaces.values()].some((eni) => eni.function === c.FunctionName && eni.groupId === groupId && eni.releaseIn === undefined)) {
      for (const _subnet of c.VpcConfig.SubnetIds) state.interfaces.set(`eni-0${(++state.eni).toString(16).padStart(5, '0')}`, { groupId, function: c.FunctionName });
    }
  }
  function checkVpc(vpc: { SubnetIds: string[]; SecurityGroupIds: string[] }) {
    for (const id of vpc.SecurityGroupIds) groupOf(id);
  }

  const ec2: KubeProxyPorts['ec2'] = {
    async describeSecurityGroups({ GroupIds, Filters = [] }) {
      record('describeSecurityGroups', ['ec2:DescribeSecurityGroups', '*']);
      const filter = (name: string) => (Filters as { Name: string; Values: string[] }[]).find((f) => f.Name === name)?.Values;
      // By ids, a missing group is an error; by filters, it is not listed.
      const groups = GroupIds ? (GroupIds as string[]).map(groupOf) : [...state.groups.values()]
        .filter((g) => (!filter('vpc-id') || filter('vpc-id')!.includes(g.VpcId)) && (!filter('group-name') || filter('group-name')!.includes(g.GroupName))
          && (!filter('group-id') || filter('group-id')!.includes(g.GroupId)));
      return { SecurityGroups: groups.map((g) => ({
        GroupId: g.GroupId, GroupName: g.GroupName, VpcId: g.VpcId, Description: g.Description, OwnerId: ACCOUNT,
        Tags: Object.entries(g.Tags).map(([Key, Value]) => ({ Key, Value })), IpPermissions: permissionsOf(g.ingress), IpPermissionsEgress: permissionsOf(g.egress),
      })) };
    },
    async describeVpcs({ VpcIds }) {
      record('describeVpcs', ['ec2:DescribeVpcs', '*']);
      return { Vpcs: (VpcIds as string[]).map((VpcId) => {
        const blocks = state.vpcs.get(VpcId);
        if (!blocks) throw error('InvalidVpcID.NotFound', `The vpc ID '${VpcId}' does not exist`);
        return { VpcId, CidrBlock: blocks[0]!.CidrBlock, CidrBlockAssociationSet: blocks.map((b, i) => ({ AssociationId: `vpc-cidr-assoc-0${i}`, CidrBlock: b.CidrBlock, CidrBlockState: { State: b.State } })) };
      }) };
    },
    async createSecurityGroup({ GroupName, Description, VpcId, TagSpecifications = [] }) {
      const tags = tagMap((TagSpecifications as { ResourceType: string; Tags: { Key: string; Value: string }[] }[]).find((t) => t.ResourceType === 'security-group')?.Tags);
      const GroupId = `sg-0proxy${String(state.proxyGroups).padStart(3, '0')}`;
      record('createSecurityGroup', ['ec2:CreateSecurityGroup', arns.vpc(VpcId)],
        ['ec2:CreateSecurityGroup', arns.group(GroupId), tags['dormeto:role'] !== undefined ? { 'aws:RequestTag/dormeto:role': tags['dormeto:role'] } : {}],
        ...(Object.keys(tags).length ? [['ec2:CreateTags', arns.group(GroupId), { 'ec2:CreateAction': 'CreateSecurityGroup' }] as Call] : []));
      if ([...state.groups.values()].some((g) => g.VpcId === VpcId && g.GroupName === GroupName)) throw error('InvalidGroup.Duplicate', `The security group '${GroupName}' already exists for VPC '${VpcId}'`);
      state.proxyGroups += 1;
      state.groups.set(GroupId, {
        GroupId, GroupName, VpcId, Description, Tags: tags, ingress: [],
        egress: [{ IpProtocol: '-1', CidrIp: '0.0.0.0/0' }, ...(state.ipv6 ? [{ IpProtocol: '-1', CidrIpv6: '::/0' }] : [])],
      });
      return { GroupId };
    },
    async authorizeSecurityGroupEgress({ GroupId, IpPermissions }) {
      record('authorizeSecurityGroupEgress', ['ec2:AuthorizeSecurityGroupEgress', arns.group(GroupId), tagged(state.groups.get(GroupId), 'dormeto:role')]);
      const g = groupOf(GroupId);
      const rules = rulesOf(IpPermissions);
      checkDescriptions(rules);
      for (const r of rules) if (r.GroupId) groupOf(r.GroupId);
      if (rules.some((r) => g.egress.some((e) => sameRule(e, r)))) throw error('InvalidPermission.Duplicate', 'the specified rule already exists');
      g.egress.push(...rules);
      return { Return: true };
    },
    async revokeSecurityGroupEgress({ GroupId, IpPermissions }) {
      record('revokeSecurityGroupEgress', ['ec2:RevokeSecurityGroupEgress', arns.group(GroupId), tagged(state.groups.get(GroupId), 'dormeto:role')]);
      const g = groupOf(GroupId);
      const rules = rulesOf(IpPermissions);
      if (!rules.every((r) => g.egress.some((e) => sameRule(e, r)))) throw error('InvalidPermission.NotFound', 'The specified rule does not exist in this security group.');
      g.egress = g.egress.filter((e) => !rules.some((r) => sameRule(e, r)));
      return { Return: true };
    },
    async authorizeSecurityGroupIngress({ GroupId, IpPermissions }) {
      record('authorizeSecurityGroupIngress', ['ec2:AuthorizeSecurityGroupIngress', arns.group(GroupId), tagged(state.groups.get(GroupId), 'aws:eks:cluster-name')]);
      const g = groupOf(GroupId);
      const rules = rulesOf(IpPermissions);
      checkDescriptions(rules);
      for (const r of rules) if (r.GroupId) groupOf(r.GroupId);
      if (rules.some((r) => g.ingress.some((e) => sameRule(e, r)))) throw error('InvalidPermission.Duplicate', 'the specified rule already exists');
      g.ingress.push(...rules);
      return { Return: true };
    },
    async revokeSecurityGroupIngress({ GroupId, IpPermissions }) {
      record('revokeSecurityGroupIngress', ['ec2:RevokeSecurityGroupIngress', arns.group(GroupId), tagged(state.groups.get(GroupId), 'aws:eks:cluster-name')]);
      const g = groupOf(GroupId);
      const rules = rulesOf(IpPermissions);
      if (!rules.every((r) => g.ingress.some((e) => sameRule(e, r)))) throw error('InvalidPermission.NotFound', 'The specified rule does not exist in this security group.');
      g.ingress = g.ingress.filter((e) => !rules.some((r) => sameRule(e, r)));
      return { Return: true };
    },
    async deleteSecurityGroup({ GroupId }) {
      record('deleteSecurityGroup', ['ec2:DeleteSecurityGroup', arns.group(GroupId), tagged(state.groups.get(GroupId), 'dormeto:role')]);
      groupOf(GroupId);
      const referenced = [...state.groups.values()].some((g) => g.GroupId !== GroupId && [...g.ingress, ...g.egress].some((r) => r.GroupId === GroupId));
      if (referenced || [...state.interfaces.values()].some((eni) => eni.groupId === GroupId)) throw error('DependencyViolation', `resource ${GroupId} has a dependent object`);
      state.groups.delete(GroupId);
      return {};
    },
    async describeNetworkInterfaces({ Filters = [] }) {
      record('describeNetworkInterfaces', ['ec2:DescribeNetworkInterfaces', '*']);
      for (const [id, eni] of state.interfaces) {
        if (eni.releaseIn === undefined || state.held.has(eni.function)) continue;
        if (eni.releaseIn <= 0) state.interfaces.delete(id);
        else eni.releaseIn -= 1;
      }
      const groups = (Filters as { Name: string; Values: string[] }[]).find((f) => f.Name === 'group-id')?.Values ?? [];
      return { NetworkInterfaces: [...state.interfaces].filter(([, eni]) => !groups.length || groups.includes(eni.groupId))
        .map(([NetworkInterfaceId, eni]) => ({ NetworkInterfaceId, InterfaceType: 'lambda', Status: 'in-use', Groups: [{ GroupId: eni.groupId }] })) };
    },
  };

  const lambda: KubeProxyPorts['lambda'] = {
    async getFunctionConfiguration({ FunctionName }) {
      record('getFunctionConfiguration', ['lambda:GetFunctionConfiguration', arns.fn(FunctionName)]);
      const f = state.functions.get(FunctionName);
      if (!f) throw error('ResourceNotFoundException', `Function not found: ${arns.fn(FunctionName)}`);
      settle(f);
      // Lambda answers the environment in its own order, and the VPC's id with the subnets and groups.
      const variables = Object.fromEntries(Object.entries(f.config.Environment?.Variables ?? {}).reverse());
      return structuredClone({ ...f.config, Environment: { Variables: variables }, VpcConfig: { ...f.config.VpcConfig, SubnetIds: [...f.config.VpcConfig.SubnetIds].reverse(), VpcId: groupOf(f.config.VpcConfig.SecurityGroupIds[0]).VpcId } });
    },
    async createFunction(input) {
      const fn = String(input.FunctionName);
      record('createFunction', ['lambda:CreateFunction', arns.fn(fn)], ...(input.Tags ? [['lambda:TagResource', arns.fn(fn)] as Call] : []),
        ['iam:PassRole', input.Role, { 'iam:PassedToService': 'lambda.amazonaws.com' }], ...(input.VpcConfig ? networkReads : []));
      if (state.functions.has(fn)) throw error('ResourceConflictException', `Function already exist: ${fn}`);
      const role = String(input.Role).split('/').at(-1)!;
      if (state.newRoles.delete(role)) throw error('InvalidParameterValueException', 'The role defined for the function cannot be assumed by Lambda.');
      checkVpc(input.VpcConfig);
      const { Code, Tags, ...config } = input;
      state.functions.set(fn, {
        config: { ...structuredClone(config), FunctionArn: arns.fn(fn), CodeSha256: sha(Code.ZipFile), State: 'Pending', StateReason: 'The function is being created.', StateReasonCode: 'Creating', LastUpdateStatus: 'InProgress', LastModified: new Date(now()).toISOString().replace('Z', '+0000') },
        tags: { ...Tags }, reads: state.pendingReads, ...((state.failing.get(fn) ?? state.failNext) ? { failure: state.failing.get(fn) ?? state.failNext! } : {}),
      });
      state.failNext = null;
      return {};
    },
    async updateFunctionConfiguration(input) {
      const fn = String(input.FunctionName);
      record('updateFunctionConfiguration', ['lambda:UpdateFunctionConfiguration', arns.fn(fn)], ...(input.Role ? [['iam:PassRole', input.Role, { 'iam:PassedToService': 'lambda.amazonaws.com' }] as Call] : []), ...(input.VpcConfig ? networkReads : []));
      const f = state.functions.get(fn);
      if (!f) throw error('ResourceNotFoundException');
      if (f.config.State === 'Pending' || f.config.LastUpdateStatus === 'InProgress') throw error('ResourceConflictException', `The operation cannot be performed at this time. An update is in progress for resource: ${arns.fn(fn)}`);
      if (input.VpcConfig) checkVpc(input.VpcConfig);
      Object.assign(f.config, structuredClone(input), { LastUpdateStatus: 'InProgress', LastUpdateStatusReason: 'The function is being updated.', LastUpdateStatusReasonCode: 'Updating', LastModified: new Date(now()).toISOString().replace('Z', '+0000') });
      f.reads = state.pendingReads;
      return {};
    },
    async updateFunctionCode({ FunctionName, ZipFile }) {
      record('updateFunctionCode', ['lambda:UpdateFunctionCode', arns.fn(FunctionName)]);
      const f = state.functions.get(FunctionName);
      if (!f) throw error('ResourceNotFoundException');
      if (f.config.State === 'Pending' || f.config.LastUpdateStatus === 'InProgress') throw error('ResourceConflictException', `The operation cannot be performed at this time. An update is in progress for resource: ${arns.fn(FunctionName)}`);
      Object.assign(f.config, { CodeSha256: sha(ZipFile), LastUpdateStatus: 'InProgress', LastModified: new Date(now()).toISOString().replace('Z', '+0000') });
      f.reads = state.pendingReads;
      return {};
    },
    async deleteFunction({ FunctionName }) {
      record('deleteFunction', ['lambda:DeleteFunction', arns.fn(FunctionName)]);
      if (!state.functions.delete(FunctionName)) throw error('ResourceNotFoundException', `Function not found: ${arns.fn(FunctionName)}`);
      for (const eni of state.interfaces.values()) if (eni.function === FunctionName && eni.releaseIn === undefined) eni.releaseIn = state.releaseReads;
      return {};
    },
  };

  const iam: KubeProxyPorts['iam'] = {
    async getRole({ RoleName }) {
      record('getRole', ['iam:GetRole', arns.role(RoleName)]);
      const r = state.roles.get(RoleName);
      if (!r) throw error('NoSuchEntityException', `The role with name ${RoleName} cannot be found.`);
      return { Role: { RoleName, Path: r.path, Arn: arns.role(RoleName), AssumeRolePolicyDocument: encodeURIComponent(r.trust), ...(r.boundary ? { PermissionsBoundary: { PermissionsBoundaryArn: r.boundary } } : {}) } };
    },
    async createRole({ RoleName, Path, AssumeRolePolicyDocument, PermissionsBoundary, Tags = [] }) {
      record('createRole', ['iam:CreateRole', arns.role(RoleName), { 'iam:PermissionsBoundary': PermissionsBoundary }], ...(Tags.length ? [['iam:TagRole', arns.role(RoleName)] as Call] : []));
      state.roles.set(RoleName, { path: Path, trust: AssumeRolePolicyDocument, boundary: PermissionsBoundary, tags: tagMap(Tags), policies: new Map() });
      state.newRoles.add(RoleName);
      return {};
    },
    async updateAssumeRolePolicy({ RoleName, PolicyDocument }) {
      record('updateAssumeRolePolicy', ['iam:UpdateAssumeRolePolicy', arns.role(RoleName)]);
      state.roles.get(RoleName)!.trust = PolicyDocument;
      return {};
    },
    async getRolePolicy({ RoleName, PolicyName }) {
      record('getRolePolicy', ['iam:GetRolePolicy', arns.role(RoleName)]);
      const doc = state.roles.get(RoleName)?.policies.get(PolicyName);
      if (!doc) throw error('NoSuchEntityException');
      return { PolicyDocument: encodeURIComponent(doc) };
    },
    async putRolePolicy({ RoleName, PolicyName, PolicyDocument }) {
      record('putRolePolicy', ['iam:PutRolePolicy', arns.role(RoleName), roleContext(RoleName)]);
      state.roles.get(RoleName)!.policies.set(PolicyName, PolicyDocument);
      return {};
    },
    async listRolePolicies({ RoleName }) {
      record('listRolePolicies', ['iam:ListRolePolicies', arns.role(RoleName)]);
      const r = state.roles.get(RoleName);
      if (!r) throw error('NoSuchEntityException');
      return { PolicyNames: [...r.policies.keys()] };
    },
    async deleteRolePolicy({ RoleName, PolicyName }) {
      record('deleteRolePolicy', ['iam:DeleteRolePolicy', arns.role(RoleName), roleContext(RoleName)]);
      state.roles.get(RoleName)!.policies.delete(PolicyName);
      return {};
    },
    async deleteRole({ RoleName }) {
      record('deleteRole', ['iam:DeleteRole', arns.role(RoleName)]);
      const r = state.roles.get(RoleName);
      if (!r) throw error('NoSuchEntityException');
      if (r.policies.size) throw error('DeleteConflictException', 'Cannot delete entity, must delete policies first.');
      state.roles.delete(RoleName);
      return {};
    },
  };

  const logs: KubeProxyPorts['logs'] = {
    async describeLogGroups({ logGroupNamePrefix }) {
      record('describeLogGroups', ['logs:DescribeLogGroups', '*']);
      return { logGroups: [...state.logGroups].filter(([n]) => n.startsWith(logGroupNamePrefix)).map(([logGroupName, g]) => ({ logGroupName, ...(g.retention ? { retentionInDays: g.retention } : {}) })) };
    },
    async createLogGroup({ logGroupName, tags }) {
      record('createLogGroup', ['logs:CreateLogGroup', arns.logGroup(logGroupName)], ...(tags ? [['logs:TagResource', arns.logGroup(logGroupName)] as Call] : []));
      if (state.logGroups.has(logGroupName)) throw error('ResourceAlreadyExistsException');
      state.logGroups.set(logGroupName, { tags: { ...tags } });
      return {};
    },
    async putRetentionPolicy({ logGroupName, retentionInDays }) {
      record('putRetentionPolicy', ['logs:PutRetentionPolicy', arns.logGroup(logGroupName)]);
      state.logGroups.get(logGroupName)!.retention = retentionInDays;
      return {};
    },
    async deleteLogGroup({ logGroupName }) {
      record('deleteLogGroup', ['logs:DeleteLogGroup', arns.logGroup(logGroupName)]);
      if (!state.logGroups.delete(logGroupName)) throw error('ResourceNotFoundException', 'The specified log group does not exist.');
      return {};
    },
  };

  const eks = fakeEks(clusters);
  const ports: KubeProxyPorts = { lambda, iam, logs, ec2, eks };
  // The writes among the port methods called (what changed something).
  const writes = () => state.ops.filter((op) => !/^(describe|get|list)/.test(op));
  return { state, ports, eks, writes, addClusterGroup };
}
