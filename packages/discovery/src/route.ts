// What an invocation of the discovery function asks: a step of the state machine, the idle window advisor's requests
// (R10), a batch of forwarded load balancer changes, or a whole run (the schedule, the dashboard's run on demand). An
// unknown step is refused: it is never taken for a whole run.
// activity: a standalone workload's signals (its Activity history).
export type Route = 'plan' | 'account' | 'finalize' | 'abandon' | 'requests' | 'activity' | 'refresh' | 'run';
const STEPS = new Set<Route>(['plan', 'account', 'finalize', 'abandon', 'requests', 'activity']);

export function routeOf(event: object): Route {
  const step = (event as { step?: unknown }).step;
  if (step !== undefined) {
    if (typeof step === 'string' && STEPS.has(step as Route)) return step as Route;
    throw new Error(`unknown step: ${String(step)}`);
  }
  return 'Records' in event ? 'refresh' : 'run';
}
