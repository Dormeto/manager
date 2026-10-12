// What a nap stops, as the router describes it (router lambda/src/lib/stopped.mjs and kubernetes.mjs, R9a): the cases of
// router test/stopped.test.mjs and the Kubernetes items of test/kubernetes.test.mjs, and the edge cases of the spec's
// §6 (Spot, Kubernetes owners).
import { error, regionModel } from './aws.mjs';

export const name = 'stopped';

const SERVICE = 'arn:aws:ecs:eu-west-1:111122223333:service/app/web';
const CLUSTER = 'arn:aws:ecs:eu-west-1:111122223333:cluster/app';
const ID = 'eks-demo/demo/Deployment/web';
const K8S = { kind: 'k8s', id: ID, cluster: 'eks-demo', namespace: 'demo', owner: { kind: 'Deployment', name: 'web' }, autoscaler: null };

// A service on its cluster and its task definition (or a refusal to describe it).
const service = (fields, task, refuse = false) => regionModel({
  ecsClusters: { [CLUSTER]: [{ serviceArn: SERVICE, clusterArn: CLUSTER, taskDefinition: 'arn:aws:ecs:eu-west-1:111122223333:task-definition/web:3', ...fields }] },
  taskDefinitions: { 'arn:aws:ecs:eu-west-1:111122223333:task-definition/web:3': task },
  fail: refuse ? { 'ecs.describeTaskDefinition': error('AccessDeniedException', 'User: arn:aws:sts::111122223333:assumed-role/dmt-router/x is not authorized to perform: ecs:DescribeTaskDefinition') } : {},
});

// The cluster of router test/fakes.mjs: the owner (its selector app=<name>), its ReplicaSet <name>-5d4f8, its pods and
// their nodes.
const k8sPod = (podName, { ip, node = 'ip-10-0-1-1.eu-west-1.compute.internal', requests = { cpu: '250m', memory: '512Mi' }, init, annotations = {}, fargate = false, phase = 'Running' } = {}) => ({
  metadata: { name: podName, namespace: 'demo', labels: { app: podName.replace(/-[^-]+$/, '') }, annotations, ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: `${podName.replace(/-[^-]+$/, '')}-5d4f8`, controller: true }] },
  spec: {
    nodeName: node, schedulerName: fargate ? 'fargate-scheduler' : 'default-scheduler', containers: [{ name: 'app', resources: requests ? { requests } : {} }],
    ...(init ? { initContainers: [{ name: 'init', resources: { requests: init } }] } : {}),
  },
  status: { phase, ...(ip ? { podIP: ip } : {}), conditions: [{ type: 'Ready', status: 'True' }] },
});
const k8sNode = (nodeName, { type = 'm5.large', labels = {}, allocatable = { cpu: '1930m', memory: '7220184Ki' } } = {}) => ({
  metadata: { name: nodeName, labels: { 'node.kubernetes.io/instance-type': type, 'kubernetes.io/os': 'linux', ...labels } }, status: { allocatable },
});
const cluster = ({ pods = [], nodes = [], owner = true, connect } = {}) => regionModel({
  clusters: {
    'eks-demo': {
      connect,
      objects: {
        '/apis/apps/v1/namespaces/demo/deployments': owner ? [{ kind: 'Deployment', metadata: { name: 'web', namespace: 'demo' }, spec: { replicas: 2, selector: { matchLabels: { app: 'web' } } } }] : [],
        '/apis/apps/v1/namespaces/demo/replicasets': [{ metadata: { name: 'web-5d4f8', namespace: 'demo', labels: { app: 'web' }, ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name: 'web', controller: true }] } }],
        '/api/v1/namespaces/demo/pods': pods,
        '/api/v1/nodes': nodes,
      },
    },
  },
});
const FARGATE_NODE = 'fargate-ip-10-0-3-1.eu-west-1.compute.internal';
const SPOT_NODE = 'ip-10-0-1-1.eu-west-1.compute.internal';
const GROUP_NODE = 'ip-10-0-1-2.eu-west-1.compute.internal';

const describe = (title, backends, model) => ({ name: `describeStopped: ${title}`, input: { function: 'describeStopped', backends }, model });
const counts = (title, strategy, desired) => ({ name: `strategyCounts: ${title}`, input: { function: 'strategyCounts', strategy, desired } });
const LINUX = 'Linux/UNIX';

export function cases() {
  const fargateTask = { cpu: '256', memory: '512' };
  return [
    describe('EC2 instances by type and OS; an Auto Scaling group at its desired capacity by the types of its instances',
      [{ kind: 'instance', id: 'i-1' }, { kind: 'instance', id: 'i-2' }, { kind: 'asg', name: 'web', desired: 3, instances: ['i-3', 'i-4', 'i-5'] }],
      regionModel({ instances: { 'i-1': { InstanceType: 't3.medium', PlatformDetails: LINUX }, 'i-2': { InstanceType: 'm5.large', PlatformDetails: 'Windows' }, 'i-3': { InstanceType: 't3.small', PlatformDetails: LINUX }, 'i-4': { InstanceType: 't3a.small', PlatformDetails: LINUX }, 'i-5': { InstanceType: 't3.small', PlatformDetails: LINUX } } })),
    describe('an OS neither Linux nor Windows is said as it is', [{ kind: 'instance', id: 'i-1' }], regionModel({ instances: { 'i-1': { InstanceType: 'm5.large', PlatformDetails: 'Red Hat Enterprise Linux' } } })),
    describe('Windows with its own license or with SQL Server is said as it is', [{ kind: 'instance', id: 'i-1' }, { kind: 'instance', id: 'i-2' }],
      regionModel({ instances: { 'i-1': { InstanceType: 'm5.large', PlatformDetails: 'Windows BYOL' }, 'i-2': { InstanceType: 'm5.large', PlatformDetails: 'Windows with SQL Server Standard' } } })),
    describe('a Fargate service, ARM: its task size times its desired count', [{ kind: 'ecs', id: SERVICE, cluster: CLUSTER, desired: 2 }],
      service({ launchType: 'FARGATE' }, { cpu: '512', memory: '1024', runtimePlatform: { cpuArchitecture: 'ARM64', operatingSystemFamily: 'LINUX' } })),
    describe('a service on the FARGATE capacity provider', [{ kind: 'ecs', id: SERVICE, cluster: CLUSTER, desired: 1 }], service({ capacityProviderStrategy: [{ capacityProvider: 'FARGATE', weight: 1 }] }, fargateTask)),
    describe('a service on EC2 capacity stops nothing Dormeto counts', [{ kind: 'ecs', id: SERVICE, cluster: CLUSTER, desired: 2 }], service({ launchType: 'EC2' }, fargateTask)),
    describe('a Windows Fargate service', [{ kind: 'ecs', id: SERVICE, cluster: CLUSTER, desired: 1 }], service({ launchType: 'FARGATE' }, { cpu: '1024', memory: '2048', runtimePlatform: { operatingSystemFamily: 'WINDOWS_SERVER_2022_CORE' } })),
    describe('a service at a desired count of 0 stops nothing', [{ kind: 'ecs', id: SERVICE, cluster: CLUSTER, desired: 0 }], service({ launchType: 'FARGATE' }, fargateTask)),
    describe('a task size the boundary refuses is an unknown item', [{ kind: 'ecs', id: SERVICE, cluster: CLUSTER, desired: 1 }], service({ launchType: 'FARGATE' }, fargateTask, true)),
    describe('RDS instances (Multi-AZ said), an Aurora cluster\'s provisioned instances, Aurora Serverless v2 at its minimum',
      [{ kind: 'rds-instance', id: 'shop' }, { kind: 'rds-cluster', id: 'aur' }, { kind: 'rds-cluster', id: 'srv' }],
      regionModel({
        dbInstances: [
          { DBInstanceIdentifier: 'shop', DBInstanceClass: 'db.t4g.micro', Engine: 'postgres', MultiAZ: true },
          { DBInstanceIdentifier: 'aur-1', DBInstanceClass: 'db.r6g.large', Engine: 'aurora-postgresql', DBClusterIdentifier: 'aur' },
          { DBInstanceIdentifier: 'srv-1', DBInstanceClass: 'db.serverless', Engine: 'aurora-mysql', DBClusterIdentifier: 'srv' },
        ],
        dbClusters: [{ DBClusterIdentifier: 'aur', Engine: 'aurora-postgresql' }, { DBClusterIdentifier: 'srv', Engine: 'aurora-mysql', ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 4 } }],
      })),
    describe('an instance on Spot is said so; a group\'s on-demand and Spot instances of one type are two items',
      [{ kind: 'instance', id: 'i-1' }, { kind: 'asg', name: 'web', desired: 3, instances: ['i-2', 'i-3', 'i-4'] }],
      regionModel({ instances: { 'i-1': { InstanceType: 't3.medium', PlatformDetails: LINUX, InstanceLifecycle: 'spot' }, 'i-2': { InstanceType: 't3.medium', PlatformDetails: LINUX }, 'i-3': { InstanceType: 't3.medium', PlatformDetails: LINUX, InstanceLifecycle: 'spot' }, 'i-4': { InstanceType: 't3.medium', PlatformDetails: LINUX } } })),
    describe('a group whose desired capacity was not all described: the rest added to its first item', [{ kind: 'asg', name: 'web', desired: 3, instances: ['i-1'] }],
      regionModel({ instances: { 'i-1': { InstanceType: 't3.small', PlatformDetails: LINUX, InstanceLifecycle: 'spot' } } })),
    describe('a group at 0 stops nothing; one without an instance to read is an unknown item', [{ kind: 'asg', name: 'idle', desired: 0, instances: [] }, { kind: 'asg', name: 'new', desired: 2, instances: [] }], regionModel({})),
    describe('Fargate and Fargate Spot: the base first, then the weights, an item each', [{ kind: 'ecs', id: SERVICE, cluster: CLUSTER, desired: 5 }],
      service({ capacityProviderStrategy: [{ capacityProvider: 'FARGATE', base: 1, weight: 1 }, { capacityProvider: 'FARGATE_SPOT', weight: 3 }] }, fargateTask)),
    describe('Fargate Spot only: one Spot item', [{ kind: 'ecs', id: SERVICE, cluster: CLUSTER, desired: 2 }], service({ capacityProviderStrategy: [{ capacityProvider: 'FARGATE_SPOT', weight: 1 }] }, fargateTask)),
    describe('a share on EC2 capacity not counted', [{ kind: 'ecs', id: SERVICE, cluster: CLUSTER, desired: 4 }],
      service({ capacityProviderStrategy: [{ capacityProvider: 'app-asg', weight: 1 }, { capacityProvider: 'FARGATE_SPOT', weight: 1 }] }, fargateTask)),
    describe('Kubernetes pods on Fargate: the size given (CapacityProvisioned), else the requests plus 256 MB rounded up', [K8S], cluster({
      pods: [
        k8sPod('web-1', { ip: '10.0.3.1', node: FARGATE_NODE, fargate: true, annotations: { CapacityProvisioned: '0.25vCPU 0.5GB' }, requests: { cpu: '100m', memory: '128Mi' } }),
        k8sPod('web-2', { ip: '10.0.3.2', node: FARGATE_NODE, fargate: true, annotations: { CapacityProvisioned: '0.25vCPU 0.5GB' }, requests: { cpu: '100m', memory: '128Mi' } }),
        k8sPod('web-3', { ip: '10.0.3.3', node: FARGATE_NODE, fargate: true, requests: { cpu: '300m', memory: '700Mi' } }),
        k8sPod('web-4', { ip: '10.0.3.4', node: FARGATE_NODE, fargate: true, requests: { cpu: '250m', memory: '256Mi' }, init: { cpu: '1', memory: '1Gi' } }),
        k8sPod('web-5', { ip: '10.0.3.5', node: FARGATE_NODE, fargate: true, requests: { cpu: '32', memory: '256Gi' } }),
        k8sPod('web-6', { ip: '10.0.3.6', node: FARGATE_NODE, fargate: true, phase: 'Succeeded' }),
      ],
    })),
    describe('Kubernetes pods on EC2 nodes: requests, the node\'s type, allocatable and capacity type, its autoscaler (Karpenter; the Cluster Autoscaler found by discovery)',
      [K8S, { ...K8S, autoscaler: 'cluster-autoscaler' }], cluster({
        pods: [
          k8sPod('web-1', { ip: '10.0.1.1', node: SPOT_NODE }), k8sPod('web-2', { ip: '10.0.1.2', node: SPOT_NODE }),
          k8sPod('web-3', { ip: '10.0.1.3', node: GROUP_NODE, requests: { cpu: '500m', memory: '1Gi' } }),
          k8sPod('web-4', { ip: '10.0.1.4', node: null }),
        ],
        nodes: [
          k8sNode(SPOT_NODE, { labels: { 'karpenter.sh/nodepool': 'default', 'karpenter.sh/capacity-type': 'spot' } }),
          k8sNode(GROUP_NODE, { type: 't4g.medium', labels: { 'eks.amazonaws.com/nodegroup': 'system', 'eks.amazonaws.com/capacityType': 'ON_DEMAND' }, allocatable: { cpu: '1930m', memory: '3366880Ki' } }),
        ],
      })),
    describe('Kubernetes pods without CPU and memory requests are said, not priced', [K8S], cluster({ pods: [k8sPod('web-1', { ip: '10.0.1.1', requests: null })], nodes: [k8sNode(SPOT_NODE)] })),
    describe('a Kubernetes cluster that cannot be reached: an unknown item', [K8S], cluster({ connect: error('Error', 'cluster unreachable') })),
    describe('a Kubernetes owner gone: an unknown item with the API\'s reason', [K8S], cluster({ owner: false })),
    describe('several backends in order: an instance, a Fargate service and pods on a node', [{ kind: 'instance', id: 'i-1' }, { kind: 'ecs', id: SERVICE, cluster: CLUSTER, desired: 1 }, K8S], (call, input) => (
      call.startsWith('ec2.') ? regionModel({ instances: { 'i-1': { InstanceType: 't4g.small', PlatformDetails: LINUX } } })(call, input)
        : call.startsWith('ecs.') ? service({ launchType: 'FARGATE' }, fargateTask)(call, input)
          : cluster({ pods: [k8sPod('web-1', { ip: '10.0.1.1' })], nodes: [k8sNode(SPOT_NODE, { labels: { 'karpenter.sh/nodepool': 'default' } })] })(call, input))),
    counts('the base first, then the weights', [{ capacityProvider: 'FARGATE', base: 1, weight: 1 }, { capacityProvider: 'FARGATE_SPOT', weight: 3 }], 5),
    counts('equal weights over an odd count: the largest remainder, the first provider on a tie', [{ capacityProvider: 'FARGATE', weight: 1 }, { capacityProvider: 'FARGATE_SPOT', weight: 1 }], 3),
    counts('a base larger than the count', [{ capacityProvider: 'FARGATE', base: 5, weight: 1 }, { capacityProvider: 'FARGATE_SPOT', weight: 1 }], 2),
    counts('no weight: the base\'s provider takes the rest', [{ capacityProvider: 'FARGATE', base: 1, weight: 0 }, { capacityProvider: 'FARGATE_SPOT', weight: 0 }], 3),
    counts('an EC2 capacity provider and Fargate Spot', [{ capacityProvider: 'app-asg', weight: 1 }, { capacityProvider: 'FARGATE_SPOT', weight: 1 }], 4),
    counts('three providers, weights 1, 1, 1 over 5', [{ capacityProvider: 'FARGATE', weight: 1 }, { capacityProvider: 'FARGATE_SPOT', weight: 1 }, { capacityProvider: 'app-asg', weight: 1 }], 5),
    counts('a desired count of 0', [{ capacityProvider: 'FARGATE', weight: 1 }], 0),
  ];
}

export async function run(product, input, ports) {
  if (input.function === 'strategyCounts') return Object.fromEntries(product.strategyCounts(input.strategy, input.desired));
  if (input.function !== 'describeStopped') throw new Error(`unknown function ${input.function}`);
  return product.describeStopped({ ec2: ports.ec2, ecs: ports.ecs, rds: ports.rds, kubernetesOf: ports.kubernetesOf }, input.backends);
}

export const readme = `What a nap of each backend stops, as the router describes it (router \`lambda/src/lib/stopped.mjs\` and
\`kubernetes.mjs\`'s \`k8sItems\`; Go \`internal/stopped\`). \`input.function\` names the function:

- \`describeStopped\` (Go \`stopped.Describe\`): \`input.backends\` as the estimate passes them (\`{kind: "instance", id}\`,
  \`{kind: "asg", name, desired, instances}\`, \`{kind: "ecs", id, cluster, desired}\`, \`{kind: "k8s", id, cluster,
  namespace, owner: {kind, name}, autoscaler}\`; the router's own \`{kind: "rds-instance" | "rds-cluster", id}\` too),
  the ports' answers in \`input.answers\` (\`ec2\`, \`ecs\`, \`rds\`; a Kubernetes owner through \`kubernetes.of\`, then its
  pods by the owner's label selector, its ReplicaSets, its nodes). Output: the items (\`StoppedItem\`s; a backend that
  cannot be described is an \`unknown\` item with the error's message).
- \`strategyCounts\`: \`{strategy, desired}\` (a capacity provider strategy). Output: \`{provider: count}\`.`;
