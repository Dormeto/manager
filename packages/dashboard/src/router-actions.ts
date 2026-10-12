// The Routers view's actions, explained in their tooltips: what each does, and whether it asks first.
import type { RouterOperationType } from './types';

export const upgradeHelp = (router: string, from: string, to: string) =>
  `Upgrade ${router} from ${from} to ${to}: Dormeto updates its functions, roles and settings in place by AWS API calls, through `
  + 'the command role; its workloads keep their state, settings and pauses. Starts at once when clicked, as an operation followed in Operations.';

export const upgradingHelp = (router: string, to: string | null) =>
  `Upgrading ${router}${to ? ` to ${to}` : ''}: Dormeto updates its functions, roles and settings in place; its workloads keep their state. `
  + 'Open its steps in Operations.';

const OPERATION_LABEL: Record<RouterOperationType, string> = { 'install-router': 'Installation', 'upgrade-router': 'Upgrade', 'uninstall-router': 'Uninstallation' };

// How a router operation ended, for the toast that says it.
export const operationEnded = (type: RouterOperationType, router: string, op: { status: string; error?: string }) =>
  op.status === 'succeeded' ? `${OPERATION_LABEL[type]} of ${router} succeeded.` : `${OPERATION_LABEL[type]} of ${router} failed: ${op.error ?? 'see its steps'}.`;

export const uninstallHelp = (router: string) =>
  `Uninstall ${router}: deletes every resource of the router (functions, table, queues, rules, roles) by AWS API calls. Asks for `
  + 'confirmation first, and is refused while the router has workloads: offboard them first.';

export const pauseHelp = (router: string) =>
  `Pause ${router}: it never naps its workloads until you resume it, or until the date you choose; requests still wake them, and `
  + 'asleep workloads are woken unless you keep them asleep. Asks for a reason first.';

export const resumeHelp = (router: string) =>
  `Resume ${router}: its workloads nap again when idle; a workload paused on its own stays paused. Starts at once when clicked.`;

export const workloadsHelp = (router: string, state: string, count: number) =>
  count === 1
    ? `1 workload ${state.toLowerCase()} on ${router}: open it`
    : `${count} workloads ${state.toLowerCase()} on ${router}: open their list`;
