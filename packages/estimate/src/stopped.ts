// What a nap would stop, as the router describes it (router lambda/src/lib/stopped.mjs, R9a): the same items the
// product prices. The router's module is JavaScript without types: typed here, at its one entry.
import type { StoppedItem } from '@dormeto/fleet';
// @ts-expect-error the router's module has no type declarations
import { describeStopped as describe } from '../../../../router/lambda/src/lib/stopped.mjs';

export type RouterBackend =
  | { kind: 'instance'; id: string }
  | { kind: 'asg'; name: string; desired: number; instances: string[] }
  | { kind: 'ecs'; id: string; cluster: string; desired: number }
  // A Kubernetes owner (router 0.29.0, R10.5): its pods and their nodes, read through the cluster's API.
  | { kind: 'k8s'; id: string; cluster: string; namespace: string; owner: { kind: string; name: string }; autoscaler: string | null };
export interface StoppedPorts {
  ec2: { describeInstances(input: { InstanceIds: string[] }): Promise<{ Reservations?: { Instances?: { InstanceId?: string; InstanceType?: string; PlatformDetails?: string; InstanceLifecycle?: string; State?: { Name?: string }; SecurityGroups?: { GroupId?: string }[] }[] }[] }> };
  ecs: {
    describeServices(input: { cluster: string; services: string[] }): Promise<{ services?: { serviceArn?: string; desiredCount?: number; launchType?: string; capacityProviderStrategy?: { capacityProvider?: string; weight?: number; base?: number }[]; taskDefinition?: string; networkConfiguration?: { awsvpcConfiguration?: { securityGroups?: string[] } } }[] }>;
    describeTaskDefinition(input: { taskDefinition: string }): Promise<{ taskDefinition?: { cpu?: string; memory?: string; runtimePlatform?: { cpuArchitecture?: string; operatingSystemFamily?: string } } }>;
  };
  // A cluster's API (the router's client, with the profile's access): Kubernetes owners only.
  kubernetesOf?: (cluster: string) => Promise<unknown>;
}

export const describeStopped = describe as (ports: StoppedPorts & { rds?: unknown }, backends: RouterBackend[]) => Promise<StoppedItem[]>;
