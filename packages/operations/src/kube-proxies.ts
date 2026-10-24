// The Kubernetes proxies of a router the manager installed (vision docs/specs/2026-10-24-private-eks-endpoints-design.md,
// sections 4 and 6): for each EKS cluster of the router's account and region whose endpoint is private (reachOf = proxy),
// a small Lambda function in the cluster's VPC relays the router's and discovery's Kubernetes calls. The router's blueprint
// defines it (kubeProxy: handler, runtime, memory, timeout, role policy); this applies it per cluster by API calls of
// DmtCommandRole, each run finding what exists (named from the cluster by the router's rule) before creating or updating
// it, so that a run can come again. The proxies made are recorded with the router (InstalledRouter.proxies) and removed
// from that record: a cluster opened to every address, out of reach, gone, made again in another VPC, or the router
// uninstalled. Order: the security group first (a command role without the organization access of manager 0.20.0 refuses
// it before anything is made), the rule on the cluster security group, the role, the log group, the function; a removal
// deletes the function, waits until Lambda released its network interfaces, then revokes the rule and deletes the group,
// the role and the log group.
import type { Policy } from './blueprint.js';
import { reachOf, UNREACHABLE, type EksPort } from './cluster-access.js';
import { RetryLater, deleteRole, find, putRole, same, tagList } from './installer.js';
// @ts-expect-error the router's module has no type declarations
import { kubeProxyName as routerKubeProxyName } from '../../../../router/lambda/src/lib/kube-proxy-name.mjs';

// Loose SDK shapes: the adapters (aws.ts) pass the commands' inputs and outputs through.
type Call = (input: any) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export interface KubeProxyPorts {
  lambda: Record<'getFunctionConfiguration' | 'createFunction' | 'updateFunctionConfiguration' | 'updateFunctionCode' | 'deleteFunction', Call>;
  iam: Record<'getRole' | 'createRole' | 'updateAssumeRolePolicy' | 'getRolePolicy' | 'putRolePolicy' | 'listRolePolicies' | 'deleteRolePolicy' | 'deleteRole', Call>;
  logs: Record<'describeLogGroups' | 'createLogGroup' | 'putRetentionPolicy' | 'deleteLogGroup', Call>;
  ec2: Record<'describeSecurityGroups' | 'createSecurityGroup' | 'authorizeSecurityGroupEgress' | 'revokeSecurityGroupEgress' | 'authorizeSecurityGroupIngress' | 'revokeSecurityGroupIngress'
    | 'deleteSecurityGroup' | 'describeNetworkInterfaces', Call>;
  eks: Pick<EksPort, 'listClusters' | 'describeCluster'>;
}

// The router blueprint's kubeProxy (routers 0.33.0 and later), filled for the router.
export interface KubeProxy {
  handler: string; runtime: string; architectures: string[]; memory: number; timeout: number; logRetentionDays: number;
  environment: Record<string, string>; tags: Record<string, string>; namePrefix: string; rolePrefix: string; rolePolicy: Policy;
}

// A proxy the manager made, as the router's record keeps it (securityGroupId null until its group exists).
export interface ProxyRecord {
  cluster: string;
  function: string;
  role: string;
  logGroup: string;
  securityGroupId: string | null;
  clusterSecurityGroupId: string;
  vpcId: string;
}

// pending: the step comes back after `seconds` (the function not Active yet, network interfaces not released yet);
// changed: something was made or removed by this run.
export interface ProxyOutcome { cluster: string; status: 'done' | 'skipped' | 'pending'; detail: string; seconds?: number; changed?: boolean }

// The command role refuses the proxies' calls (an organization access older than manager 0.20.0); clusters: those whose
// endpoint needs a proxy.
export class KubeProxyAccessDenied extends Error {
  override name = 'KubeProxyAccessDenied';
  constructor(message: string, readonly clusters: string[]) {
    super(message);
  }
}

export const kubeProxyName = routerKubeProxyName as (prefix: string, cluster: string) => string;
const ROLE_PATH = '/dormeto/router/';
const PENDING_SECONDS = 10;
const RELEASE_SECONDS = 30;
// Lambda can take minutes to release a deleted VPC function's network interfaces: waited for up to an hour.
const RELEASE_MAX_MS = 60 * 60_000;
const ORGANIZATION_ACCESS = 'apply the organization access of manager 0.20.0';

// The records an error leaves behind (what was made before it): the step keeps them, a later run removes them.
const PROXIES = Symbol('proxies');
const withProxies = (err: unknown, proxies: ProxyRecord[]) => {
  if (err && typeof err === 'object') Object.assign(err, { [PROXIES]: proxies });
  return err;
};
export const proxiesOf = (err: unknown): ProxyRecord[] | undefined => (err && typeof err === 'object' ? (err as { [PROXIES]?: ProxyRecord[] })[PROXIES] : undefined);

const named = (err: unknown, ...names: string[]) => names.includes((err as Error).name);
const denied = (err: unknown) => /^(UnauthorizedOperation|AccessDenied)/.test((err as Error).name ?? '') || /not authorized/i.test((err as Error).message ?? '');

// Security group rules, one per source or destination (EC2 groups them by protocol and ports).
type Rule = { IpProtocol: string; FromPort?: number; ToPort?: number; CidrIp?: string; CidrIpv6?: string; PrefixListId?: string; GroupId?: string };
const rulesOf = (permissions: any[] = []): Rule[] => permissions.flatMap((p) => { // eslint-disable-line @typescript-eslint/no-explicit-any
  const base = { IpProtocol: String(p.IpProtocol), ...(p.FromPort !== undefined ? { FromPort: p.FromPort, ToPort: p.ToPort } : {}) };
  return [
    ...(p.IpRanges ?? []).map((r: { CidrIp: string }) => ({ ...base, CidrIp: r.CidrIp })),
    ...(p.Ipv6Ranges ?? []).map((r: { CidrIpv6: string }) => ({ ...base, CidrIpv6: r.CidrIpv6 })),
    ...(p.PrefixListIds ?? []).map((r: { PrefixListId: string }) => ({ ...base, PrefixListId: r.PrefixListId })),
    ...(p.UserIdGroupPairs ?? []).map((r: { GroupId: string }) => ({ ...base, GroupId: r.GroupId })),
  ];
});
const permissionOf = (r: Rule, Description?: string) => ({
  IpProtocol: r.IpProtocol, ...(r.FromPort !== undefined ? { FromPort: r.FromPort, ToPort: r.ToPort } : {}),
  ...(r.CidrIp ? { IpRanges: [{ CidrIp: r.CidrIp }] } : {}), ...(r.CidrIpv6 ? { Ipv6Ranges: [{ CidrIpv6: r.CidrIpv6 }] } : {}),
  ...(r.PrefixListId ? { PrefixListIds: [{ PrefixListId: r.PrefixListId }] } : {}), ...(r.GroupId ? { UserIdGroupPairs: [{ GroupId: r.GroupId, ...(Description ? { Description } : {}) }] } : {}),
});
// TCP 443 from or to a group: the proxy's only egress (to the cluster security group), and its rule on that group.
const https = (GroupId: string): Rule => ({ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, GroupId });
const isHttps = (r: Rule, groupId: string) => r.IpProtocol === 'tcp' && r.FromPort === 443 && r.ToPort === 443 && r.GroupId === groupId;

// A rule added, false when it was there already (another run made it meanwhile).
async function authorize(call: Call, input: unknown) {
  try {
    await call(input);
    return true;
  } catch (err) {
    if (named(err, 'InvalidPermission.Duplicate')) return false;
    throw err;
  }
}
// A rule revoked, false when it or its group was gone already.
async function revoke(call: Call, input: unknown) {
  try {
    await call(input);
    return true;
  } catch (err) {
    if (named(err, 'InvalidPermission.NotFound', 'InvalidGroup.NotFound')) return false;
    throw err;
  }
}

// Every cluster of the account and region, as described (one deleted meanwhile is left out).
async function clustersOf(eks: KubeProxyPorts['eks']) {
  const names: string[] = [];
  let next: string | undefined;
  do {
    const page = await eks.listClusters(next ? { nextToken: next } : {});
    names.push(...(page.clusters ?? []));
    next = page.nextToken;
  } while (next);
  const clusters = [];
  for (const name of names) {
    const cluster = (await find(() => eks.describeCluster({ name })))?.cluster;
    if (cluster) clusters.push({ ...cluster, name });
  }
  return clusters;
}

// One proxy removed, step by step: done, waiting for Lambda to release its network interfaces, or still held an hour
// after the removal started (expired).
type Removal = { status: 'done' } | { status: 'wait' | 'expired'; held: string[]; message: string };
async function removeProxy(ports: KubeProxyPorts, p: ProxyRecord, { since, now }: { since: number; now: number }): Promise<Removal> {
  const { ec2 } = ports;
  await find(() => ports.lambda.deleteFunction({ FunctionName: p.function }));
  if (p.securityGroupId) {
    const held = (((await ec2.describeNetworkInterfaces({ Filters: [{ Name: 'group-id', Values: [p.securityGroupId] }] })).NetworkInterfaces ?? []) as { NetworkInterfaceId: string }[])
      .map((n) => n.NetworkInterfaceId);
    const late = now - since > RELEASE_MAX_MS;
    if (held.length) {
      return late
        ? { status: 'expired', held, message: `cluster ${p.cluster}: Lambda still holds the network interfaces ${held.join(', ')} of the proxy ${p.function} an hour after its function was deleted` }
        : { status: 'wait', held, message: '' };
    }
    await revoke(ec2.revokeSecurityGroupIngress, { GroupId: p.clusterSecurityGroupId, IpPermissions: [permissionOf(https(p.securityGroupId))] });
    try {
      await ec2.deleteSecurityGroup({ GroupId: p.securityGroupId });
    } catch (err) {
      // Something still uses the group (an interface not listed yet): waited for as the interfaces are.
      if (named(err, 'DependencyViolation')) return late ? { status: 'expired', held: [], message: `cluster ${p.cluster}: the security group ${p.securityGroupId} of the proxy ${p.function} is still in use an hour after its function was deleted: ${(err as Error).message}` } : { status: 'wait', held: [], message: '' };
      if (!named(err, 'InvalidGroup.NotFound')) throw err;
    }
  }
  await deleteRole(ports.iam, p.role);
  await find(() => ports.logs.deleteLogGroup({ logGroupName: p.logGroup }));
  return { status: 'done' };
}
const releasing = (held: string[]) => `waiting for Lambda to release its network interfaces${held.length ? ` (${held.join(', ')})` : ''}`;

// The proxies of the clusters of the account and region: made or brought to the router's version where the endpoint is
// private, removed where they are no longer wanted. since: when the step started (a failure Lambda reports for a change made
// since then fails the step; one left by an earlier operation is tried again), and the removals' hour counts from it.
export async function ensureKubernetesProxies(ports: KubeProxyPorts, input: {
  account: string; region: string; routerName: string; kubeProxy: KubeProxy; trust: Policy; boundaryArn: string; zip: Uint8Array; codeSha256: string; existing: ProxyRecord[];
  since?: number; now?: number;
}): Promise<{ outcomes: ProxyOutcome[]; proxies: ProxyRecord[] }> {
  const kp = input.kubeProxy;
  const { iam, logs, lambda, ec2 } = ports;
  const now = input.now ?? Date.now();
  const at = { since: input.since ?? now, now };
  const records = new Map(input.existing.map((p) => [p.cluster, p]));
  const outcomes: ProxyOutcome[] = [];
  const expired: string[] = [];
  const needing: string[] = [];
  let current = '';

  // An earlier proxy removed (`why` says why, ending with its separator): done, or pending while Lambda holds its interfaces.
  async function removal(old: ProxyRecord, why: string): Promise<ProxyOutcome> {
    const r = await removeProxy(ports, old, at);
    if (r.status === 'done') {
      records.delete(old.cluster);
      return { cluster: old.cluster, status: 'done', detail: `${why} its proxy ${old.function} removed` };
    }
    if (r.status === 'expired') expired.push(r.message);
    return { cluster: old.cluster, status: 'pending', seconds: RELEASE_SECONDS, changed: true, detail: `${why} its proxy ${old.function} deleted, ${releasing(r.held)}` };
  }

  async function ensureProxy(c: Awaited<ReturnType<typeof clustersOf>>[number]): Promise<ProxyOutcome> {
    const vpc = c.resourcesVpcConfig;
    const fn = kubeProxyName(kp.namePrefix, c.name);
    const roleName = kubeProxyName(kp.rolePrefix, c.name);
    const label = `cluster ${c.name}: proxy ${fn}`;
    if (!c.endpoint || !c.certificateAuthority?.data) return { cluster: c.name, status: 'skipped', detail: `cluster ${c.name}: no endpoint yet (${c.status ?? 'unknown'}): set up its access again once it is active` };
    if (!vpc.clusterSecurityGroupId) return { cluster: c.name, status: 'skipped', detail: `cluster ${c.name}: no cluster security group (resourcesVpcConfig.clusterSecurityGroupId) to admit its proxy` };
    const changed: string[] = [];
    let old = records.get(c.name);
    // Made again in another VPC: the proxy in the earlier one goes first.
    if (old && old.vpcId !== vpc.vpcId) {
      const removed = await removal(old, `cluster ${c.name} is now in ${vpc.vpcId}:`);
      if (removed.status === 'pending') return removed;
      changed.push(`proxy in ${old.vpcId} removed`);
      old = undefined;
    }
    const tags = { ...kp.tags, 'dormeto:role': 'kubernetes-proxy', 'dormeto:cluster': c.name };
    const record: ProxyRecord = { cluster: c.name, function: fn, role: roleName, logGroup: `/aws/lambda/${fn}`, securityGroupId: old?.securityGroupId ?? null, clusterSecurityGroupId: vpc.clusterSecurityGroupId, vpcId: vpc.vpcId };
    // Made again in the same VPC, with a new cluster security group: the rule on the earlier one goes (if it is left).
    if (old?.securityGroupId && old.clusterSecurityGroupId !== record.clusterSecurityGroupId) {
      if (await revoke(ec2.revokeSecurityGroupIngress, { GroupId: old.clusterSecurityGroupId, IpPermissions: [permissionOf(https(old.securityGroupId))] })) changed.push(`rule on ${old.clusterSecurityGroupId} revoked`);
    }
    if (old) records.set(c.name, record);

    // Its security group, recorded as soon as it exists: only TCP 443 out, to the cluster security group.
    let group = (await ec2.describeSecurityGroups({ Filters: [{ Name: 'vpc-id', Values: [vpc.vpcId] }, { Name: 'group-name', Values: [fn] }] })).SecurityGroups?.[0];
    if (!group) {
      let created;
      try {
        created = await ec2.createSecurityGroup({ GroupName: fn, Description: `Dormeto Kubernetes proxy of cluster ${c.name}`, VpcId: vpc.vpcId, TagSpecifications: [{ ResourceType: 'security-group', Tags: tagList(tags) }] });
      } catch (err) {
        if (named(err, 'InvalidGroup.Duplicate')) throw new RetryLater(`security group ${fn} made, not listed yet`);
        throw err;
      }
      records.set(c.name, { ...record, securityGroupId: created.GroupId });
      changed.push('security group created');
      try {
        group = (await ec2.describeSecurityGroups({ GroupIds: [created.GroupId] })).SecurityGroups?.[0];
      } catch (err) {
        if (named(err, 'InvalidGroup.NotFound')) throw new RetryLater(`security group ${created.GroupId} made, not described yet`);
        throw err;
      }
      if (!group) throw new RetryLater(`security group ${created.GroupId} made, not described yet`);
    }
    const groupId = String(group.GroupId);
    Object.assign(record, { securityGroupId: groupId });
    records.set(c.name, record);
    const egress = rulesOf(group.IpPermissionsEgress);
    if (!egress.some((r) => isHttps(r, vpc.clusterSecurityGroupId))) {
      if (await authorize(ec2.authorizeSecurityGroupEgress, { GroupId: groupId, IpPermissions: [permissionOf(https(vpc.clusterSecurityGroupId), `Kubernetes API of cluster ${c.name}`)] })) changed.push('egress to the cluster security group');
    }
    // Its default egress (everything) and any other rule revoked.
    const others = egress.filter((r) => !isHttps(r, vpc.clusterSecurityGroupId));
    if (others.length && await revoke(ec2.revokeSecurityGroupEgress, { GroupId: groupId, IpPermissions: others.map((r) => permissionOf(r)) })) changed.push('other egress revoked');

    // The rule admitting it on the cluster security group.
    const clusterGroup = (await ec2.describeSecurityGroups({ GroupIds: [vpc.clusterSecurityGroupId] })).SecurityGroups?.[0];
    if (!rulesOf(clusterGroup?.IpPermissions).some((r) => isHttps(r, groupId))) {
      if (await authorize(ec2.authorizeSecurityGroupIngress, { GroupId: vpc.clusterSecurityGroupId, IpPermissions: [permissionOf(https(groupId), `Dormeto Kubernetes proxy ${fn}`)] })) changed.push(`rule on ${vpc.clusterSecurityGroupId}`);
    }

    // Its role (only the network interfaces' rights and its logs, under the routers' boundary) and its log group.
    const roleChanges: string[] = [];
    await putRole(iam, input.boundaryArn, { name: roleName, path: ROLE_PATH, trust: input.trust, policyName: 'proxy', policy: kp.rolePolicy }, tags, roleChanges);
    if (roleChanges.length) changed.push(roleChanges.some((x) => x.startsWith('role ')) ? 'role created' : 'role updated');
    const logGroup = ((await logs.describeLogGroups({ logGroupNamePrefix: record.logGroup })).logGroups ?? []).find((g: { logGroupName: string }) => g.logGroupName === record.logGroup);
    if (!logGroup) {
      await logs.createLogGroup({ logGroupName: record.logGroup, tags });
      changed.push('log group created');
    }
    if (logGroup?.retentionInDays !== kp.logRetentionDays) {
      await logs.putRetentionPolicy({ logGroupName: record.logGroup, retentionInDays: kp.logRetentionDays });
      if (logGroup) changed.push('log retention updated');
    }

    // The function, in the cluster's subnets with its group, configured with the cluster's endpoint and authority (PEM).
    const done = (): ProxyOutcome => ({ cluster: c.name, status: changed.length ? 'done' : 'skipped', detail: changed.length ? `${label}: ${changed.join(', ')}` : `${label} in place` });
    const pending = (state?: string): ProxyOutcome => ({
      cluster: c.name, status: 'pending', seconds: PENDING_SECONDS, ...(changed.length ? { changed: true } : {}),
      detail: `${label}: ${(changed.length ? changed : [state]).join(', ')}, waiting until it is Active`,
    });
    const config = {
      FunctionName: fn, Role: `arn:aws:iam::${input.account}:role${ROLE_PATH}${roleName}`, Runtime: kp.runtime, Handler: kp.handler, Timeout: kp.timeout, MemorySize: kp.memory,
      Environment: { Variables: { ...kp.environment, DMT_CLUSTER: c.name, DMT_ENDPOINT: c.endpoint, DMT_CA: Buffer.from(c.certificateAuthority.data, 'base64').toString('utf8') } },
      VpcConfig: { SubnetIds: vpc.subnetIds, SecurityGroupIds: [groupId] },
    };
    const fnState = await find(() => lambda.getFunctionConfiguration({ FunctionName: fn }));
    if (!fnState) {
      try {
        await lambda.createFunction({ ...config, Architectures: kp.architectures, Code: { ZipFile: input.zip }, Tags: tags });
      } catch (err) {
        // A new role (or its policy) not seen by Lambda yet: IAM propagation.
        if (named(err, 'InvalidParameterValueException') && /cannot be assumed|does not have permissions/.test((err as Error).message)) throw new RetryLater(`role ${roleName} not usable by Lambda yet`);
        throw err;
      }
      changed.push('function created');
      return pending();
    }
    const recent = Date.parse(fnState.LastModified ?? '') >= at.since;
    if (fnState.State === 'Failed') {
      if (recent) throw new Error(`cluster ${c.name}: the function ${fn} failed: ${fnState.StateReason} (${fnState.StateReasonCode})`);
      await lambda.deleteFunction({ FunctionName: fn });
      changed.push('function deleted (it failed earlier)');
      return pending();
    }
    if (fnState.State === 'Pending' || fnState.LastUpdateStatus === 'InProgress') return pending(`function ${fnState.State === 'Pending' ? 'Pending' : 'updating'}`);
    if (fnState.LastUpdateStatus === 'Failed' && recent) throw new Error(`cluster ${c.name}: the update of the function ${fn} failed: ${fnState.LastUpdateStatusReason} (${fnState.LastUpdateStatusReasonCode})`);
    const sorted = (ids: string[] = []) => [...ids].sort();
    const actual = {
      FunctionName: fn, Role: fnState.Role, Runtime: fnState.Runtime, Handler: fnState.Handler, Timeout: fnState.Timeout, MemorySize: fnState.MemorySize,
      Environment: { Variables: fnState.Environment?.Variables ?? {} }, VpcConfig: { SubnetIds: sorted(fnState.VpcConfig?.SubnetIds), SecurityGroupIds: sorted(fnState.VpcConfig?.SecurityGroupIds) },
    };
    if (!same(actual, { ...config, VpcConfig: { SubnetIds: sorted(vpc.subnetIds), SecurityGroupIds: [groupId] } })) {
      await lambda.updateFunctionConfiguration(config);
      changed.push('configuration updated');
      return pending();
    }
    if (fnState.CodeSha256 !== input.codeSha256) {
      await lambda.updateFunctionCode({ FunctionName: fn, ZipFile: input.zip });
      changed.push('code updated');
      return pending();
    }
    return done();
  }

  try {
    const clusters = await clustersOf(ports.eks);
    const reach = new Map(clusters.map((c) => [c.name, reachOf(c.resourcesVpcConfig ?? {})]));
    needing.push(...clusters.filter((c) => reach.get(c.name) === 'proxy').map((c) => c.name));
    for (const c of clusters) {
      current = c.name;
      if (reach.get(c.name) === 'proxy') {
        outcomes.push(await ensureProxy(c));
        continue;
      }
      const why = reach.get(c.name) === 'direct' ? `cluster ${c.name}: reached directly` : `cluster ${c.name}: ${UNREACHABLE}`;
      const old = records.get(c.name);
      outcomes.push(old ? await removal(old, `${why};`) : { cluster: c.name, status: 'skipped', detail: why });
    }
    for (const old of [...records.values()].filter((p) => !reach.has(p.cluster))) {
      current = old.cluster;
      outcomes.push(await removal(old, `cluster ${old.cluster} no longer exists:`));
    }
    if (expired.length) throw new Error(expired.join('; '));
  } catch (err) {
    const failure = denied(err)
      ? new KubeProxyAccessDenied(`${current ? `cluster ${current}: the command role may not set up its Kubernetes proxy` : 'the command role may not set up the Kubernetes proxies'}: ${ORGANIZATION_ACCESS} (${(err as Error).message})`, needing)
      : err;
    throw withProxies(failure, [...records.values()]);
  }
  return { outcomes, proxies: [...records.values()] };
}

// The router's proxies removed (its uninstall): those still waiting for Lambda to release their network interfaces stay
// in `remaining` for the next run; an hour after `since`, the removal fails naming the interfaces still held.
export async function removeKubernetesProxies(ports: KubeProxyPorts, proxies: ProxyRecord[], at: { since: number; now: number }): Promise<{ status: 'done' | 'wait'; remaining: ProxyRecord[]; detail: string }> {
  if (!proxies.length) return { status: 'done', remaining: [], detail: 'no proxy' };
  const remaining: ProxyRecord[] = [];
  const details: string[] = [];
  const expired: string[] = [];
  let index = 0;
  try {
    for (; index < proxies.length; index += 1) {
      const p = proxies[index]!;
      const r = await removeProxy(ports, p, at);
      if (r.status === 'done') {
        details.push(`cluster ${p.cluster}: proxy ${p.function} removed`);
        continue;
      }
      remaining.push(p);
      if (r.status === 'expired') expired.push(r.message);
      details.push(`cluster ${p.cluster}: proxy ${p.function} deleted, ${releasing(r.held)}`);
    }
    if (expired.length) throw new Error(expired.join('; '));
  } catch (err) {
    throw withProxies(err, [...remaining, ...proxies.slice(index)]);
  }
  return { status: remaining.length ? 'wait' : 'done', remaining, detail: details.join('; ') };
}
