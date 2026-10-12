// The recorded answers the shared cases carry (vision docs/specs/2026-10-13-cli-design.md §6): a call is answered by the
// first entry whose input equals its own, an unknown call fails; the recorder writes them from a model of an AWS world.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PORTS, canonical, recordedPorts, recorder } from './recorded.mjs';

const NOW = Date.parse('2026-10-12T08:00:00.000Z');

test('a call is answered by the first entry whose input equals its own, whatever the order of its keys', async () => {
  const ports = recordedPorts({
    'elbv2.describeRules': [
      { input: { ListenerArn: 'l1', Marker: '5' }, output: { Rules: [{ RuleArn: 'r6' }] } },
      { input: { ListenerArn: 'l1' }, output: { Rules: [{ RuleArn: 'r1' }], NextMarker: '5' } },
      { input: { ListenerArn: 'l1' }, output: { Rules: [] } },
    ],
  });
  assert.deepEqual(await ports.elbv2.describeRules({ ListenerArn: 'l1' }), { Rules: [{ RuleArn: 'r1' }], NextMarker: '5' });
  assert.deepEqual(await ports.elbv2.describeRules({ Marker: '5', ListenerArn: 'l1' }), { Rules: [{ RuleArn: 'r6' }] });
  assert.deepEqual(ports.missed(), []);
});

test('an input is compared as Node writes it in JSON: dates as toISOString(), undefined fields dropped', async () => {
  const ports = recordedPorts({
    'spot.history': [{ input: { region: 'eu-west-1', input: { InstanceTypes: ['t3.medium'], ProductDescriptions: ['Linux/UNIX'], StartTime: '2026-10-12T08:00:00.000Z' } }, output: { SpotPriceHistory: [] } }],
    'organizations.listRoots': [{ input: {}, output: { Roots: [{ Id: 'r-1' }] } }],
  });
  assert.deepEqual(await ports.spot.history('eu-west-1', { InstanceTypes: ['t3.medium'], ProductDescriptions: ['Linux/UNIX'], StartTime: new Date(NOW) }), { SpotPriceHistory: [] });
  assert.deepEqual(await ports.organizations.listRoots({ NextToken: undefined }), { Roots: [{ Id: 'r-1' }] });
});

test('a call without an equal entry fails, naming the call, and is kept as missed', async () => {
  const ports = recordedPorts({ 'ec2.describeInstances': [{ input: { InstanceIds: ['i-1'] }, output: { Reservations: [] } }] });
  await assert.rejects(ports.ec2.describeInstances({ InstanceIds: ['i-2'] }), /no recorded answer for ec2\.describeInstances\(\{"InstanceIds":\["i-2"\]\}\)/);
  await assert.rejects(ports.ecs.describeServices({ cluster: 'main', services: ['api'] }), /no recorded answer for ecs\.describeServices/);
  assert.deepEqual(ports.missed(), [
    { call: 'ec2.describeInstances', input: { InstanceIds: ['i-2'] } },
    { call: 'ecs.describeServices', input: { cluster: 'main', services: ['api'] } },
  ]);
});

test('a recorded error is thrown as AWS threw it: its name, message and status', async () => {
  const ports = recordedPorts({
    'ecs.describeTaskDefinition': [{ input: { taskDefinition: 'web:3' }, error: { name: 'AccessDeniedException', message: 'not authorized to perform: ecs:DescribeTaskDefinition' } }],
    'kubernetes.of': [{ input: { cluster: 'eks-prod' }, output: {} }],
    'kubernetes.list': [{ input: { cluster: 'eks-prod', path: '/api/v1/pods' }, error: { name: 'KubernetesError', message: 'Unauthorized', status: 401, reason: 'Unauthorized' } }],
  });
  await assert.rejects(ports.ecs.describeTaskDefinition({ taskDefinition: 'web:3' }), { name: 'AccessDeniedException', message: 'not authorized to perform: ecs:DescribeTaskDefinition' });
  const client = await ports.kubernetesOf('eks-prod');
  await assert.rejects(client.list('/api/v1/pods'), { name: 'KubernetesError', message: 'Unauthorized', status: 401, reason: 'Unauthorized' });
});

test('a cluster\'s client is a recorded call, then its gets by path and its lists by path, with the query when one is given', async () => {
  const ports = recordedPorts({
    'kubernetes.of': [{ input: { cluster: 'eks-demo' }, output: {} }],
    'kubernetes.get': [{ input: { cluster: 'eks-demo', path: '/apis/apps/v1/namespaces/demo/deployments/web' }, output: { metadata: { name: 'web' } } }],
    'kubernetes.list': [
      { input: { cluster: 'eks-demo', path: '/api/v1/namespaces/demo/pods', query: { labelSelector: 'app=web' } }, output: [{ metadata: { name: 'web-1' } }] },
      { input: { cluster: 'eks-demo', path: '/api/v1/pods' }, output: [] },
    ],
  });
  const client = await ports.kubernetesOf('eks-demo');
  assert.deepEqual(await client.get('/apis/apps/v1/namespaces/demo/deployments/web'), { metadata: { name: 'web' } });
  assert.deepEqual(await client.list('/api/v1/namespaces/demo/pods', { labelSelector: 'app=web' }), [{ metadata: { name: 'web-1' } }]);
  assert.deepEqual(await client.list('/api/v1/pods'), []);
  await assert.rejects(ports.kubernetesOf('eks-other'), /no recorded answer for kubernetes\.of\(\{"cluster":"eks-other"\}\)/);
});

test('the estimate\'s world: each call made in an account and region, its input inside', async () => {
  const world = recordedPorts({
    'elbv2.describeLoadBalancers': [
      { input: { account: '111111111111', region: 'eu-west-1', input: {} }, output: { LoadBalancers: [{ LoadBalancerName: 'web' }] } },
      { input: { account: '222222222222', region: 'eu-west-1', input: {} }, output: { LoadBalancers: [] } },
    ],
    'spot.history': [{ input: { account: '111111111111', region: 'eu-west-3', input: { InstanceTypes: ['t3.small'] } }, output: { SpotPriceHistory: [] } }],
  });
  assert.deepEqual(await world.at('111111111111', 'eu-west-1').elbv2.describeLoadBalancers({}), { LoadBalancers: [{ LoadBalancerName: 'web' }] });
  assert.deepEqual(await world.at('222222222222', 'eu-west-1').elbv2.describeLoadBalancers({}), { LoadBalancers: [] });
  // Spot price history: the region the price book asks for, from the profile's account.
  assert.deepEqual(await world.at('111111111111', 'us-east-1').spot.history('eu-west-3', { InstanceTypes: ['t3.small'] }), { SpotPriceHistory: [] });
  await assert.rejects(world.at('111111111111', 'us-east-1').elbv2.describeLoadBalancers({}), /no recorded answer/);
});

test('answers of a port or method the cases do not know are refused', () => {
  assert.throws(() => recordedPorts({ 'elbv2.deleteRule': [] }), /unknown port method elbv2\.deleteRule/);
  assert.ok(PORTS.elbv2.includes('describeRules') && PORTS.kubernetes.includes('list'));
});

test('an answer is a copy: the caller changing it changes neither the recording nor the next answer', async () => {
  const ports = recordedPorts({ 'elbv2.describeListeners': [{ input: { LoadBalancerArn: 'lb' }, output: { Listeners: [{ Port: 443 }, { Port: 80 }] } }] });
  const first = await ports.elbv2.describeListeners({ LoadBalancerArn: 'lb' });
  first.Listeners.sort((a, b) => a.Port - b.Port);
  assert.deepEqual((await ports.elbv2.describeListeners({ LoadBalancerArn: 'lb' })).Listeners, [{ Port: 443 }, { Port: 80 }]);
});

test('the recorder answers from a model and records each call once; the recording replayed answers the same', async () => {
  const model = (call, input) => {
    if (call === 'ec2.describeInstances') return { Reservations: [{ Instances: input.InstanceIds.map((InstanceId) => ({ InstanceId, InstanceType: 't3.medium' })) }] };
    if (call === 'ecs.describeTaskDefinition') throw Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });
    return undefined;
  };
  const rec = recorder(model);
  const asked = await rec.ports.ec2.describeInstances({ InstanceIds: ['i-1'] });
  await rec.ports.ec2.describeInstances({ InstanceIds: ['i-1'] });
  asked.Reservations.length = 0;
  await assert.rejects(rec.ports.ecs.describeTaskDefinition({ taskDefinition: 'web:3' }), { name: 'AccessDeniedException' });
  assert.deepEqual(rec.answers(), {
    'ec2.describeInstances': [{ input: { InstanceIds: ['i-1'] }, output: { Reservations: [{ Instances: [{ InstanceId: 'i-1', InstanceType: 't3.medium' }] }] } }],
    'ecs.describeTaskDefinition': [{ input: { taskDefinition: 'web:3' }, error: { name: 'AccessDeniedException', message: 'not authorized' } }],
  });
  const replay = recordedPorts(rec.answers());
  assert.deepEqual(await replay.ec2.describeInstances({ InstanceIds: ['i-1'] }), { Reservations: [{ Instances: [{ InstanceId: 'i-1', InstanceType: 't3.medium' }] }] });
  await assert.rejects(replay.ecs.describeTaskDefinition({ taskDefinition: 'web:3' }), { name: 'AccessDeniedException', message: 'not authorized' });
});

test('a call the model cannot answer is a gap of the corpus, never an AWS answer: kept apart, not recorded', async () => {
  const rec = recorder(() => undefined);
  await assert.rejects(rec.ports.rds.describeDBInstances({}), /the model has no answer for rds\.describeDBInstances/);
  assert.deepEqual(rec.answers(), {});
  assert.deepEqual(rec.gaps(), [{ call: 'rds.describeDBInstances', input: {} }]);
});

test('the recorder refuses a model answering one input two ways: the replay could not tell them apart', async () => {
  let n = 0;
  const rec = recorder(() => ({ n: (n += 1) }));
  await rec.ports.eks.listClusters({});
  await assert.rejects(rec.ports.eks.listClusters({}), /answered eks\.listClusters\(\{\}\) two ways/);
});

test('canonical JSON: keys sorted at every level, so equal inputs write the same', () => {
  assert.equal(canonical({ b: 1, a: [{ d: 2, c: 3 }] }), canonical({ a: [{ c: 3, d: 2 }], b: 1 }));
  assert.equal(canonical({ b: 1, a: { d: 2 } }), '{"a":{"d":2},"b":1}');
});
