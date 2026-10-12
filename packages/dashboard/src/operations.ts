// Operations display helpers: titles, progress, step colors.
import type { Operation, StepStatus } from './types';

const tgName = (arn = '') => arn.split(':').at(-1)?.split('/')[1] ?? arn;
const where = (op: Operation) => `${op.target.account}/${op.target.region}`;

export function operationTitle(op: Operation): string {
  switch (op.type) {
    // By the names people gave: the workload id is not for them (the router derives it from the target group).
    case 'onboard': {
      const name = op.input.name ?? op.context?.name;
      return `Onboard ${tgName(op.target.targetGroupArn)}${name ? ` as ${String(name)}` : ''}`;
    }
    // The name the workflow read from the router (once located).
    case 'offboard': return `Offboard ${String(op.context?.name ?? op.target.workloadId)} from ${op.target.router}`;
    case 'install-router': return `Install a router in ${where(op)}`;
    case 'upgrade-router': return `Upgrade the router of ${where(op)}`;
    case 'uninstall-router': return `Uninstall the router of ${where(op)}`;
    case 'exclude': return `Pause the workloads of an exclusion in ${op.target.account}`;
    case 'lift-exclusion': return `Resume the workloads of a lifted exclusion in ${op.target.account}`;
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
