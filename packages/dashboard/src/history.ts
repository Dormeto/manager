// The state history on the workload view (R8): a row per local day of colored phases, and what started each phase.
export interface Phase { state: string; from: string; to: string; cause?: string; by?: string; inferred?: boolean; first?: boolean; hibernated?: string[] }
export interface Segment { state: string; left: number; width: number; phase: Phase; merged: number }
export interface DayRow { day: Date; segments: Segment[] }

const LABELS: Record<string, string> = { AWAKE: 'Awake', NAPPING: 'Napping', ASLEEP: 'Asleep', WAKING: 'Waking', FAILED: 'Failed', UNKNOWN: 'Unknown' };
export const stateLabel = (state: string): string => LABELS[state] ?? state;
// The order of the states in the history's legend and the 7-day bar.
export const STATE_ORDER = ['AWAKE', 'NAPPING', 'ASLEEP', 'WAKING', 'FAILED', 'UNKNOWN'];

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

// A day's activity as a wave (the History card): the share of each slice of the day spent awake (awake, waking,
// napping or failed: anything but asleep), null where the history knows nothing; and where the day's wakes and failures
// start, as fractions of the day.
export interface DayWave { shares: (number | null)[]; wakes: number[]; failures: number[] }
export function dayWave(phases: Phase[], day: Date, from: string, to: string, slices = 96): DayWave {
  const d0 = day.getTime();
  const d1 = nextDay(day).getTime();
  const start = Math.max(d0, Date.parse(from));
  const end = Math.min(d1, Date.parse(to));
  const size = (d1 - d0) / slices;
  const known: number[] = new Array(slices).fill(0);
  const awake: number[] = new Array(slices).fill(0);
  const wakes: number[] = [];
  const failures: number[] = [];
  for (const phase of phases) {
    const begins = Date.parse(phase.from);
    if (begins >= start && begins < end) {
      if (phase.state === 'WAKING') wakes.push((begins - d0) / (d1 - d0));
      if (phase.state === 'FAILED') failures.push((begins - d0) / (d1 - d0));
    }
    const a = Math.max(begins, start);
    const b = Math.min(Date.parse(phase.to), end);
    if (b <= a || phase.state === 'UNKNOWN') continue;
    for (let i = Math.floor((a - d0) / size); i < slices && d0 + i * size < b; i += 1) {
      const overlap = Math.min(b, d0 + (i + 1) * size) - Math.max(a, d0 + i * size);
      if (overlap <= 0) continue;
      known[i] = (known[i] ?? 0) + overlap;
      if (phase.state !== 'ASLEEP') awake[i] = (awake[i] ?? 0) + overlap;
    }
  }
  return { shares: known.map((k, i) => (k > size * 0.05 ? (awake[i] ?? 0) / k : null)), wakes, failures };
}

// The wave's paths in a width x height box (the base at the bottom): for each run of known slices, a smooth line through
// the slices' shares and the area under it; and the line of sleep along the base where slices are wholly asleep.
export function wavePaths(shares: (number | null)[], width = 1440, base = 27, top = 3): { line: string; area: string; sleep: string } {
  const n = shares.length;
  const x = (i: number) => ((i + 0.5) / n) * width;
  const y = (v: number) => base - v * (base - top);
  const f = (v: number) => Math.round(v * 10) / 10;
  let line = '';
  let area = '';
  let sleep = '';
  for (let i = 0; i < n; ) {
    if (shares[i] === null) { i += 1; continue; }
    let j = i;
    while (j + 1 < n && shares[j + 1] !== null) j += 1;
    const x0 = (i / n) * width;
    const x1 = ((j + 1) / n) * width;
    let run = `M${f(x0)} ${f(y(shares[i]!))} L${f(x(i))} ${f(y(shares[i]!))}`;
    for (let k = i + 1; k <= j; k += 1) {
      const mid = f((x(k - 1) + x(k)) / 2);
      run += ` C${mid} ${f(y(shares[k - 1]!))} ${mid} ${f(y(shares[k]!))} ${f(x(k))} ${f(y(shares[k]!))}`;
    }
    run += ` L${f(x1)} ${f(y(shares[j]!))}`;
    line += `${run} `;
    area += `${run} L${f(x1)} ${base} L${f(x0)} ${base} Z `;
    for (let k = i; k <= j; ) {
      if (shares[k] !== 0) { k += 1; continue; }
      let m = k;
      while (m + 1 <= j && shares[m + 1] === 0) m += 1;
      sleep += `M${f((k / n) * width)} ${base} L${f(((m + 1) / n) * width)} ${base} `;
      k = m + 1;
    }
    i = j + 1;
  }
  return { line: line.trim(), area: area.trim(), sleep: sleep.trim() };
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
  schedule: 'a scheduled window',
  maintenance: 'the maximum nap (a maintenance wake)',
  recovered: 'recovered, seen at a check',
  'external-start': 'started outside Dormeto',
  'external-stop': 'stopped outside Dormeto',
};

// What started a phase, in words ('' when the history does not say); a nap that hibernated instances says how many.
export function causeText(p: { state: string; cause?: string; by?: string; inferred?: boolean; first?: boolean; hibernated?: string[] }): string {
  const hibernated = p.state === 'ASLEEP' && p.hibernated?.length ? `hibernated ${p.hibernated.length} instance${p.hibernated.length === 1 ? '' : 's'}` : '';
  return [startText(p), hibernated].filter(Boolean).join(', ');
}

function startText(p: { state: string; cause?: string; by?: string; inferred?: boolean; first?: boolean }): string {
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
