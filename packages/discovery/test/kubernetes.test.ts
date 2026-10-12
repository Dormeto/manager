// Kubernetes workloads in discovery (vision docs/specs/2026-10-11-kubernetes-design.md, sections 3 to 5): a target group
// traced to its owner through the cluster API, with the switching mode, GitOps, HPA, KEDA, capacity and autoscaler.
import { describe, expect, it } from 'vitest';
import { clustersOf, kubernetesBackend, type KubeClient, type KubernetesPorts } from '../src/kubernetes.js';
import { DISCOVERY_ACTIONS, scanRegion } from '../src/scan.js';
import { TGS, scanPorts } from './scan-fakes.js';

const NS = 'demo';
const pod = (name: string, ip: string, owner?: { kind: string; name: string }, extra: Record<string, unknown> = {}) => ({
  metadata: { name, namespace: NS, labels: { app: name.split('-')[0] }, ...(owner ? { ownerReferences: [{ kind: owner.kind, name: owner.name, controller: true }] } : {}) },
  spec: { nodeName: 'ip-10-0-1-1.eu-west-1.compute.internal', schedulerName: 'default-scheduler', ...extra },
  status: { phase: 'Running', podIP: ip },
});
const rs = (name: string, deployment: string) => ({ metadata: { name, namespace: NS, ownerReferences: [{ kind: 'Deployment', name: deployment, controller: true }] } });
const owner = (kind: string, name: string, metadata: Record<string, unknown> = {}) => ({ kind, metadata: { name, namespace: NS, ...metadata }, spec: { replicas: 2, selector: { matchLabels: { app: name } } } });
const ingress = (name: string, service: string, annotations: Record<string, string> = {}) => ({
  metadata: { name, namespace: NS, annotations },
  spec: { rules: [
    { host: 'docs.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'docs', port: { number: 80 } } } }] } },
    { host: `${service}.example.com`, http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: service, port: { number: 80 } } } }] } },
  ] },
});
const service = (name: string, selector: Record<string, string>) => ({ metadata: { name, namespace: NS }, spec: { selector, ports: [{ port: 80 }] } });

type Objects = Record<string, unknown[]>; // collection path → objects
// A cluster's API: lists by collection path, gets by collection path and name; refuse: every call fails with it.
function cluster(objects: Objects, { refuse, karpenter = true }: { refuse?: Error; karpenter?: boolean } = {}): KubeClient & { calls: string[] } {
  const calls: string[] = [];
  const notFound = (path: string) => Object.assign(new Error(`${path} not found`), { name: 'KubernetesError', status: 404, reason: 'NotFound' });
  return {
    calls,
    async get(path) {
      calls.push(`GET ${path}`);
      if (refuse) throw refuse;
      if (path === '/apis/karpenter.sh/v1') { if (karpenter) return { kind: 'APIResourceList' }; throw notFound(path); }
      const at = path.lastIndexOf('/');
      const found = (objects[path.slice(0, at)] as { metadata: { name: string } }[] | undefined)?.find((o) => o.metadata.name === path.slice(at + 1));
      if (!found) throw notFound(path);
      return structuredClone(found);
    },
    async list(path) {
      calls.push(`LIST ${path}`);
      if (refuse) throw refuse;
      if (!(path in objects)) {
        if (path.includes('keda.sh')) throw notFound(path);
        return [];
      }
      return structuredClone(objects[path]!);
    },
  };
}

// The demo cluster: web (a Deployment behind a grouped Ingress, an HPA, Argo CD), cache (a StatefulSet behind a lone
// Ingress, on Fargate), and pods Dormeto must not take for workloads.
function demo(extra: Objects = {}): Objects {
  return {
    '/api/v1/pods': [
      pod('web-5d9c-a1', '10.0.1.1', { kind: 'ReplicaSet', name: 'web-5d9c' }), pod('web-5d9c-a2', '10.0.1.2', { kind: 'ReplicaSet', name: 'web-5d9c' }),
      pod('cache-0', '10.0.2.1', { kind: 'StatefulSet', name: 'cache' }, { schedulerName: 'fargate-scheduler', nodeName: 'fargate-ip-10-0-2-1.eu-west-1.compute.internal' }),
      pod('agent-x1', '10.0.3.1', { kind: 'DaemonSet', name: 'agent' }), pod('migrate-q', '10.0.3.2', { kind: 'Job', name: 'migrate' }), pod('lonely', '10.0.3.3'),
      pod('api-1a-b', '10.0.4.1', { kind: 'ReplicaSet', name: 'api-1a' }), pod('api2-2b-c', '10.0.4.2', { kind: 'ReplicaSet', name: 'api2-2b' }),
    ],
    [`/apis/apps/v1/namespaces/${NS}/replicasets`]: [rs('web-5d9c', 'web'), rs('api-1a', 'api'), rs('api2-2b', 'api2')],
    [`/apis/apps/v1/namespaces/${NS}/deployments`]: [
      owner('Deployment', 'web', { labels: { 'app.kubernetes.io/instance': 'web' }, annotations: { 'argocd.argoproj.io/tracking-id': 'web:apps/Deployment:demo/web' } }),
      owner('Deployment', 'api'), owner('Deployment', 'api2'),
    ],
    [`/apis/apps/v1/namespaces/${NS}/statefulsets`]: [owner('StatefulSet', 'cache', { labels: { 'kustomize.toolkit.fluxcd.io/name': 'apps' } })],
    [`/api/v1/namespaces/${NS}/services`]: [service('web', { app: 'web' }), service('cache', { app: 'cache' })],
    [`/apis/networking.k8s.io/v1/namespaces/${NS}/ingresses`]: [
      ingress('web', 'web', { 'alb.ingress.kubernetes.io/group.name': 'demo-group', 'alb.ingress.kubernetes.io/group.order': '10' }),
      ingress('cache', 'cache'),
    ],
    [`/apis/autoscaling/v2/namespaces/${NS}/horizontalpodautoscalers`]: [{ metadata: { name: 'web' }, spec: { scaleTargetRef: { kind: 'Deployment', name: 'web' } } }],
    [`/apis/keda.sh/v1alpha1/namespaces/${NS}/scaledobjects`]: [],
    ...extra,
  };
}

const CLUSTER = (name: string, vpc: Record<string, unknown> = { endpointPublicAccess: true, publicAccessCidrs: ['0.0.0.0/0'], vpcId: 'vpc-1' }) => ({
  name, endpoint: `https://${name}.example`, version: '1.36', certificateAuthority: { data: '' }, resourcesVpcConfig: vpc, accessConfig: { authenticationMode: 'API' },
});
function ports(clusters: Record<string, { cluster: ReturnType<typeof CLUSTER>; client: KubeClient }>): KubernetesPorts {
  return {
    eks: {
      async listClusters() { return { clusters: Object.keys(clusters) }; },
      async describeCluster({ name }) { return { cluster: clusters[name]!.cluster }; },
    },
    kubernetesOf: async (name) => clusters[name]!.client,
  };
}
const ARN = 'arn:aws:elasticloadbalancing:eu-west-1:111122223333:targetgroup';
const group = (name: string, type: string, targets: string[], tags: Record<string, string> = {}) => ({ arn: `${ARN}/${name}/1`, type, vpcId: 'vpc-1', tags, targets });
const controllerTags = (resource: string) => ({ 'elbv2.k8s.aws/cluster': 'eks-demo', 'ingress.k8s.aws/stack': 'demo-group', 'ingress.k8s.aws/resource': resource });

describe('Kubernetes discovery', () => {
  it('reads the clusters of the region, those it cannot reach with the reason', async () => {
    const found = await clustersOf(ports({
      'eks-demo': { cluster: CLUSTER('eks-demo'), client: cluster(demo()) },
      private: { cluster: CLUSTER('private', { endpointPublicAccess: false, endpointPrivateAccess: true, vpcId: 'vpc-1' }), client: cluster({}) },
      office: { cluster: CLUSTER('office', { endpointPublicAccess: true, publicAccessCidrs: ['198.51.100.0/24'], vpcId: 'vpc-1' }), client: cluster({}) },
      denied: { cluster: CLUSTER('denied'), client: cluster({}, { refuse: Object.assign(new Error('Unauthorized'), { name: 'KubernetesError', status: 401 }) }) },
    }));
    expect(found.map((c) => [c.name, c.reason ?? null])).toEqual([
      ['eks-demo', null],
      ['private', 'the cluster\'s endpoint is private (or limited to some addresses): Dormeto reaches it with the in-cluster agent (R10.6)'],
      ['office', 'the cluster\'s endpoint is private (or limited to some addresses): Dormeto reaches it with the in-cluster agent (R10.6)'],
      ['denied', 'the cluster does not let DmtDiscoveryRole read it (an access entry with AmazonEKSViewPolicy): Unauthorized'],
    ]);
  });

  it('a target group of an Ingress in a group: its Deployment, the switch through Dormeto\'s Ingress, HPA, Argo CD, the autoscaler', async () => {
    const clusters = await clustersOf(ports({ 'eks-demo': { cluster: CLUSTER('eks-demo'), client: cluster(demo()) } }));
    expect(await kubernetesBackend(clusters, group('k8s-demo-web', 'ip', ['10.0.1.1', '10.0.1.2'], controllerTags('demo/web-web:80')))).toEqual({
      kind: 'k8s', id: 'eks-demo/demo/Deployment/web',
      kubernetes: {
        cluster: 'eks-demo', namespace: 'demo', owner: { kind: 'Deployment', name: 'web' }, switch: 'ingress',
        ingress: { name: 'web', ruleIndex: 1, groupOrder: 9, service: { name: 'web', port: { number: 80 } } },
        gitops: 'argocd', hpa: true, keda: false, capacity: 'nodes', autoscaler: 'karpenter',
      },
    });
  });

  it('a target group of a lone Ingress (instance targets: its Service\'s pods): its StatefulSet on Fargate, the switch by patching it, Flux', async () => {
    const clusters = await clustersOf(ports({ 'eks-demo': { cluster: CLUSTER('eks-demo'), client: cluster(demo(), { karpenter: false }) } }));
    const found = await kubernetesBackend(clusters, group('k8s-demo-cache', 'instance', ['i-0abc'], controllerTags('demo/cache-cache:80')));
    expect(found).toMatchObject({ kind: 'k8s', id: 'eks-demo/demo/StatefulSet/cache' });
    expect(typeof found === 'object' && found?.kubernetes).toEqual({
      cluster: 'eks-demo', namespace: 'demo', owner: { kind: 'StatefulSet', name: 'cache' }, switch: 'patched-ingress',
      ingress: { name: 'cache', ruleIndex: 1, service: { name: 'cache', port: { number: 80 } } },
      gitops: 'flux', hpa: false, keda: false, capacity: 'fargate', autoscaler: null,
    });
  });

  it('KEDA: none in a cluster without its API; unknown (null) when the cluster refuses to show its ScaledObjects', async () => {
    const without = demo();
    delete without[`/apis/keda.sh/v1alpha1/namespaces/${NS}/scaledobjects`];
    const absent = await clustersOf(ports({ 'eks-demo': { cluster: CLUSTER('eks-demo'), client: cluster(without) } }));
    const found = await kubernetesBackend(absent, group('k8s-demo-web', 'ip', ['10.0.1.1'], controllerTags('demo/web-web:80')));
    expect(typeof found === 'object' && found?.kubernetes.keda).toBe(false);
    const client = cluster(demo());
    const list = client.list.bind(client);
    client.list = async (path) => {
      if (path.includes('keda.sh')) throw Object.assign(new Error('forbidden'), { name: 'KubernetesError', status: 403 });
      return list(path);
    };
    const refused = await clustersOf(ports({ 'eks-demo': { cluster: CLUSTER('eks-demo'), client } }));
    const unknown = await kubernetesBackend(refused, group('k8s-demo-web', 'ip', ['10.0.1.1'], controllerTags('demo/web-web:80')));
    expect(typeof unknown === 'object' && unknown?.kubernetes.keda).toBeNull();
  });

  it('a target group no Ingress claims, its IP targets pods of the cluster: a TargetGroupBinding, switched by its rules', async () => {
    const clusters = await clustersOf(ports({ 'eks-demo': { cluster: CLUSTER('eks-demo'), client: cluster(demo()) } }));
    const found = await kubernetesBackend(clusters, group('bound', 'ip', ['10.0.1.1']));
    expect(typeof found === 'object' && found?.kubernetes.switch).toBe('rule');
    expect(typeof found === 'object' && found?.kubernetes.ingress).toBeUndefined();
    // IP targets that are no pod of any cluster: not Kubernetes.
    expect(await kubernetesBackend(clusters, group('other', 'ip', ['10.9.9.9']))).toBeNull();
    expect(await kubernetesBackend(clusters, group('vm', 'instance', ['i-0aaa']))).toBeNull();
  });

  it('refuses what cannot be napped as one Kubernetes owner, with each reason (review focus 1)', async () => {
    const keda = { [`/apis/keda.sh/v1alpha1/namespaces/${NS}/scaledobjects`]: [{ metadata: { name: 'web' }, spec: { scaleTargetRef: { name: 'web' }, minReplicaCount: 0 } }] };
    const clusters = await clustersOf(ports({ 'eks-demo': { cluster: CLUSTER('eks-demo'), client: cluster(demo(keda)) } }));
    const reason = (targets: string[], tags = {}) => kubernetesBackend(clusters, group('x', 'ip', targets, tags));
    expect(await reason(['10.0.3.1'])).toBe('pods owned by DaemonSet agent: Dormeto naps Deployments and StatefulSets');
    expect(await reason(['10.0.3.2'])).toBe('pods owned by Job migrate: Dormeto naps Deployments and StatefulSets');
    expect(await reason(['10.0.3.3'])).toBe('pods without an owner (lonely)');
    expect(await reason(['10.0.4.1', '10.0.4.2'])).toBe('pods of several owners behind the target group: Deployment api, Deployment api2');
    expect(await reason(['10.0.1.1'], controllerTags('demo/web-web:80'))).toBe('a KEDA ScaledObject already scales Deployment demo/web to zero (minReplicaCount 0): it naps by itself');
  });

  it('a target group of a cluster Dormeto cannot reach or read is ineligible with the cluster\'s reason', async () => {
    const clusters = await clustersOf(ports({
      'eks-demo': { cluster: CLUSTER('eks-demo', { endpointPublicAccess: false, endpointPrivateAccess: true, vpcId: 'vpc-1' }), client: cluster(demo()) },
    }));
    expect(await kubernetesBackend(clusters, group('k8s-demo-web', 'ip', ['10.0.1.1'], controllerTags('demo/web-web:80')))).toBe(
      'cluster eks-demo: the cluster\'s endpoint is private (or limited to some addresses): Dormeto reaches it with the in-cluster agent (R10.6)',
    );
  });
});

describe('scanRegion with the region\'s clusters', () => {
  const WHERE = { account: '111122223333', region: 'eu-west-1' };
  it('traces IP targets to their Kubernetes owner, before calling them targets without an ECS service', async () => {
    const objects = demo({ '/api/v1/pods': [pod('web-5d9c-a1', '10.0.9.9', { kind: 'ReplicaSet', name: 'web-5d9c' })] });
    const { ports: base } = scanPorts();
    const found = await scanRegion({ ...base, kubernetes: ports({ 'eks-demo': { cluster: CLUSTER('eks-demo'), client: cluster(objects) } }) }, WHERE, { now: () => Date.UTC(2026, 9, 11) });
    const orphan = found.find((c) => c.targetGroupArn === TGS.orphan!.TargetGroupArn)!;
    expect([orphan.eligibility, orphan.backend?.kind, orphan.backend?.id]).toEqual(['eligible', 'k8s', 'eks-demo/demo/Deployment/web']);
    expect(orphan.backend && 'kubernetes' in orphan.backend && orphan.backend.kubernetes?.switch).toBe('rule');
  });

  it('a cluster it cannot read leaves its target groups ineligible with the reason; the rest of the region is scanned', async () => {
    const refused = Object.assign(new Error('Unauthorized'), { name: 'KubernetesError', status: 401 });
    const { ports: base } = scanPorts();
    const tagged = { ...base, elbv2: { ...base.elbv2, async describeTags(input: { ResourceArns: string[] }) {
      const out = await base.elbv2.describeTags(input);
      for (const d of out.TagDescriptions ?? []) if (d.ResourceArn === TGS.orphan!.TargetGroupArn) d.Tags = [{ Key: 'elbv2.k8s.aws/cluster', Value: 'eks-demo' }];
      return out;
    } } };
    const found = await scanRegion({ ...tagged, kubernetes: ports({ 'eks-demo': { cluster: CLUSTER('eks-demo'), client: cluster({}, { refuse: refused }) } }) }, WHERE, { now: () => Date.UTC(2026, 9, 11) });
    expect(found.find((c) => c.targetGroupArn === TGS.orphan!.TargetGroupArn)?.reason).toBe('cluster eks-demo: the cluster does not let DmtDiscoveryRole read it (an access entry with AmazonEKSViewPolicy): Unauthorized');
    expect(found.find((c) => c.targetGroupArn === TGS.shop!.TargetGroupArn)?.eligibility).toBe('eligible');
  });

  it('a discovery role without EKS rights (before 0.10.0) scans the region as before', async () => {
    const denied = Object.assign(new Error('not authorized to perform: eks:ListClusters'), { name: 'AccessDeniedException' });
    const { ports: base } = scanPorts();
    const kube: KubernetesPorts = { eks: { listClusters: async () => { throw denied; }, describeCluster: async () => ({}) }, kubernetesOf: async () => cluster({}) };
    const found = await scanRegion({ ...base, kubernetes: kube }, WHERE, { now: () => Date.UTC(2026, 9, 11) });
    expect(found.find((c) => c.targetGroupArn === TGS.orphan!.TargetGroupArn)?.reason).toBe('IP targets without an ECS service');
  });

  it('tells the caller the region\'s clusters as read, and names who reads them in the reason of one refused (the estimate: the profile)', async () => {
    const refused = Object.assign(new Error('Unauthorized'), { name: 'KubernetesError', status: 401 });
    const seen: [string, string | null][] = [];
    const { ports: base } = scanPorts();
    const kube = { ...ports({ 'eks-demo': { cluster: CLUSTER('eks-demo'), client: cluster(demo()) }, 'eks-prod': { cluster: CLUSTER('eks-prod'), client: cluster({}, { refuse: refused }) } }), reader: 'the profile' };
    await scanRegion({ ...base, kubernetes: kube }, WHERE, { now: () => Date.UTC(2026, 9, 11), onClusters: (clusters) => seen.push(...clusters.map((c): [string, string | null] => [c.name, c.reason ?? null])) });
    expect(seen).toEqual([['eks-demo', null], ['eks-prod', 'the cluster does not let the profile read it (an access entry with AmazonEKSViewPolicy): Unauthorized']]);
  });

  // A NodePort Service or a TargetGroupBinding in instance mode registers the cluster's nodes: never stopped as instances,
  // nor a node group scaled to zero.
  it('instance targets that are a cluster\'s nodes, and a node group\'s Auto Scaling group, are never offered to nap', async () => {
    const { ports: base } = scanPorts();
    const nodeTags = (id: string) => (id === 'i-shop' ? [{ Key: 'kubernetes.io/cluster/eks-demo', Value: 'owned' }] : id === 'i-s' ? [{ Key: 'karpenter.sh/nodepool', Value: 'demo' }, { Key: 'eks:eks-cluster-name', Value: 'eks-demo' }] : []);
    const described: string[][] = [];
    const ec2 = { async describeInstances({ InstanceIds }: { InstanceIds: string[] }) {
      described.push(InstanceIds);
      return { Reservations: [{ Instances: InstanceIds.map((InstanceId) => ({ InstanceId, Tags: nodeTags(InstanceId) })) }] };
    } };
    const autoscaling = { async describeAutoScalingGroups(input: { NextToken?: string }) {
      const out = await base.autoscaling!.describeAutoScalingGroups(input);
      return { ...out, AutoScalingGroups: (out.AutoScalingGroups ?? []).map((g) => ({ ...g, Tags: [{ Key: 'eks:cluster-name', Value: 'eks-demo' }, { Key: 'eks:nodegroup-name', Value: 'system' }] })) };
    } };
    const found = await scanRegion({ ...base, ec2, autoscaling, kubernetes: ports({ 'eks-demo': { cluster: CLUSTER('eks-demo'), client: cluster(demo()) } }) }, WHERE, { now: () => Date.UTC(2026, 9, 11) });
    const reason = (name: string) => found.find((c) => c.targetGroupArn === TGS[name]!.TargetGroupArn)?.reason;
    expect(reason('shop')).toBe('targets i-shop are nodes of EKS cluster eks-demo (a NodePort Service or a TargetGroupBinding in instance mode): not traced to their pods yet, never napped as instances');
    expect(reason('shared')).toBe('targets i-s are nodes of EKS cluster eks-demo (a NodePort Service or a TargetGroupBinding in instance mode): not traced to their pods yet, never napped as instances');
    expect(reason('batch')).toBe('the Auto Scaling group batch-asg holds nodes of EKS cluster eks-demo: never napped (its pods are Kubernetes workloads)');
    expect(found.find((c) => c.targetGroupArn === TGS.demo?.TargetGroupArn)?.backend?.kind ?? 'instance').toBe('instance');
    // Without a cluster in the region, instances are not described (nor with a discovery role older than 0.10.0).
    described.length = 0;
    await scanRegion({ ...base, ec2 }, WHERE, { now: () => Date.UTC(2026, 9, 11) });
    expect(described).toEqual([]);
  });

  it('the discovery role may list and describe the clusters, and describe the instances behind a target group', () => {
    expect(DISCOVERY_ACTIONS).toEqual(expect.arrayContaining(['eks:ListClusters', 'eks:DescribeCluster', 'ec2:DescribeInstances']));
  });
});
