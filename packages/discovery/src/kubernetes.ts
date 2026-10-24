// Kubernetes workloads in discovery (vision docs/specs/2026-10-11-kubernetes-design.md, sections 3 to 5): the EKS
// clusters of an account and region, read with DmtDiscoveryRole's access entry (AmazonEKSViewPolicy: namespaced objects,
// no Secrets, no Nodes), and a target group traced to the one Deployment or StatefulSet behind it, with how the waker is
// switched in. The cluster client is the router's (router lambda/src/lib/k8s.mjs), wired in aws.ts.

// @ts-expect-error the router's module has no type declarations
import { UNREACHABLE, reachOf } from '../../../../router/lambda/src/lib/k8s.mjs';

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface KubeClient {
  get(path: string): Promise<any>;
  list(path: string, query?: Record<string, string>): Promise<any[]>;
}

export interface KubernetesPorts {
  eks: {
    listClusters(input: { nextToken?: string }): Promise<{ clusters?: string[]; nextToken?: string }>;
    describeCluster(input: { name: string }): Promise<{ cluster?: any }>;
  };
  kubernetesOf(cluster: string): Promise<KubeClient>;
  router?: string | null; // the router of the account and region (its proxies serve the private clusters), none when absent
  reader?: string; // who reads the clusters, in the reason of one it cannot read (DmtDiscoveryRole by default)
}

export type OwnerKind = 'Deployment' | 'StatefulSet';
export interface KubernetesCandidate {
  cluster: string;
  namespace: string;
  owner: { kind: OwnerKind; name: string };
  switch: 'rule' | 'ingress' | 'patched-ingress';
  ingress?: { name: string; ruleIndex: number; groupOrder?: number; service: { name: string; port: { number?: number; name?: string } } };
  gitops?: 'argocd' | 'flux';
  hpa: boolean;
  keda: boolean | null;
  capacity: 'fargate' | 'nodes';
  autoscaler: 'karpenter' | 'cluster-autoscaler' | null;
}
export interface KubernetesBackend { kind: 'k8s'; id: string; kubernetes: KubernetesCandidate }

export interface Cluster {
  name: string;
  vpcId?: string;
  reason?: string;
  client?: KubeClient;
  pods?: any[];
  autoscaler?: 'karpenter' | 'cluster-autoscaler' | null;
  lists?: Map<string, Promise<any[]>>;
}

// The EKS calls discovery adds for clusters (its policy grants them, with DISCOVERY_ACTIONS).
export const EKS_ACTIONS = ['eks:ListClusters', 'eks:DescribeCluster'];

// Why a private cluster is not read (private endpoints, spec §8): no router in its account and region, or a router without
// the cluster's proxy. A public endpoint limited to some addresses with private access off is the router's UNREACHABLE.
const noRouter = (where?: Where) => `the cluster's endpoint is private: Dormeto reaches it through a proxy function in its VPC, set up with the router of ${where ? `${where.account} ${where.region}` : 'its account and region'}: install it`;
const NO_PROXY = 'the cluster\'s endpoint is private and its proxy is not set up: upgrade the router or set up its cluster access (Terraform: module kubernetes-proxy)';
export type Where = { account: string; region: string };
const CLUSTER_TAG = 'elbv2.k8s.aws/cluster';
const RESOURCE_TAG = 'ingress.k8s.aws/resource';
const GROUP = 'alb.ingress.kubernetes.io/group.name';
const ORDER = 'alb.ingress.kubernetes.io/group.order';
const OWNERS: Record<string, string> = { Deployment: 'deployments', StatefulSet: 'statefulsets' };

const status = (err: unknown) => (err as { status?: number })?.status;
const message = (err: unknown) => String((err as Error)?.message ?? err);

// Every cluster of the region with what discovery can read of it: its pods (by IP) and whether a node autoscaler runs;
// a cluster it cannot reach or read keeps the reason (its target groups are ineligible with it, the account goes on).
export async function clustersOf(ports: KubernetesPorts, where?: Where): Promise<Cluster[]> {
  const names: string[] = [];
  let next: string | undefined;
  do {
    const page = await ports.eks.listClusters(next ? { nextToken: next } : {});
    names.push(...(page.clusters ?? []));
    next = page.nextToken;
  } while (next);
  const clusters: Cluster[] = [];
  for (const name of names) {
    const { cluster: c = {} } = await ports.eks.describeCluster({ name });
    const vpc = c.resourcesVpcConfig ?? {};
    const found: Cluster = { name, vpcId: vpc.vpcId };
    clusters.push(found);
    const reach: 'direct' | 'proxy' | 'none' = reachOf(vpc);
    if (reach === 'none') {
      found.reason = UNREACHABLE;
      continue;
    }
    if (reach === 'proxy' && !ports.router) {
      found.reason = noRouter(where);
      continue;
    }
    try {
      found.client = await ports.kubernetesOf(name);
      found.pods = await found.client.list('/api/v1/pods');
      found.autoscaler = await autoscalerOf(found.client);
      found.lists = new Map();
    } catch (err) {
      if ((err as { reason?: string })?.reason === 'NoProxy') found.reason = NO_PROXY;
      else if (status(err) === 401 || status(err) === 403) found.reason = `the cluster does not let ${ports.reader ?? 'DmtDiscoveryRole'} read it (an access entry with AmazonEKSViewPolicy): ${message(err)}`;
      else found.reason = `the cluster cannot be read: ${message(err)}`;
    }
  }
  return clusters;
}

// Karpenter (its API is there) or the Cluster Autoscaler (its Deployment in kube-system): a node autoscaler removes the
// nodes a nap frees, so the pods' share of their nodes is saved (decision 3).
async function autoscalerOf(client: KubeClient): Promise<'karpenter' | 'cluster-autoscaler' | null> {
  try {
    await client.get('/apis/karpenter.sh/v1');
    return 'karpenter';
  } catch (err) {
    if (status(err) !== 404) throw err;
  }
  const deployments = await client.list('/apis/apps/v1/namespaces/kube-system/deployments').catch(() => []);
  return deployments.some((d) => /cluster-autoscaler/.test(d.metadata?.name ?? '')) ? 'cluster-autoscaler' : null;
}

// A namespace's objects of a kind, read once per scan; optional ones (HPA, KEDA): none when their API is missing (404),
// null when the cluster refuses to show them.
function listOf(cluster: Cluster, path: string, optional = false): Promise<any[] | null> {
  if (!cluster.lists!.has(path)) cluster.lists!.set(path, cluster.client!.list(path));
  return cluster.lists!.get(path)!.catch((err) => {
    if (optional) return status(err) === 404 ? [] : null;
    throw err;
  });
}

const selects = (selector: Record<string, string> = {}, labels: Record<string, string> = {}) =>
  Object.keys(selector).length > 0 && Object.entries(selector).every(([k, v]) => labels[k] === v);
const portText = (port: { number?: number; name?: string } = {}) => String(port.number ?? port.name);
const controllerOf = (o: any) => (o.metadata?.ownerReferences ?? []).find((r: any) => r.controller) as { kind: string; name: string } | undefined;

// The Ingress rule the controller made the target group for: its tag ingress.k8s.aws/resource is
// <namespace>/<ingress>-<service>:<port>.
async function ingressOf(cluster: Cluster, resource: string) {
  const namespace = resource.split('/')[0]!;
  for (const ingress of (await listOf(cluster, `/apis/networking.k8s.io/v1/namespaces/${namespace}/ingresses`))!) {
    const rules: any[] = ingress.spec?.rules ?? [];
    for (const [ruleIndex, rule] of rules.entries()) {
      for (const path of rule.http?.paths ?? []) {
        const service = path.backend?.service;
        if (service && `${namespace}/${ingress.metadata.name}-${service.name}:${portText(service.port)}` === resource) {
          return { namespace, ingress, ruleIndex, service: { name: service.name as string, port: service.port as { number?: number; name?: string } } };
        }
      }
    }
  }
  return null;
}

// The target group's Kubernetes owner, why it cannot be napped, or null when it is not a Kubernetes target group (no
// cluster's tag, and no target among a reachable cluster's pods).
export async function kubernetesBackend(
  clusters: Cluster[],
  group: { arn: string; type?: string; vpcId?: string; tags: Record<string, string>; targets: string[] },
): Promise<KubernetesBackend | string | null> {
  const tagged = group.tags[CLUSTER_TAG];
  const cluster = tagged ? clusters.find((c) => c.name === tagged)
    : group.type === 'ip' ? clusters.find((c) => c.pods?.some((p) => group.targets.includes(p.status?.podIP))) : undefined;
  if (!cluster) return tagged ? `cluster ${tagged} not found in the region` : null;
  if (cluster.reason) return `cluster ${cluster.name}: ${cluster.reason}`;
  try {
    return await ownerBackend(cluster, group);
  } catch (err) {
    return `cluster ${cluster.name}: ${message(err)}`;
  }
}

async function ownerBackend(cluster: Cluster, group: { tags: Record<string, string>; targets: string[] }): Promise<KubernetesBackend | string> {
  // Its pods: those of the Ingress backend's Service, else its IP targets.
  const resource = group.tags[RESOURCE_TAG];
  const claim = resource ? await ingressOf(cluster, resource) : null;
  let pods: any[];
  if (claim) {
    const services = (await listOf(cluster, `/api/v1/namespaces/${claim.namespace}/services`))!;
    const selector = services.find((s) => s.metadata.name === claim.service.name)?.spec?.selector;
    pods = cluster.pods!.filter((p) => p.metadata.namespace === claim.namespace && selects(selector, p.metadata.labels));
  } else pods = cluster.pods!.filter((p) => group.targets.includes(p.status?.podIP));
  pods = pods.filter((p) => !['Succeeded', 'Failed'].includes(p.status?.phase));
  if (!pods.length) return 'no pod behind the target group: its owner cannot be told (wake it, then discover again)';

  // Their owners: a Deployment through its ReplicaSet, or a StatefulSet.
  const owners = new Map<string, { kind: string; name: string; namespace: string }>();
  for (const p of pods) {
    const namespace = p.metadata.namespace as string;
    const ref = controllerOf(p);
    if (!ref) return `pods without an owner (${pods.filter((x) => !controllerOf(x)).map((x) => x.metadata.name).join(', ')})`;
    let found: { kind: string; name: string } = ref;
    if (ref.kind === 'ReplicaSet') {
      const set = (await listOf(cluster, `/apis/apps/v1/namespaces/${namespace}/replicasets`))!.find((r) => r.metadata.name === ref.name);
      found = (set && controllerOf(set)) ?? ref;
    }
    if (!OWNERS[found.kind]) return `pods owned by ${found.kind} ${found.name}: Dormeto naps Deployments and StatefulSets`;
    owners.set(`${namespace}/${found.kind}/${found.name}`, { ...found, namespace });
  }
  if (owners.size > 1) return `pods of several owners behind the target group: ${[...owners.values()].map((o) => `${o.kind} ${o.name}`).join(', ')}`;
  const [{ kind, name, namespace }] = [...owners.values()] as [{ kind: OwnerKind; name: string; namespace: string }];
  const object = (await listOf(cluster, `/apis/apps/v1/namespaces/${namespace}/${OWNERS[kind]}`))!.find((o) => o.metadata.name === name) ?? {};

  // What scales it besides Dormeto.
  const hpas = await listOf(cluster, `/apis/autoscaling/v2/namespaces/${namespace}/horizontalpodautoscalers`, true);
  const scaledObjects = await listOf(cluster, `/apis/keda.sh/v1alpha1/namespaces/${namespace}/scaledobjects`, true);
  const scaled = scaledObjects?.find((s) => s.spec?.scaleTargetRef?.name === name && (s.spec.scaleTargetRef.kind ?? 'Deployment') === kind);
  if (scaled && scaled.spec.minReplicaCount === 0) return `a KEDA ScaledObject already scales ${kind} ${namespace}/${name} to zero (minReplicaCount 0): it naps by itself`;

  // A GitOps owner resets replicas while asleep (section 8): Argo CD by its tracking annotation, Flux by its labels.
  const labels = object.metadata?.labels ?? {};
  const annotations = object.metadata?.annotations ?? {};
  const gitops = annotations['argocd.argoproj.io/tracking-id'] || labels['argocd.argoproj.io/instance'] ? 'argocd'
    : labels['kustomize.toolkit.fluxcd.io/name'] || labels['helm.toolkit.fluxcd.io/name'] ? 'flux' : undefined;

  // The switch: Dormeto's Ingress in the customer's group (before it), the lone Ingress patched, or the rules.
  let switching: Pick<KubernetesCandidate, 'switch' | 'ingress'> = { switch: 'rule' };
  if (claim) {
    const ingressAnnotations = claim.ingress.metadata.annotations ?? {};
    switching = ingressAnnotations[GROUP]
      ? { switch: 'ingress', ingress: { name: claim.ingress.metadata.name, ruleIndex: claim.ruleIndex, groupOrder: Math.max(-1000, Number(ingressAnnotations[ORDER] ?? 0) - 1), service: claim.service } }
      : { switch: 'patched-ingress', ingress: { name: claim.ingress.metadata.name, ruleIndex: claim.ruleIndex, service: claim.service } };
  }
  const fargate = pods.every((p) => p.spec?.schedulerName === 'fargate-scheduler' || String(p.spec?.nodeName ?? '').startsWith('fargate-'));
  return {
    kind: 'k8s',
    id: `${cluster.name}/${namespace}/${kind}/${name}`,
    kubernetes: {
      cluster: cluster.name, namespace, owner: { kind, name }, ...switching, ...(gitops ? { gitops } : {}),
      hpa: Boolean(hpas?.some((h) => h.spec?.scaleTargetRef?.kind === kind && h.spec.scaleTargetRef.name === name)),
      keda: scaledObjects === null ? null : Boolean(scaled),
      capacity: fargate ? 'fargate' : 'nodes',
      autoscaler: cluster.autoscaler ?? null,
    },
  };
}
