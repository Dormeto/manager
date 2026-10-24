// The router blueprint published with each router version (router install/blueprint.mjs), and its placeholders.
import type { KubeProxy } from './kube-proxies.js';

export interface Policy {
  Version: string;
  Statement: Record<string, unknown>[];
}

export interface Blueprint {
  router: { name: string; region: string; account: string; version: string; build: string };
  tags: Record<string, string>;
  roles: { key: string; path: string; name: string; trust: Policy; policyName: string; policy: Policy }[];
  table: { name: string; hashKey: string; rangeKey: string; ttlAttribute: string; pointInTimeRecovery: boolean };
  queues: {
    key: string; name: string; retentionSeconds: number; managedEncryption: boolean;
    // Routers 0.22.0 and later: the work and drift queues.
    visibilityTimeoutSeconds?: number; deadLetter?: { queue: string; maxReceiveCount: number }; policy?: Policy;
  }[];
  logGroups: { name: string; retentionDays: number }[];
  functions: {
    key: string; name: string; role: string; roleArn: string; handler: string; timeout: number; memory: number; runtime: string; architectures: string[];
    environment: Record<string, string>;
    asyncInvoke?: { maximumRetryAttempts: number; maximumEventAgeInSeconds: number; onFailure: string };
  }[];
  eventRule: { name: string; pattern: string; target: string; description: string };
  // Routers 0.20.0 and later: one permission for every waker target group of the router.
  wakerPermission?: { function: string; statementId: string; principal: string; sourceArn: string };
  schedule: { name: string; expression: string; target: string; roleArn: string; input: string; deadLetter: string; maximumRetryAttempts: number };
  // Routers 0.22.0 and later: the readers of the work and drift queues.
  eventSourceMappings?: { key: string; function: string; queue: string; batchSize: number; maximumBatchingWindowSeconds: number; maximumConcurrency: number; reportBatchItemFailures: boolean }[];
  // Routers 0.23.0 and later: the forwarder of event-driven discovery refresh, installed per account (packaging design §5).
  forwarder?: Forwarder;
  // Routers 0.33.0 and later: the Kubernetes proxy of each cluster whose endpoint is private, applied per cluster (R10.6).
  kubeProxy?: KubeProxy;
}

export interface Forwarder {
  role: { name: string; path: string; tags: Record<string, string>; trust: Policy; policyName: string; policy: Policy };
  rule: { name: string; pattern: string; targetBus: string; roleArn: string; description: string };
}

// Replace every ${key} of the string values.
export function fill<T>(value: T, values: Record<string, string>): T {
  if (typeof value === 'string') {
    return value.replace(/\$\{(\w+)\}/g, (whole, key: string) => {
      if (!(key in values)) throw new Error(`blueprint placeholder without a value: ${whole}`);
      return values[key]!;
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, values)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, values)])) as T;
  return value;
}
