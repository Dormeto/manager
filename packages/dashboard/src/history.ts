// The state history on the workload view (R8): a row per local day of colored phases, and what started each phase.
export interface Phase { state: string; from: string; to: string; cause?: string; by?: string; inferred?: boolean; first?: boolean }
export interface Segment { state: string; left: number; width: number; phase: Phase; merged: number }
export interface DayRow { day: Date; segments: Segment[] }

const LABELS: Record<string, string> = { AWAKE: 'Awake', NAPPING: 'Napping', ASLEEP: 'Asleep', WAKING: 'Waking', FAILED: 'Failed', UNKNOWN: 'Unknown' };
export const stateLabel = (state: string): string => LABELS[state] ?? state;

// The narrowest a phase is drawn (percent of a day's row, about 2 pixels): a 40-second wake stays visible.
export const MIN_WIDTH = 0.25;

const midnight = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d; };
const nextDay = (d: Date) => { const n = new Date(d); n.setDate(n.getDate() + 1); return n; };

// Each phase within the period, cut at local midnights; a phase too narrow to draw after its neighbor joins it (merged
// says how many changes it holds).
export function dayRows(phases: Phase[], from: string, to: string): DayRow[] {
  const start = Date.parse(from);
  const end = Date.parse(to);
  const rows: DayRow[] = [];
  for (let day = midnight(start); day.getTime() < end; day = nextDay(day)) {
    const d0 = day.getTime();
    const d1 = nextDay(day).getTime();
    const span = d1 - d0;
    const parts = phases
      .map((phase) => ({ phase, a: Math.max(Date.parse(phase.from), d0, start), b: Math.min(Date.parse(phase.to), d1, end) }))
      .filter(({ a, b }) => b > a);
    const segments: Segment[] = [];
    let drawnEnd = 0;
    for (const { phase, a, b } of parts) {
      const left = ((a - d0) / span) * 100;
      const right = ((b - d0) / span) * 100;
      const last = segments.at(-1);
      if (last && right <= drawnEnd) {
        last.merged += 1;
        continue;
      }
      const drawStart = Math.max(left, drawnEnd);
      const width = Math.max(right - drawStart, MIN_WIDTH);
      const at = Math.min(drawStart, 100 - width);
      segments.push({ state: phase.state, left: at, width, phase, merged: 0 });
      drawnEnd = at + width;
    }
    rows.push({ day, segments });
  }
  return rows;
}

// Days with no history at all (before the manager knew the workload, or past the retention) are one line, not rows.
export type RowItem = { kind: 'day'; row: DayRow } | { kind: 'gap'; first: Date; last: Date; days: number };
export function collapseRows(rows: DayRow[]): RowItem[] {
  const items: RowItem[] = [];
  for (const row of rows) {
    const empty = row.segments.every((s) => s.state === 'UNKNOWN');
    const last = items.at(-1);
    if (!empty) items.push({ kind: 'day', row });
    else if (last?.kind === 'gap') { last.last = row.day; last.days += 1; }
    else items.push({ kind: 'gap', first: row.day, last: row.day, days: 1 });
  }
  return items;
}

const CAUSES: Record<string, string> = {
  normal: 'a request',
  probe: "the waiting page's check",
  header: 'a request with the x-dormeto-wake header',
  admin: "the router's admin page",
  'rule-issues': 'its rules, which the router could not switch',
  idle: 'the idle check (no request for its idle window)',
  'pending-wake': 'a request during the nap',
  paused: 'a pause during the nap',
  'wake-failed': 'the wake failed',
  'nap-failed': 'the nap failed',
  'wake-stuck': 'the wake stopped (its invocation ended)',
  'nap-stuck': 'the nap stopped (its invocation ended)',
  'invoke-failed': 'the controller could not be invoked',
  'failed-released': 'released after its idle window (the wake had failed)',
  recovered: 'recovered, seen at a check',
  'external-start': 'started outside Dormeto',
  'external-stop': 'stopped outside Dormeto',
};

// What started a phase, in words ('' when the history does not say).
export function causeText(p: { state: string; cause?: string; by?: string; inferred?: boolean; first?: boolean }): string {
  if (p.first) return 'first seen by the manager';
  if (p.inferred) return 'seen at a check (its event was lost)';
  if (!p.cause) return '';
  // The router's own wakes (rules it cannot switch) say "dormeto": no one to name.
  const who = p.by && p.by !== 'dormeto' ? ` by ${p.by}` : '';
  if (p.cause === 'manager') return `${p.state === 'NAPPING' ? 'napped' : 'woken'} from the manager${who}`;
  if (p.cause === 'pause') return `woken for a pause${who}`;
  if (p.cause.startsWith('rule ')) return `the wake rule ${p.cause.slice(5)}`;
  return `${CAUSES[p.cause] ?? p.cause}${who}`;
}
