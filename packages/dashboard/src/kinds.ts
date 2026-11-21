import type { ResourceKind } from '@dormeto/discovery/types';
// The two kinds of workloads (vision standalone workloads design §2): an HTTP one, a route of a load balancer woken by its
// requests, and a standalone one, a resource napped by schedule, by a person or on its idle signals, never woken on demand. A
// row or a candidate without `kind` is HTTP (released routers send none).
import { mdiServerOutline, mdiWeb } from '@mdi/js';
import type { Cloud } from '@dormeto/fleet/clouds';
import { cloudWords } from './cloud-words';

export type Kind = 'http' | 'standalone';
export const kindOf = (row: { kind?: unknown } | null | undefined): Kind => (row?.kind === 'standalone' ? 'standalone' : 'http');
export const isStandalone = (row: { kind?: unknown } | null | undefined): boolean => kindOf(row) === 'standalone';

// Each kind's one definition: its icon (the rows' mark, the Kind filter, the workload's page, Discovery), its names, its
// meaning, and `mark`, the row icon's tooltip in one line.
export const KINDS: { value: Kind; title: string; short: string; icon: string; help: string; mark: string }[] = [
  {
    value: 'http', title: 'HTTP workload', short: 'HTTP', icon: mdiWeb, help: 'A route of a load balancer and its backends: it naps when no request comes for its idle window, and the next request wakes it.',
    mark: 'HTTP: a route of a load balancer. Its next request wakes it.',
  },
  {
    value: 'standalone', title: 'Standalone workload', short: 'Standalone', icon: mdiServerOutline, help: 'A resource with no load balancer: it naps on a schedule, on a person\'s word or when its idle signals stay under their thresholds; nothing wakes it on demand.',
    mark: 'Standalone: a resource with no load balancer. A schedule, a person or a start made in AWS wakes it.',
  },
];
export const kindInfo = (kind: Kind) => KINDS.find((k) => k.value === kind)!;
// The row icon's tooltip in its cloud's words: a standalone one's names who else wakes it.
export const kindMark = (kind: Kind, cloud?: Cloud | null) => (kind === 'standalone'
  ? `Standalone: a resource with no load balancer. A schedule, a person or ${cloudWords(cloud).standalone.startOutside} wakes it.` : kindInfo(kind).mark);

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
// A Google Cloud standalone resource's kind, from its path (discovery's GOOGLE_RESOURCE_PATH): a VM, a managed instance group, a
// Cloud SQL instance (projects/<p>/instances/<name>).
export function resourceKindOfPath(path: string | undefined): ResourceKind | undefined {
  if (!path) return undefined;
  if (/^projects\/[^/]+\/zones\/[^/]+\/instances\/[^/]+$/.test(path)) return 'instance';
  if (/^projects\/[^/]+\/(zones|regions)\/[^/]+\/instanceGroupManagers\/[^/]+$/.test(path)) return 'asg';
  if (/^projects\/[^/]+\/instances\/[^/]+$/.test(path)) return 'cloudsql-instance';
  return undefined;
}
// A row's resource kind, on either cloud.
export const resourceKindOf = (row: { resourceArn?: string; resource?: string }): ResourceKind | undefined => resourceKindOfArn(row.resourceArn) ?? resourceKindOfPath(row.resource);
