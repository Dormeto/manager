// Operations display helpers: titles, kinds, progress, step colors, a manager update's build.
import type { Operation, StepStatus } from './types';
import { consoleLink } from './update';

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
    // Event-driven refresh (packaging design §5): the account's forwarder.
    case 'connect-account': return `Connect ${op.target.account} to event-driven refresh (${((op.input.regions as string[] | undefined) ?? []).join(', ')})`;
    case 'disconnect-account': return `Disconnect ${op.target.account} from event-driven refresh`;
    // A request of the Update page: Prepare (the plan) or Confirm (the apply).
    case 'update-manager': return op.input.action === 'plan' ? `Prepare the update of the manager to ${op.target.version}` : `Update the manager to ${op.target.version}`;
  }
}

// The kind of an operation, as its card names it.
export const operationKind = (op: Operation): string => (op.type === 'update-manager' ? 'Manager update' : op.type.replace(/-/g, ' '));

// A manager update's build in the CodeBuild console, once the build is known.
export const operationBuildLink = (op: Operation): string | null => (op.type === 'update-manager' ? consoleLink(op.context?.consoleUrl) : null);

// Steps finished (done or skipped), and the step running with its last detail.
export function operationProgress(op: Operation): { done: number; total: number; current: string | null } {
  const done = op.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const step = op.status === 'running' ? op.steps[op.cursor] : undefined;
  return { done, total: op.steps.length, current: step ? `${step.name}${step.detail ? `: ${step.detail}` : ''}` : null };
}

const COLORS: Record<StepStatus, string> = { done: 'success', skipped: 'grey', running: 'primary', pending: 'grey', failed: 'error' };
export const stepColor = (status: string): string => COLORS[status as StepStatus] ?? 'grey';
