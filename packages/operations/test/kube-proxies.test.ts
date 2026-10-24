// The Kubernetes proxies of a router the manager installed (vision docs/specs/2026-10-24-private-eks-endpoints-design.md,
// section 6): one function per cluster whose endpoint is private, in the cluster's VPC, created, brought to the router's
// version and removed by API calls of DmtCommandRole.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fill, type Policy } from '../src/blueprint.js';
import { RetryLater } from '../src/installer.js';
import { KubeProxyAccessDenied, ensureKubernetesProxies, proxiesOf, removeKubernetesProxies, type KubeProxy, type ProxyOutcome, type ProxyRecord } from '../src/kube-proxies.js';
import { ACCOUNT, KUBE_PROXY_CALLS, KUBE_REGION, allows } from './command-policy.js';
import { cluster, pem } from './eks-fake.js';
import { fakeKubeAccount } from './kube-proxy-fake.js';
import names from '../../../../router/lambda/test/fixtures/kube-proxy-names.json' with { type: 'json' };
// @ts-expect-error the router's module has no type declarations
import { blueprint } from '../../../../router/install/blueprint.mjs';
// @ts-expect-error the router's module has no type declarations
import { UNREACHABLE } from '../../../../router/lambda/src/lib/k8s.mjs';

const T0 = Date.UTC(2026, 9, 24, 12, 0);
const ROUTER = 'dmtr-dev';
// The router's own definition (router install/blueprint.mjs), filled as the manager fills it.
const values = { name: ROUTER, region: KUBE_REGION, account: ACCOUNT, partition: 'aws', build: 'b1d2c3' };
const published = blueprint({ version: '0.33.0' });
const KUBE_PROXY = fill(published.kubeProxy, values) as KubeProxy;
const TRUST = fill(published.roles.find((r: { key: string }) => r.key === 'controller').trust, values) as Policy;
const BOUNDARY = `arn:aws:iam::${ACCOUNT}:policy/DmtRouterBoundary`;
const ZIP = new Uint8Array([1, 2, 3]);
const sha = (zip: Uint8Array) => createHash('sha256').update(zip).digest('base64');
const FN = 'dmtr-dev-kube-eks-demo';
const ROLE = 'dmtr-dev-eu-west-1-kube-eks-demo';
const LOG = `/aws/lambda/${FN}`;
const TAGS = { 'dormeto:router': ROUTER, 'dormeto:role': 'kubernetes-proxy', 'dormeto:cluster': 'eks-demo' };
const RECORD: ProxyRecord = { cluster: 'eks-demo', function: FN, role: ROLE, logGroup: LOG, securityGroupId: 'sg-0proxy000', clusterSecurityGroupId: 'sg-0cluster00', vpcId: 'vpc-0a1b2c3d' };
const RULE_443 = { IpProtocol: 'tcp', FromPort: 443, ToPort: 443 };
// The proxy's egress: TCP 443 to each IPv4 block of its VPC (the fake's vpc-0a1b2c3d: two associated, one disassociated).
const toBlock = (CidrIp: string) => ({ ...RULE_443, CidrIp, Description: 'Kubernetes API of cluster eks-demo' });
const EGRESS = [toBlock('10.0.0.0/16'), toBlock('100.64.0.0/16')];
const iso = (ms: number) => new Date(ms).toISOString();
const privateCluster = (name = 'eks-demo', over: Parameters<typeof cluster>[1] = {}) => cluster(name, { public: false, private: true, ...over });
const ec2Error = (name: string, message: string) => Object.assign(new Error(message), { name });

function setup(clusters = [privateCluster()]) {
  let now = T0;
  let since = T0;
  let proxies: ProxyRecord[] = [];
  const account = fakeKubeAccount(clusters, { now: () => now });
  // What each run answered (its outcomes, or the error's name).
  const runs: (ProxyOutcome[] | string)[] = [];
  const input = (over: Partial<Parameters<typeof ensureKubernetesProxies>[1]>) => ({
    account: ACCOUNT, region: KUBE_REGION, routerName: ROUTER, kubeProxy: KUBE_PROXY, trust: TRUST, boundaryArn: BOUNDARY, zip: ZIP, codeSha256: sha(ZIP), existing: proxies, since, now, ...over,
  });
  // One run of the step, keeping the proxies it records (an error carries them too).
  async function once(over: Partial<Parameters<typeof ensureKubernetesProxies>[1]> = {}) {
    try {
      const result = await ensureKubernetesProxies(account.ports, input(over));
      proxies = result.proxies;
      runs.push(result.outcomes);
      return result;
    } catch (err) {
      proxies = proxiesOf(err) ?? proxies;
      runs.push((err as Error).name);
      throw err;
    }
  }
  // The step as the engine runs it: again while a proxy is pending or a dependency not ready, the clock moving.
  async function step(over: Partial<Parameters<typeof ensureKubernetesProxies>[1]> = {}) {
    since = now;
    for (let i = 0; i < 40; i += 1) {
      try {
        const result = await once(over);
        const pending = result.outcomes.filter((o) => o.status === 'pending');
        if (!pending.length) return result;
        now += Math.min(...pending.map((o) => o.seconds ?? 10)) * 1000;
      } catch (err) {
        if (!(err instanceof RetryLater)) throw err;
        now += err.seconds * 1000;
      }
    }
    throw new Error('the step never settled');
  }
  return { account, clusters, runs, once, step, proxies: () => proxies, advance: (ms: number) => { now += ms; }, now: () => now };
}

describe('the Kubernetes proxies step', () => {
  it('gives a private cluster its proxy: a security group with only TCP 443 to its VPC\'s ranges, the rule on the cluster group, a role, a log group and the function', async () => {
    const s = setup();
    const result = await s.step();
    const { state } = s.account;
    const group = state.groups.get('sg-0proxy000')!;
    expect(group).toMatchObject({ GroupName: FN, VpcId: 'vpc-0a1b2c3d', Tags: TAGS });
    // A rule naming the cluster security group would keep EKS from deleting that group with the cluster (spec section 4,
    // ruling 15); EC2 admits no apostrophe in a rule's description.
    expect(group.egress).toEqual(EGRESS);
    expect(group.ingress).toEqual([]);
    expect(state.groups.get('sg-0cluster00')!.ingress).toEqual([{ IpProtocol: '-1', GroupId: 'sg-0cluster00' }, { ...RULE_443, GroupId: 'sg-0proxy000', Description: `Dormeto Kubernetes proxy ${FN}` }]);
    const role = state.roles.get(ROLE)!;
    expect([role.path, role.boundary, JSON.parse(role.trust), role.tags]).toEqual(['/dormeto/router/', BOUNDARY, TRUST, TAGS]);
    expect(Object.fromEntries([...role.policies].map(([k, v]) => [k, JSON.parse(v)]))).toEqual({ proxy: KUBE_PROXY.rolePolicy });
    expect(state.logGroups.get(LOG)).toEqual({ retention: 14, tags: TAGS });
    const fn = state.functions.get(FN)!;
    expect(fn.config).toMatchObject({
      Role: `arn:aws:iam::${ACCOUNT}:role/dormeto/router/${ROLE}`, Handler: 'kube-proxy.handler', Runtime: 'nodejs24.x', Architectures: ['arm64'], MemorySize: 128, Timeout: 15,
      VpcConfig: { SubnetIds: ['subnet-0aaa', 'subnet-0bbb'], SecurityGroupIds: ['sg-0proxy000'] }, CodeSha256: sha(ZIP), State: 'Active',
    });
    expect(fn.config.Environment.Variables).toEqual({ DMT_VERSION: '0.33.0', DMT_BUILD: 'b1d2c3', DMT_CLUSTER: 'eks-demo', DMT_ENDPOINT: s.clusters[0]!.endpoint, DMT_CA: pem('eks-demo') });
    expect(fn.tags).toEqual(TAGS);
    expect(result.proxies).toEqual([RECORD]);
    expect(result.outcomes).toEqual([{ cluster: 'eks-demo', status: 'skipped', detail: `cluster eks-demo: proxy ${FN} in place` }]);
  });

  it('waits while the function is Pending (Lambda makes its network interfaces first), until it is Active', async () => {
    const s = setup();
    await s.step();
    // The new role not assumable by Lambda yet (retried later), then the function created and Pending for one read.
    expect(s.runs.map((r) => (typeof r === 'string' ? r : r.map((o) => [o.status, o.seconds])))).toEqual([
      'RetryLater', [['pending', 10]], [['pending', 10]], [['skipped', undefined]],
    ]);
    expect((s.runs[1] as ProxyOutcome[])[0]).toMatchObject({ changed: true, detail: `cluster eks-demo: proxy ${FN}: function created, waiting until it is Active` });
    expect((s.runs[2] as ProxyOutcome[])[0]!.detail).toBe(`cluster eks-demo: proxy ${FN}: function Pending, waiting until it is Active`);
    expect(s.account.state.functions.get(FN)!.config.State).toBe('Active');
  });

  it('a function Lambda could not make (no free address in the subnets) is its cluster\'s failure with Lambda\'s reason, recorded; a later run makes it again', async () => {
    const s = setup();
    const reason = 'Lambda was unable to configure your environment variables because the subnet subnet-0aaa has no free IP addresses.';
    s.account.state.failNext = { code: 'SubnetOutOfIPAddresses', reason };
    expect((await s.step()).outcomes).toEqual([{ cluster: 'eks-demo', status: 'failed', detail: `cluster eks-demo: the function ${FN} failed: ${reason} (SubnetOutOfIPAddresses)` }]);
    // What it made stays recorded, for its removal.
    expect(s.proxies()).toEqual([RECORD]);
    // Addresses freed since: the next operation deletes the failed function and makes it again.
    s.advance(10 * 60_000);
    s.account.state.ops.length = 0;
    expect((await s.step()).proxies).toEqual([RECORD]);
    expect(s.account.writes()).toEqual(['deleteFunction', 'createFunction']);
    expect(s.account.state.functions.get(FN)!.config.State).toBe('Active');
  });

  // Ruling 24: one cluster's failure is that cluster's outcome, its records kept; the clusters after it are processed.
  it('one cluster\'s proxy failing (its function Failed) leaves the other clusters\' proxies made', async () => {
    const s = setup([privateCluster(), privateCluster('eks-other')]);
    const reason = 'Lambda was unable to configure your environment variables because the subnet subnet-0aaa has no free IP addresses.';
    s.account.state.failing.set(FN, { code: 'SubnetOutOfIPAddresses', reason });
    const result = await s.step();
    expect(result.outcomes).toEqual([
      { cluster: 'eks-demo', status: 'failed', detail: `cluster eks-demo: the function ${FN} failed: ${reason} (SubnetOutOfIPAddresses)` },
      { cluster: 'eks-other', status: 'skipped', detail: 'cluster eks-other: proxy dmtr-dev-kube-eks-other in place' },
    ]);
    expect(result.proxies.map((p) => p.cluster)).toEqual(['eks-demo', 'eks-other']);
    expect(s.account.state.functions.get('dmtr-dev-kube-eks-other')!.config.State).toBe('Active');
  });

  it('an error of one cluster\'s calls (a subnet gone) is that cluster\'s failure; a passing error or a dependency not ready is the step\'s, to run it again', async () => {
    const s = setup([privateCluster(), privateCluster('eks-other')]);
    const createFunction = s.account.ports.lambda.createFunction;
    s.account.ports.lambda.createFunction = async (input: { FunctionName: string }) => {
      if (input.FunctionName === FN) throw ec2Error('InvalidParameterValueException', 'The subnet ID \'subnet-0aaa\' does not exist');
      return createFunction(input);
    };
    const result = await s.step();
    expect(result.outcomes).toEqual([
      { cluster: 'eks-demo', status: 'failed', detail: 'cluster eks-demo: The subnet ID \'subnet-0aaa\' does not exist' },
      { cluster: 'eks-other', status: 'skipped', detail: 'cluster eks-other: proxy dmtr-dev-kube-eks-other in place' },
    ]);
    // A throttled call is the step's: the engine runs it again.
    const t = setup([privateCluster(), privateCluster('eks-other')]);
    t.account.ports.lambda.createFunction = async () => { throw ec2Error('TooManyRequestsException', 'Rate exceeded'); };
    await expect(t.once()).rejects.toMatchObject({ name: 'TooManyRequestsException' });
  });

  it('a removal whose network interfaces are still held an hour after its function was deleted is that cluster\'s failure; the other clusters go on', async () => {
    const s = setup([privateCluster(), privateCluster('eks-other')]);
    await s.step();
    s.clusters.splice(0, 1);
    s.account.state.groups.delete('sg-0cluster00');
    s.account.state.held.add(FN);
    await s.once();
    s.advance(61 * 60_000);
    const result = await s.once();
    expect(result.outcomes).toEqual([
      { cluster: 'eks-other', status: 'skipped', detail: 'cluster eks-other: proxy dmtr-dev-kube-eks-other in place' },
      { cluster: 'eks-demo', status: 'failed', changed: true, detail: expect.stringMatching(new RegExp(`^cluster eks-demo: Lambda still holds the network interfaces eni-0\\w+, eni-0\\w+ of the proxy ${FN} an hour after its function was deleted$`)) },
    ]);
    expect(result.proxies.map((p) => [p.cluster, Boolean(p.deletedAt)])).toEqual([['eks-demo', true], ['eks-other', false]]);
  });

  // A function that never settles (minor 5): waited for 15 minutes from its last change, then its cluster's failure with its
  // state and Lambda's reason.
  it('a function still Pending, or still updating, 15 minutes after its last change is its cluster\'s failure, with its state and reason', async () => {
    const s = setup();
    s.account.state.pendingReads = 1000;
    await s.once().catch((err: unknown) => expect(err).toBeInstanceOf(RetryLater));
    s.advance(10_000);
    const createdAt = s.now();
    expect((await s.once()).outcomes[0]!.status).toBe('pending');
    s.advance(15 * 60_000);
    expect((await s.once()).outcomes[0]!.status).toBe('pending');
    s.advance(1_000);
    expect((await s.once()).outcomes).toEqual([{ cluster: 'eks-demo', status: 'failed', detail: `cluster eks-demo: the function ${FN} is still Pending 15 minutes after its last change: The function is being created. (Creating)` }]);
    expect(s.now() - createdAt).toBeGreaterThan(15 * 60_000);

    // Settled, then a new endpoint: its update stays InProgress.
    const u = setup();
    await u.step();
    u.account.state.pendingReads = 1000;
    u.clusters[0]!.endpoint = 'https://EKSDEMO0A1C.gr7.eu-west-1.eks.amazonaws.com';
    expect((await u.once()).outcomes[0]!.status).toBe('pending');
    u.advance(15 * 60_000 + 1_000);
    expect((await u.once()).outcomes).toEqual([{ cluster: 'eks-demo', status: 'failed', detail: `cluster eks-demo: the function ${FN} is still updating 15 minutes after its last change (state Active): The function is being updated. (Updating)` }]);
  });

  it('a new endpoint or new code updates the function, and nothing else', async () => {
    const s = setup();
    await s.step();
    s.account.state.ops.length = 0;
    s.clusters[0]!.endpoint = 'https://EKSDEMO0A1C.gr7.eu-west-1.eks.amazonaws.com';
    expect((await s.step()).outcomes).toEqual([{ cluster: 'eks-demo', status: 'skipped', detail: `cluster eks-demo: proxy ${FN} in place` }]);
    expect(s.account.writes()).toEqual(['updateFunctionConfiguration']);
    expect((s.runs.find((r) => typeof r !== 'string' && r[0]?.changed && r[0].detail.includes('configuration')) as ProxyOutcome[])[0]!.detail)
      .toBe(`cluster eks-demo: proxy ${FN}: configuration updated, waiting until it is Active`);
    expect(s.account.state.functions.get(FN)!.config.Environment.Variables.DMT_ENDPOINT).toBe('https://EKSDEMO0A1C.gr7.eu-west-1.eks.amazonaws.com');
    s.account.state.ops.length = 0;
    const zip = new Uint8Array([4, 5, 6]);
    await s.step({ zip, codeSha256: sha(zip) });
    expect(s.account.writes()).toEqual(['updateFunctionCode']);
    expect(s.account.state.functions.get(FN)!.config.CodeSha256).toBe(sha(zip));
    s.account.state.ops.length = 0;
    await s.step({ zip, codeSha256: sha(zip) });
    expect(s.account.writes()).toEqual([]);
  });

  it('makes only calls the command role\'s policy allows, each listed in KUBE_PROXY_CALLS: creation, update, removal', async () => {
    const s = setup();
    s.account.state.ipv6 = true;
    await s.step();
    // A trust changed by hand, a new endpoint and new code, then the cluster opened to every address.
    s.account.state.roles.get(ROLE)!.trust = '{}';
    s.clusters[0]!.endpoint = 'https://EKSDEMO0A1C.gr7.eu-west-1.eks.amazonaws.com';
    const zip = new Uint8Array([4]);
    await s.step({ zip, codeSha256: sha(zip) });
    expect(JSON.parse(s.account.state.roles.get(ROLE)!.trust)).toEqual(TRUST);
    Object.assign(s.clusters[0]!.resourcesVpcConfig, { endpointPublicAccess: true });
    await s.step();
    expect(s.account.state.functions.size).toBe(0);
    // Its cluster deleted (its cluster security group with it), and a removal resumed after the proxy's group was deleted:
    // no call on a group that is gone (a deleted group has no tag, and the policy allows these calls on tagged groups only).
    const gone = setup();
    await gone.step();
    gone.clusters.splice(0, 1);
    gone.account.state.groups.delete('sg-0cluster00');
    await gone.step();
    expect(gone.proxies()).toEqual([]);
    const resumed = setup();
    await resumed.step();
    resumed.account.state.releaseReads = 0;
    const deleteRole = resumed.account.ports.iam.deleteRole;
    let throttled = false;
    resumed.account.ports.iam.deleteRole = async (input: unknown) => {
      if (throttled) return deleteRole(input);
      throttled = true;
      throw ec2Error('Throttling', 'Rate exceeded');
    };
    const failed = await removeKubernetesProxies(resumed.account.ports, resumed.proxies(), { now: resumed.now() }).catch((e: unknown) => e);
    expect(resumed.account.state.groups.has('sg-0proxy000')).toBe(false);
    expect(await removeKubernetesProxies(resumed.account.ports, proxiesOf(failed)!, { now: resumed.now() })).toMatchObject({ status: 'done', remaining: [] });
    const calls = [...s.account.state.calls, ...gone.account.state.calls, ...resumed.account.state.calls];
    const key = ([action, resource, context]: [string, string, Record<string, string>?]) => JSON.stringify([action, resource, context ?? {}]);
    const listed = new Set(KUBE_PROXY_CALLS.map(key));
    const made = new Set(calls.map(key));
    expect(made.size).toBeGreaterThan(25);
    for (const call of calls) {
      expect(listed.has(key(call)), `${key(call)} is in KUBE_PROXY_CALLS`).toBe(true);
      expect(allows(...call), `${key(call)} is allowed`).toBe(true);
    }
  });

  it('a cluster open to every address gets no proxy, and the proxy made for it earlier is removed', async () => {
    const s = setup([cluster('eks-demo')]);
    expect((await s.step()).outcomes).toEqual([{ cluster: 'eks-demo', status: 'skipped', detail: 'cluster eks-demo: reached directly' }]);
    expect(s.account.writes()).toEqual([]);
    // Made private, then opened again (private access kept on: still direct).
    Object.assign(s.clusters[0]!.resourcesVpcConfig, { endpointPublicAccess: false, endpointPrivateAccess: true });
    await s.step();
    expect(s.proxies()).toEqual([RECORD]);
    Object.assign(s.clusters[0]!.resourcesVpcConfig, { endpointPublicAccess: true });
    const result = await s.step();
    expect(result).toEqual({ outcomes: [{ cluster: 'eks-demo', status: 'done', detail: `cluster eks-demo: reached directly; its proxy ${FN} removed` }], proxies: [] });
    const { state } = s.account;
    expect([state.functions.size, state.roles.size, state.logGroups.size, state.interfaces.size, state.groups.has('sg-0proxy000')]).toEqual([0, 0, 0, 0, false]);
    expect(state.groups.get('sg-0cluster00')!.ingress).toEqual([{ IpProtocol: '-1', GroupId: 'sg-0cluster00' }]);
  });

  it('a cluster whose public endpoint is limited to some addresses and private access off is skipped, saying to turn private access on', async () => {
    const s = setup([cluster('office', { cidrs: ['198.51.100.0/24'] })]);
    expect((await s.step()).outcomes).toEqual([{ cluster: 'office', status: 'skipped', detail: `cluster office: ${UNREACHABLE}` }]);
    expect(s.account.writes()).toEqual([]);
  });

  // EKS made a cluster security group for every cluster from platform eks.3 on (2019): an older one has none to admit the proxy.
  it('a private cluster without a cluster security group is skipped, saying so', async () => {
    const old = privateCluster();
    delete (old.resourcesVpcConfig as { clusterSecurityGroupId?: string }).clusterSecurityGroupId;
    const s = setup([old]);
    expect((await s.step()).outcomes).toEqual([{ cluster: 'eks-demo', status: 'skipped', detail: 'cluster eks-demo: no cluster security group (resourcesVpcConfig.clusterSecurityGroupId) to admit its proxy' }]);
    expect(s.account.writes()).toEqual([]);
  });

  it('the proxy of a cluster that no longer exists is removed (its cluster security group went with it)', async () => {
    const s = setup([privateCluster(), cluster('open')]);
    await s.step();
    s.clusters.splice(0, 1);
    s.account.state.groups.delete('sg-0cluster00');
    // While Lambda holds its network interfaces, the step waits; the function's deletion is recorded with the proxy (the
    // hour of waiting counts from it).
    expect((await s.once()).outcomes).toEqual([
      { cluster: 'open', status: 'skipped', detail: 'cluster open: reached directly' },
      { cluster: 'eks-demo', status: 'pending', seconds: 30, changed: true, detail: expect.stringMatching(new RegExp(`^cluster eks-demo no longer exists: its proxy ${FN} deleted, waiting for Lambda to release its network interfaces \\(eni-0\\w+, eni-0\\w+\\)$`)) },
    ]);
    expect(s.proxies()).toEqual([{ ...RECORD, deletedAt: iso(s.now()) }]);
    const result = await s.step();
    expect(result).toEqual({
      outcomes: [{ cluster: 'open', status: 'skipped', detail: 'cluster open: reached directly' }, { cluster: 'eks-demo', status: 'done', detail: `cluster eks-demo no longer exists: its proxy ${FN} removed` }],
      proxies: [],
    });
    expect([...s.account.state.groups.keys()]).toEqual(['sg-0cluster-open']);
  });

  it('an existing proxy whose egress names the cluster security group (an earlier form), and a VPC with a new block: the egress follows the VPC, nothing else', async () => {
    const s = setup();
    await s.step();
    s.account.state.groups.get('sg-0proxy000')!.egress = [{ ...RULE_443, GroupId: 'sg-0cluster00', Description: 'Kubernetes API of cluster eks-demo' }];
    s.account.state.vpcs.get('vpc-0a1b2c3d')!.push({ CidrBlock: '10.2.0.0/16', State: 'associated' });
    s.account.state.ops.length = 0;
    await s.step();
    expect(s.account.state.groups.get('sg-0proxy000')!.egress).toEqual([...EGRESS, toBlock('10.2.0.0/16')]);
    expect(s.account.writes()).toEqual(['authorizeSecurityGroupEgress', 'revokeSecurityGroupEgress']);
  });

  it('a rule already there (InvalidPermission.Duplicate) is done, as a rule or group already gone at removal: the step runs again', async () => {
    const s = setup();
    const { ec2 } = s.account.ports;
    // Another run added the rules meanwhile.
    for (const name of ['authorizeSecurityGroupEgress', 'authorizeSecurityGroupIngress'] as const) {
      const authorize = ec2[name];
      ec2[name] = async (input: unknown) => {
        await authorize(input);
        throw ec2Error('InvalidPermission.Duplicate', 'the specified rule "peer: sg-0cluster00, TCP, from port: 443, to port: 443, ALLOW" already exists');
      };
    }
    expect((await s.step()).proxies).toEqual([RECORD]);
    expect(s.account.state.groups.get('sg-0cluster00')!.ingress).toContainEqual({ ...RULE_443, GroupId: 'sg-0proxy000', Description: `Dormeto Kubernetes proxy ${FN}` });
    // The customer removed the rule; the group is deleted by another run as this one deletes it.
    s.account.state.groups.get('sg-0cluster00')!.ingress = [];
    const remove = ec2.deleteSecurityGroup;
    ec2.deleteSecurityGroup = async (input: { GroupId: string }) => {
      await remove(input);
      throw ec2Error('InvalidGroup.NotFound', `The security group '${input.GroupId}' does not exist`);
    };
    s.clusters.splice(0, 1);
    expect((await s.step()).proxies).toEqual([]);
    expect(s.account.state.groups.has('sg-0proxy000')).toBe(false);
  });

  // Ruling 19: the organization access to apply is the running manager's (its version given), never a number in the code.
  it('a command role without this manager\'s organization access refuses the security group: nothing is made, and the error names the access of the manager running', async () => {
    const s = setup([privateCluster(), cluster('open')]);
    const refusal = 'You are not authorized to perform this operation. User: arn:aws:sts::222222222222:assumed-role/DmtCommandRole/dmt-dev-operations is not authorized to perform: ec2:CreateSecurityGroup';
    s.account.state.deny.createSecurityGroup = ec2Error('UnauthorizedOperation', refusal);
    const err = await s.step({ managerVersion: '0.21.3' }).catch((e: unknown) => e) as KubeProxyAccessDenied;
    expect(err).toBeInstanceOf(KubeProxyAccessDenied);
    expect(err.message).toBe(`cluster eks-demo: the command role may not set up its Kubernetes proxy: apply the organization access of manager 0.21.3 (${refusal})`);
    expect(err.clusters).toEqual(['eks-demo']);
    expect([s.account.state.roles.size, s.account.state.logGroups.size, s.account.state.functions.size, s.proxies()]).toEqual([0, 0, 0, []]);
    // Its version unknown (no VERSION, or a build without its manifest): this manager's release.
    for (const managerVersion of [undefined, '', 'missing']) {
      const unknown = await s.step({ managerVersion }).catch((e: unknown) => e) as KubeProxyAccessDenied;
      expect(unknown.message, String(managerVersion)).toBe(`cluster eks-demo: the command role may not set up its Kubernetes proxy: apply the organization access of this manager's release (${refusal})`);
    }
  });

  it('a cluster made again under the same name (new endpoint, new cluster security group): its proxy follows it', async () => {
    const s = setup();
    await s.step();
    s.account.state.groups.delete('sg-0cluster00');
    s.clusters[0] = privateCluster('eks-demo', { group: 'sg-0cluster01', endpoint: 'https://EKSDEMO0A1C.gr7.eu-west-1.eks.amazonaws.com' });
    s.account.addClusterGroup(s.clusters[0]);
    expect((await s.step()).proxies).toEqual([{ ...RECORD, clusterSecurityGroupId: 'sg-0cluster01' }]);
    const { state } = s.account;
    expect(state.groups.get('sg-0proxy000')!.egress).toEqual(EGRESS);
    expect(state.groups.get('sg-0cluster01')!.ingress).toContainEqual({ ...RULE_443, GroupId: 'sg-0proxy000', Description: `Dormeto Kubernetes proxy ${FN}` });
    expect(state.functions.get(FN)!.config.Environment.Variables).toMatchObject({ DMT_ENDPOINT: 'https://EKSDEMO0A1C.gr7.eu-west-1.eks.amazonaws.com', DMT_CA: pem('eks-demo') });
  });

  it('a cluster made again in another VPC: its proxy is removed, then made again there', async () => {
    const s = setup();
    await s.step();
    s.account.state.groups.delete('sg-0cluster00');
    s.clusters[0] = privateCluster('eks-demo', { vpc: 'vpc-0e5f6a7b', group: 'sg-0cluster02' });
    s.account.addClusterGroup(s.clusters[0]);
    expect((await s.step()).proxies).toEqual([{ ...RECORD, securityGroupId: 'sg-0proxy001', clusterSecurityGroupId: 'sg-0cluster02', vpcId: 'vpc-0e5f6a7b' }]);
    expect(s.account.state.groups.has('sg-0proxy000')).toBe(false);
    expect(s.account.state.functions.get(FN)!.config.VpcConfig.SecurityGroupIds).toEqual(['sg-0proxy001']);
    expect(s.account.state.groups.get('sg-0proxy001')!.egress).toEqual([toBlock('10.1.0.0/16')]);
  });

  it('names the function, its security group and its role by the rule the router shares (kube-proxy-names.json)', async () => {
    for (const c of names) {
      const s = setup([privateCluster(c.cluster)]);
      await s.step({ kubeProxy: { ...KUBE_PROXY, namePrefix: c.prefix, rolePrefix: c.prefix } });
      expect([...s.account.state.functions.keys()], c.cluster).toEqual([c.name]);
      expect([...s.account.state.groups.values()].filter((g) => g.Tags['dormeto:role']).map((g) => g.GroupName), c.cluster).toEqual([c.name]);
      expect([...s.account.state.roles.keys()], c.cluster).toEqual([c.name]);
      expect(s.proxies()[0], c.cluster).toMatchObject({ function: c.name, role: c.name, logGroup: `/aws/lambda/${c.name}` });
    }
  });
});

describe('removing the Kubernetes proxies', () => {
  it('deletes the function, waits until Lambda released its network interfaces, then revokes the rule and deletes the group, the role and the log group', async () => {
    const s = setup();
    await s.step();
    s.account.state.releaseReads = 2;
    const t0 = s.now();
    const ops: string[][] = [];
    const results = [];
    let proxies = [RECORD];
    for (let i = 0; i < 4; i += 1) {
      s.account.state.ops.length = 0;
      const result = await removeKubernetesProxies(s.account.ports, proxies, { now: t0 + i * 30_000 });
      results.push(result);
      proxies = result.remaining;
      ops.push([...s.account.state.ops]);
    }
    const held = new RegExp(`^cluster eks-demo: proxy ${FN} deleted, waiting for Lambda to release its network interfaces \\(eni-0\\w+, eni-0\\w+\\)$`);
    const deleted = { ...RECORD, deletedAt: iso(t0) };
    expect(results.slice(0, 3)).toEqual([
      { status: 'wait', remaining: [deleted], detail: expect.stringMatching(held) },
      { status: 'wait', remaining: [deleted], detail: expect.stringMatching(held) },
      { status: 'done', remaining: [], detail: `cluster eks-demo: proxy ${FN} removed` },
    ]);
    // The groups looked up before the calls on them (a group gone has no tag the policy could allow).
    expect(ops.slice(0, 3)).toEqual([
      ['deleteFunction', 'describeNetworkInterfaces'],
      ['deleteFunction', 'describeNetworkInterfaces'],
      ['deleteFunction', 'describeNetworkInterfaces', 'describeSecurityGroups', 'revokeSecurityGroupIngress', 'deleteSecurityGroup', 'listRolePolicies', 'deleteRolePolicy', 'deleteRole', 'deleteLogGroup'],
    ]);
    expect(results[3]).toEqual({ status: 'done', remaining: [], detail: 'no proxy' });
    const { state } = s.account;
    expect([state.functions.size, state.roles.size, state.logGroups.size, state.interfaces.size, state.groups.has('sg-0proxy000')]).toEqual([0, 0, 0, 0, false]);
    expect(state.groups.get('sg-0cluster00')!.ingress).toEqual([{ IpProtocol: '-1', GroupId: 'sg-0cluster00' }]);
  });

  it('fails an hour after the function\'s deletion (recorded with the proxy), naming the network interfaces Lambda still holds; a later removal finishes it', async () => {
    const s = setup();
    await s.step();
    s.account.state.held.add(FN);
    const t0 = s.now();
    const deleted = { ...RECORD, deletedAt: iso(t0) };
    const first = await removeKubernetesProxies(s.account.ports, [RECORD], { now: t0 });
    expect(first).toMatchObject({ status: 'wait', remaining: [deleted] });
    expect((await removeKubernetesProxies(s.account.ports, first.remaining, { now: t0 + 59 * 60_000 })).status).toBe('wait');
    const err = await removeKubernetesProxies(s.account.ports, first.remaining, { now: t0 + 61 * 60_000 }).catch((e: unknown) => e) as Error;
    const ids = [...s.account.state.interfaces.keys()];
    expect(ids).toHaveLength(2);
    expect(err.message).toBe(`cluster eks-demo: Lambda still holds the network interfaces ${ids.join(', ')} of the proxy ${FN} an hour after its function was deleted`);
    expect(proxiesOf(err)).toEqual([deleted]);
    // A new operation does not start the hour again.
    const again = await removeKubernetesProxies(s.account.ports, proxiesOf(err)!, { now: t0 + 62 * 60_000 }).catch((e: unknown) => e) as Error;
    expect(again.message).toBe(err.message);
    // Released since: the next operation removes what is left.
    s.account.state.held.clear();
    s.account.state.interfaces.clear();
    expect(await removeKubernetesProxies(s.account.ports, proxiesOf(again)!, { now: t0 + 2 * 60 * 60_000 })).toEqual({ status: 'done', remaining: [], detail: `cluster eks-demo: proxy ${FN} removed` });
    expect(s.account.state.groups.has('sg-0proxy000')).toBe(false);
  });

  it('counts each proxy\'s hour from its own function\'s deletion', async () => {
    const s = setup([privateCluster(), privateCluster('eks-other')]);
    await s.step();
    const [demo, other] = s.proxies();
    s.account.state.held.add(FN).add('dmtr-dev-kube-eks-other');
    const t0 = s.now();
    // eks-demo's function deleted by an earlier operation 50 minutes ago.
    await s.account.ports.lambda.deleteFunction({ FunctionName: FN });
    const earlier = { ...demo!, deletedAt: iso(t0 - 50 * 60_000) };
    const first = await removeKubernetesProxies(s.account.ports, [earlier, other!], { now: t0 });
    expect(first).toMatchObject({ status: 'wait', remaining: [earlier, { ...other!, deletedAt: iso(t0) }] });
    const err = await removeKubernetesProxies(s.account.ports, first.remaining, { now: t0 + 11 * 60_000 }).catch((e: unknown) => e) as Error;
    expect(err.message).toMatch(new RegExp(`^cluster eks-demo: Lambda still holds the network interfaces eni-0\\w+, eni-0\\w+ of the proxy ${FN} an hour after its function was deleted$`));
    expect(proxiesOf(err)).toEqual(first.remaining);
  });

  it('removing several proxies keeps those still waiting, and a resumed removal finishes with them', async () => {
    const s = setup([privateCluster(), privateCluster('eks-other')]);
    await s.step();
    const [demo, other] = s.proxies();
    expect([demo!.cluster, other!.cluster]).toEqual(['eks-demo', 'eks-other']);
    s.account.state.releaseReads = 0;
    s.account.state.held.add('dmtr-dev-kube-eks-other');
    const t0 = s.now();
    const first = await removeKubernetesProxies(s.account.ports, [demo!, other!], { now: t0 });
    expect(first).toMatchObject({ status: 'wait', remaining: [other] });
    expect(first.detail).toMatch(new RegExp(`^cluster eks-demo: proxy ${FN} removed; cluster eks-other: proxy dmtr-dev-kube-eks-other deleted, waiting for Lambda`));
    s.account.state.held.clear();
    expect(await removeKubernetesProxies(s.account.ports, first.remaining, { now: t0 + 30_000 })).toEqual({ status: 'done', remaining: [], detail: 'cluster eks-other: proxy dmtr-dev-kube-eks-other removed' });
    expect([...s.account.state.groups.keys()].filter((id) => id.startsWith('sg-0proxy'))).toEqual([]);
  });
});
