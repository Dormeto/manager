// The Kubernetes proxies of a router the manager installed (vision docs/specs/2026-10-24-private-eks-endpoints-design.md,
// sections 4 and 6): for each EKS cluster of the router's account and region whose endpoint is private (reachOf = proxy),
// a small Lambda function in the cluster's VPC relays the router's and discovery's Kubernetes calls. The router's blueprint
// defines it (kubeProxy: handler, runtime, memory, timeout, role policy); this applies it per cluster by API calls of
// DmtCommandRole, each run finding what exists (named from the cluster by the router's rule) before creating or updating
// it, so that a run can come again. The proxies made are recorded with the router (InstalledRouter.proxies) and removed
// from that record: a cluster opened to every address, out of reach, gone, made again in another VPC, or the router
// uninstalled. Order: the security group first (a command role without the organization access of this manager's release
// refuses it before anything is made), whose only egress is TCP 443 to the VPC's IPv4 blocks (a rule naming the cluster security
// group would keep EKS from deleting that group with the cluster), the rule admitting it on the cluster security group, the
// role, the log group, the function; a removal deletes the function, waits until Lambda released its network interfaces
// (up to an hour from the function's deletion, recorded with the proxy), then revokes the rule and deletes the group, the
// role and the log group, each group looked up first (a group gone has no tag, and the command role's policy allows these
// calls on tagged groups only).
import type { Policy } from './blueprint.js';
import { reachOf, UNREACHABLE, type EksPort } from './cluster-access.js';
import { RetryLater, TRANSIENT, deleteRole, find, putRole, same, tagList } from './installer.js';
// @ts-expect-error the router's module has no type declarations
import { kubeProxyName as routerKubeProxyName } from '../../../../router/lambda/src/lib/kube-proxy-name.mjs';

// Loose SDK shapes: the adapters (aws.ts) pass the commands' inputs and outputs through.
type Call = (input: any) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export interface KubeProxyPorts {
  lambda: Record<'getFunctionConfiguration' | 'createFunction' | 'updateFunctionConfiguration' | 'updateFunctionCode' | 'listTags' | 'tagResource' | 'deleteFunction', Call>;
  iam: Record<'getRole' | 'createRole' | 'updateAssumeRolePolicy' | 'getRolePolicy' | 'putRolePolicy' | 'listRolePolicies' | 'deleteRolePolicy' | 'deleteRole', Call>;
  logs: Record<'describeLogGroups' | 'createLogGroup' | 'putRetentionPolicy' | 'deleteLogGroup', Call>;
  ec2: Record<'describeVpcs' | 'describeSecurityGroups' | 'createSecurityGroup' | 'authorizeSecurityGroupEgress' | 'revokeSecurityGroupEgress' | 'authorizeSecurityGroupIngress'
    | 'revokeSecurityGroupIngress' | 'deleteSecurityGroup' | 'describeNetworkInterfaces', Call>;
  eks: Pick<EksPort, 'listClusters' | 'describeCluster'>;
}

// The router blueprint's kubeProxy (routers 0.33.0 and later), filled for the router.
export interface KubeProxy {
  handler: string; runtime: string; architectures: string[]; memory: number; timeout: number; logRetentionDays: number;
  environment: Record<string, string>; tags: Record<string, string>; namePrefix: string; rolePrefix: string; rolePolicy: Policy;
}

// A proxy the manager made, as the router's record keeps it (securityGroupId null until its group exists; deletedAt once a
// removal deleted its function: the hour of waiting for its network interfaces counts from it).
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

// pending: the step comes back after `seconds` (the function not Active yet, network interfaces not released yet);
// failed: this cluster's proxy could not be set up or removed (detail: why), the other clusters' went on (ruling 24);
// changed: something was made or removed by this run.
export interface ProxyOutcome { cluster: string; status: 'done' | 'skipped' | 'pending' | 'failed'; detail: string; seconds?: number; changed?: boolean }

// The command role refuses the proxies' calls (an organization access older than this manager's release); clusters: those
// whose endpoint needs a proxy.
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
// A function Pending or updating (Lambda makes its network interfaces first) is waited for this long after its last change
// (LastModified, so a later operation does not start the wait again), then its cluster's failure with its state.
const SETTLE_MAX_MS = 15 * 60_000;
const why = (reason?: string, code?: string) => [reason, code ? `(${code})` : ''].filter(Boolean).join(' ') || 'no reason given';
// What to apply where the command role refuses the proxies' calls: the organization access of the manager running (its
// VERSION), of this manager's release when unknown (ruling 19: no release number in the code, it is chosen at release).
export const organizationAccess = (version?: string) => `apply the organization access of ${version && /^\d+\.\d+\.\d+/.test(version) ? `manager ${version}` : 'this manager\'s release'}`;

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
const sameRule = (a: Rule, b: Rule) => a.IpProtocol === b.IpProtocol && a.FromPort === b.FromPort && a.ToPort === b.ToPort && a.CidrIp === b.CidrIp && a.CidrIpv6 === b.CidrIpv6
  && a.PrefixListId === b.PrefixListId && a.GroupId === b.GroupId;
// TCP 443 from the proxy's group: its rule on the cluster security group.
const https = (GroupId: string): Rule => ({ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, GroupId });
const isHttps = (r: Rule, groupId: string) => sameRule(r, https(groupId));
// A security group by its id, undefined when it is gone (EC2 answers InvalidGroup.NotFound for an id it does not know).
async function groupById(ec2: KubeProxyPorts['ec2'], id: string) {
  try {
    return (await ec2.describeSecurityGroups({ GroupIds: [id] })).SecurityGroups?.[0];
  } catch (err) {
    if (named(err, 'InvalidGroup.NotFound')) return undefined;
    throw err;
  }
}
// Which of these security groups exist (a filter lists none for a group gone, where its id would be an error).
const presentGroups = async (ec2: KubeProxyPorts['ec2'], ids: string[]) => new Set<string>(
  (((await ec2.describeSecurityGroups({ Filters: [{ Name: 'group-id', Values: ids }] })).SecurityGroups ?? []) as { GroupId: string }[]).map((g) => g.GroupId),
);

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
// after its function was deleted (expired). `deleted` is told the record with the deletion's time as soon as it is known.
type Removal = { status: 'done' } | { status: 'wait' | 'expired'; held: string[]; message: string; record: ProxyRecord };
async function removeProxy(ports: KubeProxyPorts, p: ProxyRecord, now: number, deleted: (record: ProxyRecord) => void = () => {}): Promise<Removal> {
  const { ec2 } = ports;
  // Deleted now, or by an earlier run (its time recorded then).
  const deletedNow = (await find(() => ports.lambda.deleteFunction({ FunctionName: p.function }))) !== null;
  const record = { ...p, deletedAt: deletedNow || !p.deletedAt ? new Date(now).toISOString() : p.deletedAt };
  deleted(record);
  const late = now - Date.parse(record.deletedAt) > RELEASE_MAX_MS;
  if (p.securityGroupId) {
    const held = (((await ec2.describeNetworkInterfaces({ Filters: [{ Name: 'group-id', Values: [p.securityGroupId] }] })).NetworkInterfaces ?? []) as { NetworkInterfaceId: string }[])
      .map((n) => n.NetworkInterfaceId);
    if (held.length) {
      return late
        ? { status: 'expired', held, record, message: `cluster ${p.cluster}: Lambda still holds the network interfaces ${held.join(', ')} of the proxy ${p.function} an hour after its function was deleted` }
        : { status: 'wait', held, record, message: '' };
    }
    // The cluster's group goes with a deleted cluster, the proxy's with an earlier run of this removal.
    const present = await presentGroups(ec2, [p.clusterSecurityGroupId, p.securityGroupId]);
    if (present.has(p.clusterSecurityGroupId)) await revoke(ec2.revokeSecurityGroupIngress, { GroupId: p.clusterSecurityGroupId, IpPermissions: [permissionOf(https(p.securityGroupId))] });
    if (present.has(p.securityGroupId)) {
      try {
        await ec2.deleteSecurityGroup({ GroupId: p.securityGroupId });
      } catch (err) {
        // Something still uses the group (an interface not listed yet): waited for as the interfaces are.
        if (named(err, 'DependencyViolation')) {
          return late
            ? { status: 'expired', held: [], record, message: `cluster ${p.cluster}: the security group ${p.securityGroupId} of the proxy ${p.function} is still in use an hour after its function was deleted: ${(err as Error).message}` }
            : { status: 'wait', held: [], record, message: '' };
        }
        if (!named(err, 'InvalidGroup.NotFound')) throw err;
      }
    }
  }
  await deleteRole(ports.iam, p.role);
  await find(() => ports.logs.deleteLogGroup({ logGroupName: p.logGroup }));
  return { status: 'done' };
}
const releasing = (held: string[]) => `waiting for Lambda to release its network interfaces${held.length ? ` (${held.join(', ')})` : ''}`;

// The proxies of the clusters of the account and region: made or brought to the router's version where the endpoint is
// private, removed where they are no longer wanted; every cluster processed, one that fails a `failed` outcome (ruling 24).
// since: when the step started (a failure Lambda reports for a change made since then is the cluster's failure; one left by
// an earlier operation is tried again).
export async function ensureKubernetesProxies(ports: KubeProxyPorts, input: {
  account: string; region: string; routerName: string; kubeProxy: KubeProxy; trust: Policy; boundaryArn: string; zip: Uint8Array; codeSha256: string; existing: ProxyRecord[];
  since?: number; now?: number; managerVersion?: string;
}): Promise<{ outcomes: ProxyOutcome[]; proxies: ProxyRecord[] }> {
  const kp = input.kubeProxy;
  const { iam, logs, lambda, ec2 } = ports;
  const now = input.now ?? Date.now();
  const at = { since: input.since ?? now, now };
  const records = new Map(input.existing.map((p) => [p.cluster, p]));
  const outcomes: ProxyOutcome[] = [];
  const needing: string[] = [];
  let current = '';

  // An earlier proxy removed (`why` says why, ending with its separator): done, or pending while Lambda holds its interfaces.
  async function removal(old: ProxyRecord, why: string): Promise<ProxyOutcome> {
    const r = await removeProxy(ports, old, at.now, (deleted) => records.set(old.cluster, deleted));
    if (r.status === 'done') {
      records.delete(old.cluster);
      return { cluster: old.cluster, status: 'done', detail: `${why} its proxy ${old.function} removed` };
    }
    if (r.status === 'expired') return { cluster: old.cluster, status: 'failed', changed: true, detail: r.message };
    return { cluster: old.cluster, status: 'pending', seconds: RELEASE_SECONDS, changed: true, detail: `${why} its proxy ${old.function} deleted, ${releasing(r.held)}` };
  }

  // One cluster's work: what fails there is its outcome, its records kept (ruling 24: the other clusters go on). What the
  // step must meet again is thrown: a dependency not ready yet (RetryLater), an error that passes (TRANSIENT), the command
  // role's refusal (the whole account's organization access).
  async function oneCluster(cluster: string, work: () => Promise<ProxyOutcome>): Promise<ProxyOutcome> {
    current = cluster;
    const before = JSON.stringify(records.get(cluster) ?? null);
    try {
      return await work();
    } catch (err) {
      if (err instanceof RetryLater || TRANSIENT.has((err as Error).name) || denied(err)) throw err;
      const message = String((err as Error)?.message ?? err);
      return {
        cluster, status: 'failed', ...(JSON.stringify(records.get(cluster) ?? null) !== before ? { changed: true } : {}),
        detail: message.startsWith(`cluster ${cluster}:`) ? message : `cluster ${cluster}: ${message}`,
      };
    }
  }

  async function ensureProxy(c: Awaited<ReturnType<typeof clustersOf>>[number]): Promise<ProxyOutcome> {
    const vpc = c.resourcesVpcConfig;
    const fn = kubeProxyName(kp.namePrefix, c.name);
    const roleName = kubeProxyName(kp.rolePrefix, c.name);
    const label = `cluster ${c.name}: proxy ${fn}`;
    // Being created or deleted, or failed: nothing made or changed (a proxy it has stays until it is ACTIVE again or gone).
    if (c.status && c.status !== 'ACTIVE' && c.status !== 'UPDATING') return { cluster: c.name, status: 'skipped', detail: `cluster ${c.name} is ${c.status}: no proxy set up until it is ACTIVE (set up its access again then)` };
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
    if (old?.securityGroupId && old.clusterSecurityGroupId !== record.clusterSecurityGroupId && (await presentGroups(ec2, [old.clusterSecurityGroupId])).has(old.clusterSecurityGroupId)) {
      if (await revoke(ec2.revokeSecurityGroupIngress, { GroupId: old.clusterSecurityGroupId, IpPermissions: [permissionOf(https(old.securityGroupId))] })) changed.push(`rule on ${old.clusterSecurityGroupId} revoked`);
    }
    if (old) records.set(c.name, record);

    // Its security group, recorded as soon as it exists.
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
      group = await groupById(ec2, created.GroupId);
      if (!group) throw new RetryLater(`security group ${created.GroupId} made, not described yet`);
    }
    const groupId = String(group.GroupId);
    Object.assign(record, { securityGroupId: groupId });
    records.set(c.name, record);
    // Its only egress: TCP 443 to each IPv4 block of the VPC (the endpoint's addresses are in the cluster's subnets).
    const described = (await ec2.describeVpcs({ VpcIds: [vpc.vpcId] })).Vpcs?.[0];
    const blocks = [...new Set<string>(((described?.CidrBlockAssociationSet ?? []) as { CidrBlock: string; CidrBlockState?: { State?: string } }[])
      .filter((a) => a.CidrBlockState?.State === 'associated').map((a) => a.CidrBlock))];
    if (!blocks.length && described?.CidrBlock) blocks.push(described.CidrBlock);
    const wanted: Rule[] = blocks.map((CidrIp) => ({ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp }));
    const egress = rulesOf(group.IpPermissionsEgress);
    const missing = wanted.filter((w) => !egress.some((r) => sameRule(r, w)));
    if (missing.length && await authorize(ec2.authorizeSecurityGroupEgress, {
      GroupId: groupId, IpPermissions: [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, IpRanges: missing.map((r) => ({ CidrIp: r.CidrIp, Description: `Kubernetes API of cluster ${c.name}` })) }],
    })) changed.push('egress to the VPC');
    // Its default egress (everything) and any other rule revoked (an earlier one to the cluster security group too).
    const others = egress.filter((r) => !wanted.some((w) => sameRule(r, w)));
    if (others.length && await revoke(ec2.revokeSecurityGroupEgress, { GroupId: groupId, IpPermissions: others.map((r) => permissionOf(r)) })) changed.push('other egress revoked');

    // The rule admitting it on the cluster security group; gone meanwhile, the cluster is being deleted or made again (what
    // was made stays recorded: the next run follows the cluster).
    const clusterGroup = await groupById(ec2, vpc.clusterSecurityGroupId);
    if (!clusterGroup) {
      return {
        cluster: c.name, status: 'skipped', ...(changed.length ? { changed: true } : {}),
        detail: `cluster ${c.name}: its cluster security group ${vpc.clusterSecurityGroupId} no longer exists (the cluster deleted or made again meanwhile): set up its access again`,
      };
    }
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
        // A new role (or its policy) not seen by Lambda yet: IAM propagation. Lambda's message kept: the step's last retry
        // fails with it, when the role is refused for another reason than propagation.
        if (named(err, 'InvalidParameterValueException') && /cannot be assumed|does not have permissions/.test((err as Error).message)) throw new RetryLater(`role ${roleName} not usable by Lambda yet: ${(err as Error).message}`);
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
    if (fnState.State === 'Pending' || fnState.LastUpdateStatus === 'InProgress') {
      if (at.now - Date.parse(fnState.LastModified ?? '') > SETTLE_MAX_MS) {
        const late = `cluster ${c.name}: the function ${fn} is still ${fnState.State === 'Pending' ? 'Pending' : 'updating'} ${SETTLE_MAX_MS / 60_000} minutes after its last change`;
        throw new Error(fnState.State === 'Pending' ? `${late}: ${why(fnState.StateReason, fnState.StateReasonCode)}`
          : `${late} (state ${fnState.State}): ${why(fnState.LastUpdateStatusReason ?? fnState.StateReason, fnState.LastUpdateStatusReasonCode ?? fnState.StateReasonCode)}`);
      }
      return pending(`function ${fnState.State === 'Pending' ? 'Pending' : 'updating'}`);
    }
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
    // Its code and architectures (the bundle's code runs on its architectures; UpdateFunctionCode sets both).
    const architectures = (a: string[] = ['x86_64']) => [...a].sort().join(',');
    if (fnState.CodeSha256 !== input.codeSha256 || architectures(fnState.Architectures) !== architectures(kp.architectures)) {
      await lambda.updateFunctionCode({ FunctionName: fn, ZipFile: input.zip, Architectures: kp.architectures });
      changed.push(fnState.CodeSha256 !== input.codeSha256 ? 'code updated' : 'architectures updated');
      return pending();
    }
    // Its tags (discovery may invoke only functions tagged dormeto:role = kubernetes-proxy): ours put back, others kept.
    const arn = fnState.FunctionArn ?? `arn:aws:lambda:${input.region}:${input.account}:function:${fn}`;
    const present: Record<string, string> = (await lambda.listTags({ Resource: arn })).Tags ?? {};
    const lost = Object.fromEntries(Object.entries(tags).filter(([k, v]) => present[k] !== v));
    if (Object.keys(lost).length) {
      await lambda.tagResource({ Resource: arn, Tags: lost });
      changed.push('tags restored');
    }
    return done();
  }

  try {
    const clusters = await clustersOf(ports.eks);
    const reach = new Map(clusters.map((c) => [c.name, reachOf(c.resourcesVpcConfig ?? {})]));
    needing.push(...clusters.filter((c) => reach.get(c.name) === 'proxy').map((c) => c.name));
    for (const c of clusters) {
      outcomes.push(await oneCluster(c.name, async () => {
        if (reach.get(c.name) === 'proxy') return ensureProxy(c);
        const why = reach.get(c.name) === 'direct' ? `cluster ${c.name}: reached directly` : `cluster ${c.name}: ${UNREACHABLE}`;
        const old = records.get(c.name);
        return old ? removal(old, `${why};`) : { cluster: c.name, status: 'skipped', detail: why };
      }));
    }
    for (const old of [...records.values()].filter((p) => !reach.has(p.cluster))) {
      outcomes.push(await oneCluster(old.cluster, () => removal(old, `cluster ${old.cluster} no longer exists:`)));
    }
  } catch (err) {
    const failure = denied(err)
      ? new KubeProxyAccessDenied(`${current ? `cluster ${current}: the command role may not set up its Kubernetes proxy` : 'the command role may not set up the Kubernetes proxies'}: ${organizationAccess(input.managerVersion)} (${(err as Error).message})`, needing)
      : err;
    throw withProxies(failure, [...records.values()]);
  }
  return { outcomes, proxies: [...records.values()] };
}

// The router's proxies removed (its uninstall): those still waiting for Lambda to release their network interfaces stay
// in `remaining` (with the time their function was deleted) for the next run; an hour after that time, the removal fails
// naming the interfaces still held.
export async function removeKubernetesProxies(ports: KubeProxyPorts, proxies: ProxyRecord[], at: { now: number }): Promise<{ status: 'done' | 'wait'; remaining: ProxyRecord[]; detail: string }> {
  if (!proxies.length) return { status: 'done', remaining: [], detail: 'no proxy' };
  const remaining: ProxyRecord[] = [];
  const details: string[] = [];
  const expired: string[] = [];
  let index = 0;
  let current: ProxyRecord | undefined;
  try {
    for (; index < proxies.length; index += 1) {
      const p = proxies[index]!;
      current = p;
      const r = await removeProxy(ports, p, at.now, (deleted) => { current = deleted; });
      current = undefined;
      if (r.status === 'done') {
        details.push(`cluster ${p.cluster}: proxy ${p.function} removed`);
        continue;
      }
      remaining.push(r.record);
      if (r.status === 'expired') expired.push(r.message);
      details.push(`cluster ${p.cluster}: proxy ${p.function} deleted, ${releasing(r.held)}`);
    }
    if (expired.length) throw new Error(expired.join('; '));
  } catch (err) {
    throw withProxies(err, [...remaining, ...(current ? [current] : []), ...proxies.slice(current ? index + 1 : index)]);
  }
  return { status: remaining.length ? 'wait' : 'done', remaining, detail: details.join('; ') };
}
