// A workload's requests per hour as a grid, GitHub style: a row per local day (the latest last), a column per local
// hour, each cell's level from 0 (no request) to 4 by the quartiles of the shown hours with requests (the busiest
// hours always at 4).
const HOUR_MS = 3_600_000;

export interface HeatCell { hour: number; count: number | null; level: 0 | 1 | 2 | 3 | 4 }
export interface HeatRow { day: Date; cells: HeatCell[] }
export interface Heatmap {
  rows: HeatRow[];
  total: number;
  known: number; // hours with data
  quiet: number; // of those, hours without any request
  busiest: { day: Date; hour: number; count: number } | null;
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

// hours: the API's counts per UTC hour from `from`; days: how many local days to show, ending with the last hour's.
// An hour outside the counts (before the period, or after it) has no count: drawn as no data.
export function heatmap(hours: { from: string; counts: number[] }, days: number): Heatmap {
  const start = Date.parse(hours.from);
  const byHour = new Map<string, number>();
  hours.counts.forEach((n, i) => {
    const t = new Date(start + i * HOUR_MS);
    // A local hour may hold two UTC hours (the night the clocks go back): added up.
    const key = `${dayKey(t)}|${t.getHours()}`;
    byHour.set(key, (byHour.get(key) ?? 0) + n);
  });
  const last = new Date(start + Math.max(0, hours.counts.length - 1) * HOUR_MS);
  const rows: HeatRow[] = [];
  for (let d = days - 1; d >= 0; d -= 1) {
    const day = new Date(last.getFullYear(), last.getMonth(), last.getDate() - d);
    rows.push({ day, cells: Array.from({ length: 24 }, (_, hour) => ({ hour, count: byHour.get(`${dayKey(day)}|${hour}`) ?? null, level: 0 as const })) });
  }
  const cells = rows.flatMap((r) => r.cells);
  const busy = cells.map((c) => c.count ?? 0).filter((n) => n > 0).sort((a, b) => a - b);
  const quartile = (p: number) => busy[Math.floor(p * (busy.length - 1))] ?? 0;
  const [q1, q2, q3] = [quartile(0.25), quartile(0.5), quartile(0.75)];
  for (const c of cells) {
    const n = c.count ?? 0;
    c.level = n <= 0 ? 0 : n < q1 ? 1 : n < q2 ? 2 : n < q3 ? 3 : 4;
  }
  let busiest: Heatmap['busiest'] = null;
  for (const r of rows) for (const c of r.cells) if ((c.count ?? 0) > (busiest?.count ?? 0)) busiest = { day: r.day, hour: c.hour, count: c.count! };
  const known = cells.filter((c) => c.count !== null);
  return { rows, total: known.reduce((n, c) => n + c.count!, 0), known: known.length, quiet: known.filter((c) => c.count === 0).length, busiest };
}
