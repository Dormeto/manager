import type { ResourceKind } from '@dormeto/discovery/types';
// The two kinds of workloads (vision standalone workloads design §2): an HTTP one, a route of a load balancer woken by its
// requests, and a standalone one, a resource napped by schedule, by a person or on its idle signals, never woken on demand. A
// row or a candidate without `kind` is HTTP (released routers send none).
import { mdiServerOutline, mdiWeb } from '@mdi/js';

export type Kind = 'http' | 'standalone';
export const kindOf = (row: { kind?: unknown } | null | undefined): Kind => (row?.kind === 'standalone' ? 'standalone' : 'http');
export const isStandalone = (row: { kind?: unknown } | null | undefined): boolean => kindOf(row) === 'standalone';

export const KINDS: { value: Kind; title: string; short: string; icon: string; help: string }[] = [
  { value: 'http', title: 'HTTP workload', short: 'HTTP', icon: mdiWeb, help: 'A route of a load balancer and its backends: it naps when no request comes for its idle window, and the next request wakes it.' },
  { value: 'standalone', title: 'Standalone workload', short: 'Standalone', icon: mdiServerOutline, help: 'A resource with no load balancer: it naps on a schedule, on a person\'s word or when its idle signals stay under their thresholds; nothing wakes it on demand.' },
];
export const kindInfo = (kind: Kind) => KINDS.find((k) => k.value === kind)!;

// A standalone workload's resource kind, from its resource's ARN (its row has the ARN alone).
export function resourceKindOfArn(arn: string | undefined): ResourceKind | undefined {
  if (!arn) return undefined;
  if (/^arn:[^:]+:ec2:[^:]*:\d+:instance\//.test(arn)) return 'instance';
  if (/^arn:[^:]+:autoscaling:/.test(arn)) return 'asg';
  if (/^arn:[^:]+:ecs:[^:]*:\d+:service\//.test(arn)) return 'ecs';
  if (/^arn:[^:]+:rds:[^:]*:\d+:db:/.test(arn)) return 'rds-instance';
  if (/^arn:[^:]+:rds:[^:]*:\d+:cluster:/.test(arn)) return 'rds-cluster';
  return undefined;
}
