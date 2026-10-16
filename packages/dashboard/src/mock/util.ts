// Demo data helpers (npm run dev:mock, development only): times, deterministic random numbers and stable ids, so that
// the demo looks the same on every load of a given day.
export const SECOND = 1000;
export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export const iso = (ms: number): string => new Date(ms).toISOString();
export const day = (ms: number): string => iso(ms).slice(0, 10);
export const round = (value: number, digits = 2): number => Math.round(value * 10 ** digits) / 10 ** digits;

// A 32-bit FNV-1a hash of a text: the seed of its random numbers and ids.
export function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Random numbers from a seed (mulberry32).
export function random(seed: string) {
  let a = hash(seed);
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    between: (min: number, max: number) => min + next() * (max - min),
    int: (min: number, max: number) => Math.floor(min + next() * (max - min + 1)),
    chance: (p: number) => next() < p,
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
  };
}
export type Random = ReturnType<typeof random>;

// Hexadecimal digits derived from a text: workload ids, instance ids, ARN suffixes.
export function hex(text: string, length: number): string {
  let out = '';
  for (let i = 0; out.length < length; i += 1) out += hash(`${text}#${i}`).toString(16).padStart(8, '0');
  return out.slice(0, length);
}

export function uuid(text: string): string {
  const h = hex(text, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// The last idle check of a router (every 5 minutes, a few seconds past): always recent.
export const lastCheck = (now: number): number => Math.floor((now - 7 * SECOND) / (5 * MINUTE)) * 5 * MINUTE + 7 * SECOND;
