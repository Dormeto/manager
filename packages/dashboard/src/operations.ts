// Operations display helpers: titles, progress, step colors, suggested workload ids.
import type { Operation, StepStatus } from './types';

const tgName = (arn = '') => arn.split(':').at(-1)?.split('/')[1] ?? arn;
const where = (op: Operation) => `${op.target.account}/${op.target.region}`;

export function operationTitle(op: Operation): string {
  switch (op.type) {
    case 'onboard': return `Onboard ${tgName(op.target.targetGroupArn)} as ${String(op.input.workloadId ?? '?')}`;
    case 'offboard': return `Offboard ${op.target.workloadId} from ${op.target.router}`;
    case 'install-router': return `Install a router in ${where(op)}`;
    case 'upgrade-router': return `Upgrade the router of ${where(op)}`;
    case 'uninstall-router': return `Uninstall the router of ${where(op)}`;
  }
}

// Steps finished (done or skipped), and the step running with its last detail.
export function operationProgress(op: Operation): { done: number; total: number; current: string | null } {
  const done = op.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const step = op.status === 'running' ? op.steps[op.cursor] : undefined;
  return { done, total: op.steps.length, current: step ? `${step.name}${step.detail ? `: ${step.detail}` : ''}` : null };
}

const COLORS: Record<StepStatus, string> = { done: 'success', skipped: 'grey', running: 'primary', pending: 'grey', failed: 'error' };
export const stepColor = (status: string): string => COLORS[status as StepStatus] ?? 'grey';

// A workload id from a suggestion: lowercase letters, digits and hyphens, short enough for the waker target group name
// (<router>-<id>, 32 characters at most).
export function workloadIdFrom(suggestion: string | null | undefined, routerName: string): string {
  const max = 32 - routerName.length - 1;
  return (suggestion ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, max).replace(/-+$/, '');
}
