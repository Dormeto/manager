// EC2 hibernation as the dashboard words it (router 0.32.0 and later): where a workload's value comes from, which of its
// instances can hibernate, and what a router that inherits its value reads.
import { relative } from './format';
import type { Hibernation, ManagerSettings } from './types';

const FROM: Record<Hibernation['from'], string> = {
  workload: 'set on this workload',
  'fallback-types': 'off: the workload has fallback instance types',
  router: 'from the router',
  manager: "from the manager's default",
  default: 'built-in default',
};
export const fromText = (from: Hibernation['from']): string => FROM[from];

const onOff = (value: boolean) => (value ? 'On' : 'Off');

// "On, from the router"; the fallback types' text already says "off:" and reads as one sentence (capitalised). A router that
// has not read the manager's settings yet (or whose reads all failed) stops the instances plainly until it has.
export function hibernationLine(h: Pick<Hibernation, 'hibernate' | 'from' | 'unknown'>): string {
  if (h.unknown) return "Off for now: the router has not read the manager's settings yet (naps stop)";
  const text = fromText(h.from);
  return h.from === 'fallback-types' ? `${text[0]!.toUpperCase()}${text.slice(1)}` : `${onOff(h.hibernate)}, ${text}`;
}

// Which instances were launched with hibernation (a stop of the others is a plain one); '' when the router does not say, or
// when the value is off (every instance is stopped then, so the line would mislead).
export function readinessLine(h: Pick<Hibernation, 'hibernate' | 'instances'>): string {
  const { instances } = h;
  if (!instances?.length || !h.hibernate) return '';
  const without = instances.filter((i) => !i.configured);
  if (!without.length) return 'Every instance was launched with hibernation';
  return `${instances.length - without.length} of ${instances.length} instances were launched with hibernation; ${without.map((i) => i.id).join(', ')} ${without.length === 1 ? 'is' : 'are'} stopped instead`;
}

// After 59 days hibernated the run asks for a fresh boot (AWS keeps a hibernation 60 days at most): the next nap is a plain stop.
export const freshBootLine = (h: Pick<Hibernation, 'freshBoot'>): string => (h.freshBoot ? 'The next nap stops the instances (a fresh boot after 59 days hibernated)' : '');

// What Inherit means for a router: the manager's value as it last read it, unknown (naps stop) while it has read none, or
// the built-in default without manager settings. `readAt` is its last attempt: the failed one when there is an error.
export function routerInheritText(m: ManagerSettings, now = Date.now()): string {
  if (m.url === null) return 'built-in default: On';
  if (m.hibernate === null) return `manager: unknown (${m.error ?? 'not read yet'}): naps stop`;
  return m.error ? `manager: ${onOff(m.hibernate)} (last read failed ${relative(m.readAt, now)}: ${m.error})` : `manager: ${onOff(m.hibernate)}, read ${relative(m.readAt, now)}`;
}
