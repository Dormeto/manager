import { describe, expect, it } from 'vitest';
import { accessOf, atLeastCore, compareVersions, consoleUrl, offered, requestId, summarizePlan, type VersionEntry } from '../src/update.js';

// The real sections of the repository's CHANGELOG.md.
const V0_11 = `## 0.11.0 — 2026-10-17

Router 0.29.0. Access: nothing to apply again (the access and organization modules and the AWS CLI script are
unchanged).

- The manager module's \`organization_id\` is optional, for \`dormeto install\`'s account deployment (a manager in an account
  outside any organization): without it the manager assumes the discovery and command roles, and accepts the routers'
  events and lists, within its own account only. The new \`discovery_mode\` input (\`organization\` by default, or
  \`account\`, required without an organization) is the mode of the discovery perimeter's default configuration, the one an
  administrator has not saved yet (\`DISCOVERY_MODE\` of the API and of discovery).
- The savings estimate before install is now the Dormeto CLI (https://github.com/Dormeto/cli, 0.1.0 on 2026-10-13:
  Homebrew, the install script, \`go install\`, and the release's zip on Windows): \`dormeto estimate --profile <profile>\`.
  The repository's \`npm run estimate\` and \`packages/estimate\`, never released, are removed.
- The release script's \`--version\` and \`--out\` build a release locally, before it is published (the changelog's Unreleased
  section stands for a version without its own); \`--publish\` stays for the package's version.
`;
const V0_10 = `## 0.10.0 — 2026-10-11

Router 0.29.0. Access: apply the access module or the AWS CLI script of this release again in every member account:
\`DmtDiscoveryRole\` reads the EKS clusters (\`eks:ListClusters\`, \`eks:DescribeCluster\`) and the instances behind a target
group (\`ec2:DescribeInstances\`: a cluster's nodes are never offered to nap); \`DmtCommandRole\` manages the
routers' EKS access entries (statements \`EksClusters\`, \`EksAccessEntries\`, \`EksAccessEntriesDiscovery\`,
\`EksAccessEntriesRemoved\`, \`EksDiscoveryView\`: the routers' roles in the Kubernetes group \`dormeto:router\` and
\`DmtDiscoveryRole\` with \`AmazonEKSViewPolicy\`, in no group, nothing else); the routers' permissions boundary allows \`eks:DescribeCluster\`. Then upgrade the routers to 0.29.0 (the upgrade
makes the access entries in the account and region's clusters) and apply \`dormeto-kubernetes-0.10.0.yaml\` of the release
in each cluster whose workloads Dormeto should nap (\`kubectl apply -f\`). Without them nothing changes for the other
workloads: a router upgraded first skips its access entries and says what to apply, and Kubernetes candidates are not
onboardable, with the reason.

- Kubernetes workloads on Amazon EKS: a target group of the AWS Load Balancer Controller (from an Ingress or a
  TargetGroupBinding) serving the pods of one Deployment or StatefulSet is napped by scaling it to 0 and woken by giving
  back its replicas (routers 0.29.0). A KEDA ScaledObject is paused for the nap; an HPA needs nothing. The cluster's API
  endpoint must be public and open to every address (private clusters wait for the in-cluster agent).
- Discovery reads the clusters of each account and region and traces each Kubernetes target group to its owner (pods by
  address, the ReplicaSet, the Deployment or StatefulSet), with its Ingress or TargetGroupBinding, HPA, KEDA
  ScaledObject, GitOps owner (Argo CD, Flux), capacity (Fargate or nodes) and node autoscaler (Karpenter, Cluster
  Autoscaler). Ineligible, with the reason: a private endpoint, pods of several owners, pods of a DaemonSet or a Job, a
  ScaledObject that already scales to zero, access missing. A cluster's nodes behind an instance target group (a
  NodePort Service, a TargetGroupBinding in instance mode) and a node group's Auto Scaling group are never offered as
  instances or a group to nap.
- Installing or upgrading a router makes the access entries of its roles in the clusters of its account and region,
  and asks the router what it may do there (the router's view lists the clusters, their reach and the rights missing);
  a cluster on \`aws-auth\` only, or one the router cannot reach, is left with the procedure. Removing a router deletes
  its roles' entries (EKS keeps an entry whose role is gone, and it does not work for a router installed again).
- Onboarding a Kubernetes workload adds Dormeto's Ingress to the customer's IngressGroup (the customer's Ingress is never
  changed), or patches a lone Ingress (restored exactly at offboarding), or instruments a TargetGroupBinding's rules as
  any other; the dialog says which, gives the Argo CD or Flux snippet when a GitOps owner was found, and the access
  check's result. Its wake timeout defaults to 5 minutes (pods may wait for a node).
- Savings: Fargate pods are priced as Fargate; pods on EC2 nodes as their share of their node's price (the larger of
  their CPU and memory requests over the node's allocatable, Spot as Spot, the compute discount applied), only where a
  node autoscaler removes the nodes they free ("nothing saved: the nodes stay" otherwise). The control plane and the
  nodes' DaemonSets are not saved; pods without requests are not priced.
- The release carries \`dormeto-kubernetes-<version>.yaml\`: the rights of the group \`dormeto:router\` (a ClusterRole with
  exactly what the router checks, its binding, and an admission policy keeping the group's Ingress creations and
  deletions to Dormeto's own, Kubernetes 1.30 or later).
`;

const reason = 'run `dormeto install` with the CLI 0.2.0 or later';
const entry = (version: string, minCli: string | null = '0.2.0'): VersionEntry => ({ version, router: '0.29.0', minCli, published: '2026-10-20T10:00:00Z' });

describe('compareVersions', () => {
  it('orders the numbers, then a pre-release before its release', () => {
    expect(compareVersions('0.10.0', '0.11.0')).toBeLessThan(0);
    expect(compareVersions('0.9.9', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('0.12.0-dev.1', '0.12.0-dev.2')).toBeLessThan(0);
    expect(compareVersions('0.12.0-dev.2', '0.12.0')).toBeLessThan(0);
    expect(compareVersions('0.12.0', '0.12.0-dev.2')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });
  it('throws on a version that is not x.y.z', () => {
    expect(() => compareVersions('dev', '0.1.0')).toThrow();
    expect(() => compareVersions('0.1.0', '0.1')).toThrow();
  });
});

describe('atLeastCore', () => {
  it('compares the three numbers only', () => {
    expect(atLeastCore('0.2.0-dev', '0.2.0')).toBe(true);
    expect(atLeastCore('0.10.0', '0.2.0')).toBe(true);
    expect(atLeastCore('0.1.0-57-gc7e49cb', '0.2.0')).toBe(false);
    expect(atLeastCore('dev', '0.2.0')).toBe(false);
  });
});

describe('offered', () => {
  it('lists the entries newer than the running version, newest first', () => {
    const l = offered([entry('0.12.0'), entry('0.11.0'), entry('0.10.0')], '0.11.0', '0.2.0', null);
    expect(l.map((e) => e.version)).toEqual(['0.12.0']);
    expect(l[0]?.disabled).toBeUndefined();
    const m = offered([entry('0.12.0'), entry('0.13.0')], '0.11.0', '0.2.0', null);
    expect(m.map((e) => e.version)).toEqual(['0.13.0', '0.12.0']);
  });
  it('disables an entry the install CLI is too old for', () => {
    expect(offered([entry('0.12.0')], '0.11.0', '0.1.0', null)[0]?.disabled).toBe(reason);
  });
  it('names the entry minCli in the reason, 0.2.0 when it has none', () => {
    expect(offered([entry('0.12.0', '0.3.1')], '0.11.0', '0.2.0', null)[0]?.disabled).toBe('run `dormeto install` with the CLI 0.3.1 or later');
    expect(offered([entry('0.12.0', null)], '0.11.0', null, null)[0]?.disabled).toBe(reason);
    expect(offered([entry('0.12.0', null)], '0.11.0', '0.1.0', null)[0]?.disabled).toBeUndefined();
  });
  it('disables every entry when the CLI is unknown', () => {
    const l = offered([entry('0.12.0'), entry('0.13.0')], '0.11.0', null, null);
    expect(l.map((e) => e.disabled)).toEqual([reason, reason]);
  });
  it('adds the staged entry when newer, unless a published one has its version', () => {
    const staged = { ...entry('0.12.0-dev.2'), staged: true };
    const l = offered([entry('0.11.0')], '0.12.0-dev.1', '0.2.0', staged);
    expect(l).toEqual([{ ...staged }]);
    expect(offered([], '0.12.0-dev.2', '0.2.0', staged)).toEqual([]);
    const pub = entry('0.12.0-dev.2');
    expect(offered([pub], '0.12.0-dev.1', '0.2.0', staged)).toEqual([pub]);
  });
  it('skips a version that is not x.y.z', () => {
    expect(offered([entry('latest'), entry('0.12.0')], '0.11.0', '0.2.0', null).map((e) => e.version)).toEqual(['0.12.0']);
  });
});

describe('summarizePlan', () => {
  const rc = (address: string, actions: string[]) => ({ address, change: { actions } });
  it('counts like the CLI: a replacement adds and destroys, and is listed as replaced', () => {
    const plan = JSON.stringify({
      format_version: '1.2',
      resource_changes: [
        rc('a.new', ['create']), rc('a.upd', ['update']), rc('a.gone', ['delete']),
        rc('a.swap', ['delete', 'create']), rc('a.swap2', ['create', 'delete']), rc('a.same', ['no-op']), rc('a.data', ['read']),
      ],
    });
    expect(summarizePlan(plan)).toEqual({ add: 3, change: 1, destroy: 3, replaced: ['a.swap', 'a.swap2'], destroyed: ['a.gone'] });
  });
  it('sorts both lists', () => {
    const plan = JSON.stringify({ format_version: '1.2', resource_changes: [rc('z', ['delete']), rc('b', ['delete']), rc('y', ['delete', 'create']), rc('c', ['delete', 'create'])] });
    const s = summarizePlan(plan);
    expect(s.destroyed).toEqual(['b', 'z']);
    expect(s.replaced).toEqual(['c', 'y']);
  });
  it('is all zero without resource_changes, and throws on what is not a plan', () => {
    expect(summarizePlan('{"format_version":"1.2"}')).toEqual({ add: 0, change: 0, destroy: 0, replaced: [], destroyed: [] });
    expect(() => summarizePlan('{"a":1}')).toThrow('not a Terraform plan');
    expect(() => summarizePlan('nope')).toThrow();
  });
});

describe('accessOf', () => {
  it('unwraps the Access sentence of 0.10.0, which needs applying again', () => {
    const a = accessOf(V0_10);
    expect(a.accessNeeded).toBe(true);
    expect(a.access).toMatch(/^Access: apply the access module or the AWS CLI script of this release again in every member account: /);
    expect(a.access).not.toContain('\n');
    expect(a.access).toContain('(the upgrade makes the access entries');
    expect(a.access).toMatch(/not onboardable, with the reason\.$/);
  });
  it('says 0.11.0 needs nothing', () => {
    expect(accessOf(V0_11)).toEqual({
      access: 'Access: nothing to apply again (the access and organization modules and the AWS CLI script are unchanged).',
      accessNeeded: false,
    });
  });
  it('accepts a body without its heading, and no Access paragraph', () => {
    expect(accessOf(V0_11.split('\n').slice(1).join('\n')).accessNeeded).toBe(false);
    expect(accessOf('- a change\n')).toEqual({ access: null, accessNeeded: false });
  });
});

describe('requestId', () => {
  it('is the UTC time and the random part', () => {
    expect(requestId(new Date('2026-10-20T10:00:00Z'), 'a1b2c3d4')).toBe('20261020T100000Z-a1b2c3d4');
    expect(requestId(new Date('2026-01-02T03:04:05.678Z'), '0123abcd')).toBe('20260102T030405Z-0123abcd');
  });
  it('refuses a random part that is not 8 lowercase hex', () => {
    expect(() => requestId(new Date(0), 'XYZ')).toThrow();
    expect(() => requestId(new Date(0), 'A1B2C3D4')).toThrow();
  });
});

describe('consoleUrl', () => {
  it('is the build\'s CodeBuild console page, its region and account from its ARN, its id encoded', () => {
    expect(consoleUrl('arn:aws:codebuild:eu-west-1:121014831971:build/dmt-prod-install:6f1e2d3c-0000-4a5b-8c9d-0123456789ab')).toBe(
      'https://eu-west-1.console.aws.amazon.com/codesuite/codebuild/121014831971/projects/dmt-prod-install/build/dmt-prod-install%3A6f1e2d3c-0000-4a5b-8c9d-0123456789ab/?region=eu-west-1',
    );
    expect(consoleUrl('arn:aws:codebuild:ap-southeast-2:038606077307:build/dmt-dev-install:00000000-0000-0000-0000-000000000001')).toBe(
      'https://ap-southeast-2.console.aws.amazon.com/codesuite/codebuild/038606077307/projects/dmt-dev-install/build/dmt-dev-install%3A00000000-0000-0000-0000-000000000001/?region=ap-southeast-2',
    );
  });
  it('is null for an ARN that does not parse', () => {
    for (const arn of [
      null, undefined, '', 'dmt-prod-install:6f1e2d3c', 'arn:aws:codebuild:eu-west-1:121014831971:project/dmt-prod-install',
      'arn:aws:codebuild:eu-west-1:1210148319:build/dmt-prod-install:6f1e2d3c', 'arn:aws:s3:eu-west-1:121014831971:build/dmt-prod-install:6f1e2d3c',
      'arn:aws:codebuild:eu-west-1:121014831971:build/dmt-prod-install', 'arn:aws:codebuild:eu-west-1:121014831971:build/a/b:6f1e2d3c',
      'arn:aws:codebuild:evil.example/x:121014831971:build/dmt-prod-install:6f1e2d3c',
    ]) expect(consoleUrl(arn)).toBeNull();
  });
});
