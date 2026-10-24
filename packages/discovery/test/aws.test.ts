import { describe, expect, it } from 'vitest';
import { createAssumeRole, enabledRegionsOf, kubernetesPorts, organizationsPort, scanPorts } from '../src/aws.js';

function recorder(answer: (name: string, input: any) => unknown = () => ({})) {
  const sent: [string, any][] = [];
  return { sent, send: async (command: { constructor: { name: string }; input: any }) => { sent.push([command.constructor.name, command.input]); return answer(command.constructor.name, command.input); } };
}

describe('AWS adapters', () => {
  it('maps the scan ports to the ELB, Auto Scaling, ECS and CloudWatch commands', async () => {
    const elbv2 = recorder();
    const autoscaling = recorder();
    const ecs = recorder();
    const cloudwatch = recorder();
    const ports = scanPorts({ elbv2, autoscaling, ecs, cloudwatch });
    await ports.elbv2.describeRules({ ListenerArn: 'l', Marker: 'm' });
    await ports.elbv2.describeTags({ ResourceArns: ['a'] });
    await ports.autoscaling!.describeAutoScalingGroups({ NextToken: 't' });
    await ports.ecs!.describeServices({ cluster: 'c', services: ['s'] });
    await ports.cloudwatch!.getMetricData({ StartTime: new Date(0), EndTime: new Date(1), MetricDataQueries: [] });
    expect(elbv2.sent).toEqual([['DescribeRulesCommand', { ListenerArn: 'l', Marker: 'm' }], ['DescribeTagsCommand', { ResourceArns: ['a'] }]]);
    expect(autoscaling.sent[0]![0]).toBe('DescribeAutoScalingGroupsCommand');
    expect(ecs.sent[0]).toEqual(['DescribeServicesCommand', { cluster: 'c', services: ['s'] }]);
    expect(cloudwatch.sent[0]![0]).toBe('GetMetricDataCommand');
  });

  it('lists and describes the region\'s EKS clusters, and connects to one with a token of the discovery role', async () => {
    const eks = recorder((name) => (name === 'ListClustersCommand' ? { clusters: ['eks-demo'] }
      : { cluster: { name: 'eks-demo', endpoint: 'https://abc.eks.example', certificateAuthority: { data: '' }, resourcesVpcConfig: { endpointPublicAccess: true, publicAccessCidrs: ['0.0.0.0/0'] }, version: '1.36' } }));
    const ports = kubernetesPorts({ accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST' }, 'eu-west-1', eks);
    expect(await ports.eks.listClusters({ nextToken: 'n' })).toEqual({ clusters: ['eks-demo'] });
    const client = await ports.kubernetesOf('eks-demo');
    expect(typeof client.get).toBe('function');
    expect(eks.sent.map(([name, input]) => [name, input])).toEqual([['ListClustersCommand', { nextToken: 'n' }], ['DescribeClusterCommand', { name: 'eks-demo' }]]);
  });

  const PRIVATE_CLUSTER = { name: 'eks-demo', endpoint: 'https://abc.eks.example', certificateAuthority: { data: '' }, resourcesVpcConfig: { endpointPublicAccess: false, endpointPrivateAccess: true }, version: '1.36' };
  const privateEks = () => recorder((name) => (name === 'ListClustersCommand' ? { clusters: ['eks-demo'] } : { cluster: PRIVATE_CLUSTER }));
  const CREDENTIALS = { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST' };

  it('reads a private cluster through its proxy: the router\'s name prefix, the pods page by page (limit=100)', async () => {
    const calls: { functionName: string; payload: any }[] = [];
    const lambda = {
      invoke: async (functionName: string, payload: any) => {
        calls.push({ functionName, payload });
        return { v: 1, status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) };
      },
    };
    const ports = kubernetesPorts(CREDENTIALS, 'eu-west-1', privateEks(), undefined, 'dmtr-dev-kube-', lambda);
    const client = await ports.kubernetesOf('eks-demo');
    expect(await client.list('/api/v1/pods')).toEqual([]);
    expect(calls.map((c) => [c.functionName, c.payload.path, c.payload.query])).toEqual([['dmtr-dev-kube-eks-demo', '/api/v1/pods', { limit: '100' }]]);
  });

  it('a private cluster without a router (no prefix) is NoProxy', async () => {
    const ports = kubernetesPorts(CREDENTIALS, 'eu-west-1', privateEks());
    await expect(ports.kubernetesOf('eks-demo')).rejects.toMatchObject({ name: 'KubernetesError', reason: 'NoProxy' });
  });

  it('assumes the discovery role of an account with a named session', async () => {
    const sts = recorder(() => ({ Credentials: { AccessKeyId: 'AK', SecretAccessKey: 'SK', SessionToken: 'ST', Expiration: new Date(5) } }));
    const credentials = await createAssumeRole({ sts, roleName: 'DmtDiscoveryRole', sessionName: 'dmt-dev-discovery' })('038606077307');
    expect(sts.sent).toEqual([['AssumeRoleCommand', { RoleArn: 'arn:aws:iam::038606077307:role/DmtDiscoveryRole', RoleSessionName: 'dmt-dev-discovery', DurationSeconds: 3600 }]]);
    expect(credentials).toEqual({ accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST', expiration: new Date(5) });
  });

  it('lists the enabled regions of an account', async () => {
    const ec2 = recorder(() => ({ Regions: [{ RegionName: 'eu-west-1' }, { RegionName: 'eu-west-3' }] }));
    expect(await enabledRegionsOf(ec2)).toEqual(['eu-west-1', 'eu-west-3']);
    expect(ec2.sent[0]).toEqual(['DescribeRegionsCommand', {}]);
  });

  it('maps the Organizations port to its list commands', async () => {
    const client = recorder();
    const org = organizationsPort(client);
    await org.listRoots({});
    await org.listAccountsForParent({ ParentId: 'r-1u0b', NextToken: 'n' });
    expect(client.sent.map(([name]) => name)).toEqual(['ListRootsCommand', 'ListAccountsForParentCommand']);
    expect(client.sent[1]![1]).toEqual({ ParentId: 'r-1u0b', NextToken: 'n' });
  });
});
