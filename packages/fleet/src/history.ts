// A period of a workload's state history (R8), computed when read: its consecutive phases, the time in each state and
// its wakes. The period ends at now at the latest; before the first entry the history has, the state is UNKNOWN.
import type { HistoryEntry } from './store.js';
import type { StoppedItem } from './prices.js';

export interface Phase { state: string; from: string; to: string; cause?: string; by?: string; inferred?: boolean; first?: boolean; stopped?: StoppedItem[] }
export interface HistoryView {
  from: string;
  to: string;
  phases: Phase[];
  totals: Record<string, number>; // seconds per state
  wakes: { count: number; failed: number; medianMs: number | null; maxMs: number | null };
}

const iso = (ms: number) => new Date(ms).toISOString();

// initial: the state at the period's start when no entry before it is kept (the last one expired: review I3).
export function historyView({ before, entries, from, to, now, initial }: { before: HistoryEntry | null; entries: HistoryEntry[]; from: string; to: string; now: string; initial?: string }): HistoryView {
  const start = Date.parse(from);
  const end = Math.max(start, Math.min(Date.parse(to), Date.parse(now)));
  const clamp = (at: string) => Math.min(Math.max(Date.parse(at), start), end);
  const phases: { state: string; from: number; to: number; cause?: string; by?: string; inferred?: boolean; first?: boolean; stopped?: StoppedItem[] }[] = [];
  let current: (typeof phases)[number] = { state: before?.to ?? initial ?? 'UNKNOWN', from: start, to: end };
  for (const entry of entries) {
    // A twin (an inferred entry after its event, or a duplicate) changes nothing.
    if (entry.to === current.state) continue;
    const at = clamp(entry.at);
    phases.push({ ...current, to: at });
    current = {
      state: entry.to, from: at, to: end,
      ...(entry.cause ? { cause: entry.cause } : {}), ...(entry.by ? { by: entry.by } : {}), ...(entry.inferred ? { inferred: true } : {}),
      ...(entry.from === null ? { first: true } : {}), ...(entry.stopped ? { stopped: entry.stopped } : {}),
    };
  }
  phases.push(current);
  // Phases of no length go (two changes at the same instant, a time past the end); neighbors of one state join.
  const kept: typeof phases = [];
  for (const p of phases.filter((x) => x.to > x.from)) {
    const last = kept.at(-1);
    if (last && last.state === p.state) last.to = p.to;
    else kept.push({ ...p });
  }
  const totals: Record<string, number> = {};
  for (const p of kept) totals[p.state] = (totals[p.state] ?? 0) + Math.round((p.to - p.from) / 1000);
  const durations = entries.filter((x) => x.to === 'AWAKE' && typeof x.durationMs === 'number').map((x) => x.durationMs!).sort((a, b) => a - b);
  return {
    from: iso(start),
    to: iso(end),
    phases: kept.map((p) => ({ ...p, from: iso(p.from), to: iso(p.to) })),
    totals,
    wakes: {
      count: entries.filter((x) => x.to === 'WAKING').length,
      failed: entries.filter((x) => x.to === 'FAILED' && x.failure?.step !== 'nap' && x.from !== 'NAPPING').length,
      medianMs: durations.length ? durations[Math.floor((durations.length - 1) / 2)]! : null,
      maxMs: durations.length ? durations.at(-1)! : null,
    },
  };
}
