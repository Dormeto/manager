// The router blueprint published with each router version (router install/blueprint.mjs), and its placeholders.
export interface Policy {
  Version: string;
  Statement: Record<string, unknown>[];
}

export interface Blueprint {
  router: { name: string; region: string; account: string; version: string; build: string };
  tags: Record<string, string>;
  roles: { key: string; path: string; name: string; trust: Policy; policyName: string; policy: Policy }[];
  table: { name: string; hashKey: string; rangeKey: string; ttlAttribute: string; pointInTimeRecovery: boolean };
  queues: { key: string; name: string; retentionSeconds: number; managedEncryption: boolean }[];
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
