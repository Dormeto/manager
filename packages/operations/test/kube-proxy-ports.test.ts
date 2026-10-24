// The SDK adapters of the Kubernetes proxies step (src/aws.ts): each port method sends its command with the input given.
import { describe, expect, it } from 'vitest';
import { kubeProxyClientPorts } from '../src/aws.js';
import type { KubeProxyPorts } from '../src/kube-proxies.js';

describe('the Kubernetes proxies\' ports', () => {
  it('send the EC2, Lambda, IAM, CloudWatch Logs and EKS commands their methods name', async () => {
    const sent: [string, string, unknown][] = [];
    const client = (service: string) => ({ async send(command: { constructor: { name: string }; input: unknown }) { sent.push([service, command.constructor.name, command.input]); return {}; } });
    const ports = kubeProxyClientPorts({ ec2: client('ec2'), lambda: client('lambda'), iam: client('iam'), logs: client('logs'), eks: client('eks') });
    const expected: Record<keyof KubeProxyPorts, string[]> = {
      ec2: ['describeVpcs', 'describeSecurityGroups', 'createSecurityGroup', 'authorizeSecurityGroupEgress', 'revokeSecurityGroupEgress', 'authorizeSecurityGroupIngress', 'revokeSecurityGroupIngress', 'deleteSecurityGroup', 'describeNetworkInterfaces'],
      lambda: ['getFunctionConfiguration', 'createFunction', 'updateFunctionConfiguration', 'updateFunctionCode', 'deleteFunction'],
      iam: ['getRole', 'createRole', 'updateAssumeRolePolicy', 'getRolePolicy', 'putRolePolicy', 'listRolePolicies', 'deleteRolePolicy', 'deleteRole'],
      logs: ['describeLogGroups', 'createLogGroup', 'putRetentionPolicy', 'deleteLogGroup'],
      eks: ['listClusters', 'describeCluster'],
    };
    for (const [service, methods] of Object.entries(expected) as [keyof KubeProxyPorts, string[]][]) {
      expect(Object.keys(ports[service]).sort(), service).toEqual([...methods].sort());
      for (const method of methods) await (ports[service] as Record<string, (input: unknown) => Promise<unknown>>)[method]!({ probe: method });
    }
    const pascal = (method: string) => `${method[0]!.toUpperCase()}${method.slice(1)}Command`;
    expect(sent).toEqual(Object.entries(expected).flatMap(([service, methods]) => methods.map((m) => [service, pascal(m), { probe: m }])));
  });
});
