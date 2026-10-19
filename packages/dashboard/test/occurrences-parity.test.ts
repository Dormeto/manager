// The port held to the router (R12): occurrencesIn against lambda/src/lib/schedule.mjs's occurrenceAt, for seeded
// random valid schedules (overnight and 24-hour windows, exceptions) in zones with clock changes (Lord Howe's half
// hour) and a quarter-hour offset (Kathmandu), at random instants near the changes and at every occurrence's and every
// router event's boundary, and the starts and ends against its nextEvents. Reads the router's checkout beside the
// manager's (as scripts/parity/product.mjs does), skipped when it is absent. A failure names the seed (PARITY_SEED
// overrides it), the schedule and the instant. In Node's environment: jsdom's goes through Vite's client transform,
// which serves no file outside the manager's workspace.
// @vitest-environment node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { occurrencesIn, type Occurrence } from '../src/occurrences';
import { DAYS, type Day, type Schedule, type ScheduleWindow } from '../src/schedule';

const ROUTER_SCHEDULE = '../../../../router/lambda/src/lib/schedule.mjs';
const file = resolve(import.meta.dirname, ROUTER_SCHEDULE);

interface RouterOccurrence { kind: 'awake' | 'nap'; window: number; id: string; start: number; end: number; wake?: string }
interface RouterSchedule {
  occurrenceAt(s: Schedule, t: number): RouterOccurrence | null;
  nextEvents(s: Schedule, t: number, options: { count: number; horizonDays: number }): { at: string; kind: string; window: number }[];
  scheduleProblems(s: unknown): string[];
  normalizeSchedule(s: Schedule): Schedule;
}

const router = (existsSync(file) ? await import(/* @vite-ignore */ file) : null) as RouterSchedule | null;

const SEED = Number(process.env.PARITY_SEED ?? 20261020);
const SCHEDULES = 500;
const ZONES = ['Europe/Paris', 'America/New_York', 'Australia/Lord_Howe', 'Asia/Kathmandu'];
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const FROM = Date.parse('2026-01-01T00:00:00Z');
const TO = Date.parse('2029-01-01T00:00:00Z');

// mulberry32: a small seeded generator, so a failure reproduces.
function generator(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// The zone's offset at t, read with Intl on its own (not the module's), and its changes from FROM to TO, to the minute.
function offset(zone: string, t: number): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(t).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(t / 1000) * 1000;
}

function changes(zone: string): number[] {
  const found: number[] = [];
  for (let t = FROM; t < TO; t += 6 * HOUR) {
    if (offset(zone, t) === offset(zone, t + 6 * HOUR)) continue;
    let [lo, hi] = [t, t + 6 * HOUR];
    while (hi - lo > MINUTE) {
      const mid = lo + Math.floor((hi - lo) / 2 / MINUTE) * MINUTE;
      if (offset(zone, mid) === offset(zone, lo)) lo = mid;
      else hi = mid;
    }
    found.push(hi);
  }
  return found;
}

const hhmm = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const iso = (t: number): string => new Date(t).toISOString();

// A valid schedule of 1 to 5 windows (a window that the router refuses with the others, an overlap, is left out), its
// times half the time around the hours clocks change, a quarter of its windows 24 hours long, and up to 3 exception
// dates around the anchor.
function randomSchedule(random: () => number, r: RouterSchedule, zone: string, anchor: number): Schedule {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const time = () => hhmm(random() < 0.5 ? 60 + Math.floor(random() * 31) * 5 : Math.floor(random() * 288) * 5);
  const windows: ScheduleWindow[] = [];
  const count = 1 + Math.floor(random() * 5);
  for (let tries = 0; tries < count * 4 && windows.length < count; tries++) {
    const kind = random() < 0.5 ? 'awake' : 'nap';
    const days: Day[] = DAYS.filter(() => random() < 0.4);
    if (!days.length) days.push(pick(DAYS));
    const start = time();
    const end = random() < 0.25 ? start : time();
    const wake = kind === 'nap' && random() < 0.7 ? { wake: pick(['never', 'header'] as const) } : {};
    const w: ScheduleWindow = { kind, days, start, end, ...wake };
    if (!r.scheduleProblems({ timeZone: zone, windows: [...windows, w] }).length) windows.push(w);
  }
  const exceptions = Array.from({ length: Math.floor(random() * 4) }, () => iso(anchor + Math.floor(random() * 9 - 4) * DAY).slice(0, 10));
  return r.normalizeSchedule({ timeZone: zone, windows, ...(exceptions.length ? { exceptions } : {}) });
}

if (!router) {
  describe('occurrences parity with the router', () => {
    it.skip(`skipped: the router checkout is absent (${file}); clone Dormeto/router beside the manager to run it`, () => {});
  });
} else {
  const r = router;
  describe('occurrences parity with the router', () => {
    it(`${SCHEDULES} random schedules agree with occurrenceAt at instants near clock changes and at every boundary, and with nextEvents (seed ${SEED})`, () => {
      const random = generator(SEED);
      const zoneChanges = new Map(ZONES.map((zone) => [zone, changes(zone)]));
      const mismatches: string[] = [];
      const counts = { schedules: 0, overnight: 0, allDay: 0, exceptions: 0, occurrences: 0, edges: 0, instants: 0, inside: 0, nearChange: 0, ranges: 0 };
      for (let n = 0; n < SCHEDULES; n++) {
        const zone = ZONES[n % ZONES.length]!;
        const near = zoneChanges.get(zone)!;
        const anchor = near.length && random() < 0.85 ? near[Math.floor(random() * near.length)]! : FROM + Math.floor(random() * (TO - FROM - 8 * DAY)) + 4 * DAY;
        const s = randomSchedule(random, r, zone, anchor);
        const problems = r.scheduleProblems(s);
        if (problems.length) throw new Error(`seed ${SEED}, schedule ${n}: generated invalid ${JSON.stringify(s)}: ${problems.join('; ')}`);
        counts.schedules += 1;
        counts.overnight += s.windows!.filter((w) => w.end < w.start).length;
        counts.allDay += s.windows!.filter((w) => w.end === w.start).length;
        counts.exceptions += s.exceptions?.length ?? 0;

        const [from, to] = [anchor - 3 * DAY, anchor + 3 * DAY];
        // Every occurrence that holds an instant of [from, to) overlaps this wider range.
        const ours = occurrencesIn(s, anchor - 4 * DAY, anchor + 4 * DAY);
        counts.occurrences += ours.length;
        const context = (t: number) => `seed ${SEED}, schedule ${n} ${JSON.stringify(s)} at ${iso(t)}`;

        // The edges in (from, to]: the router's next events, and ours as it counts them (each start; an end that no
        // occurrence of its kind holds). They also show an occurrence no instant is inside.
        const events = r.nextEvents(s, from, { count: 10_000, horizonDays: 6 });
        const theirEdges = [...new Set(events.map((e) => `${e.at} ${e.kind}`))].sort();
        const held = (kind: string, t: number) => ours.some((o) => o.kind === kind && o.start <= t && t < o.end);
        const within = (t: number) => t > from && t <= to;
        const ourEdges = [...new Set(ours.flatMap((o) => [
          ...(within(o.start) ? [`${iso(o.start)} ${o.kind}-start`] : []),
          ...(within(o.end) && !held(o.kind, o.end) ? [`${iso(o.end)} ${o.kind}-end`] : []),
        ]))].sort();
        counts.edges += ourEdges.length;
        if (JSON.stringify(ourEdges) !== JSON.stringify(theirEdges)) mismatches.push(`seed ${SEED}, schedule ${n} ${JSON.stringify(s)} edges from ${iso(from)}: ours ${JSON.stringify(ourEdges)}, the router's ${JSON.stringify(theirEdges)}`);

        const instants = new Set<number>();
        for (let i = 0; i < 12; i++) instants.add(anchor + Math.round((random() * 6 - 3) * 60) * MINUTE);
        for (let i = 0; i < 8; i++) instants.add(from + Math.floor(random() * (to - from)));
        for (const o of ours) for (const t of [o.start - 1, o.start, o.end - 1, o.end]) instants.add(t);
        for (const e of events) for (const t of [Date.parse(e.at) - 1, Date.parse(e.at)]) instants.add(t);

        for (const t of instants) {
          if (t < from || t >= to) continue;
          counts.instants += 1;
          if (near.some((c) => Math.abs(c - t) <= HOUR)) counts.nearChange += 1;
          const active: Occurrence[] = ours.filter((o) => o.start <= t && t < o.end);
          const theirs = r.occurrenceAt(s, t);
          if (active.length) counts.inside += 1;
          if (active.length && !theirs) mismatches.push(`${context(t)}: ours ${JSON.stringify(active)}, the router's none`);
          else if (!active.length && theirs) mismatches.push(`${context(t)}: ours none, the router's ${JSON.stringify(theirs)}`);
          else if (theirs) {
            if (active.some((o) => o.kind !== theirs.kind)) mismatches.push(`${context(t)}: kinds differ, ours ${JSON.stringify(active)}, the router's ${JSON.stringify(theirs)}`);
            const latest = Math.max(...active.map((o) => o.start));
            if (latest !== theirs.start || !active.some((o) => o.start === theirs.start && o.window === theirs.window)) {
              mismatches.push(`${context(t)}: the router's occurrence ${JSON.stringify(theirs)} is not our latest of ${JSON.stringify(active)}`);
            }
          }
        }

        // A range inside the wider one: exactly its occurrences that overlap the range.
        const a = from + Math.floor(random() * (to - from));
        const b = Math.min(a + Math.floor(random() * 2 * DAY), anchor + 4 * DAY);
        const inRange = occurrencesIn(s, a, b);
        const expected = ours.filter((o) => o.start < b && o.end > a);
        counts.ranges += 1;
        if (JSON.stringify(inRange) !== JSON.stringify(expected)) mismatches.push(`seed ${SEED}, schedule ${n} ${JSON.stringify(s)} in [${iso(a)}, ${iso(b)}): ${JSON.stringify(inRange)} instead of ${JSON.stringify(expected)}`);
      }
      console.info(`occurrences parity (seed ${SEED}): ${JSON.stringify(counts)}`);
      expect(mismatches.slice(0, 5), `${mismatches.length} mismatches, the first 5 shown`).toEqual([]);
      // Not vacuous: overnight and 24-hour windows, exceptions, instants inside occurrences and within an hour of a
      // change.
      expect(counts.schedules).toBe(SCHEDULES);
      for (const key of ['overnight', 'allDay', 'exceptions', 'edges', 'inside', 'nearChange'] as const) expect(counts[key], key).toBeGreaterThan(100);
    }, 120_000);
  });
}
