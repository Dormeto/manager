// The estimate's cache (vision docs/specs/2026-10-10-savings-estimate-design.md §7): each phase's result per account
// and region, and the prices, under ~/.cache/dormeto/estimate/<organization or account>/. A file is written to a
// temporary name then renamed (an interrupted run never leaves a broken one); one that cannot be parsed is missing.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const DAY_MS = 86_400_000;

export interface PriceCache {
  getPrice(key: string): Promise<{ usd: number | null } | null>;
  putPrice(key: string, usd: number | null, days?: number): Promise<void>;
}
export interface Cache {
  get<T>(path: string, fresh: (writtenAt: number) => boolean): Promise<T | null>;
  put(path: string, value: unknown): Promise<void>;
  prices: PriceCache;
}

export const cacheDir = (env: Record<string, string | undefined> = process.env): string =>
  env.XDG_CACHE_HOME ? join(env.XDG_CACHE_HOME, 'dormeto', 'estimate') : join(homedir(), '.cache', 'dormeto', 'estimate');

// Discovery is fresh a day; requests while their 14 days end on the run's UTC day.
export const freshDiscovery = (now: number) => (writtenAt: number) => now - writtenAt < DAY_MS;
export const freshRequests = (now: number) => (writtenAt: number) => new Date(writtenAt).toISOString().slice(0, 10) === new Date(now).toISOString().slice(0, 10);

let sequence = 0;
async function writeAtomically(file: string, text: string) {
  await mkdir(dirname(file), { recursive: true });
  sequence += 1;
  const temporary = `${file}.${process.pid}.${sequence}.tmp`;
  await writeFile(temporary, text);
  await rename(temporary, file);
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function createCache({ dir, now = Date.now }: { dir: string; now?: () => number }): Cache {
  // The prices, read once, written whole after each change, one write at a time.
  let prices: Promise<Map<string, { usd: number | null; until: number }>> | undefined;
  let writing = Promise.resolve();
  const loadPrices = () => (prices ??= readJson<Record<string, { usd: number | null; until: number }>>(join(dir, 'prices.json')).then((p) => new Map(Object.entries(p ?? {}))));
  return {
    async get<T>(path: string, fresh: (writtenAt: number) => boolean) {
      const file = await readJson<{ writtenAt?: number; value?: T }>(join(dir, path));
      if (!file || typeof file.writtenAt !== 'number' || !('value' in file) || !fresh(file.writtenAt)) return null;
      return file.value as T;
    },
    async put(path: string, value: unknown) {
      await writeAtomically(join(dir, path), JSON.stringify({ writtenAt: now(), value }));
    },
    prices: {
      async getPrice(key) {
        const entry = (await loadPrices()).get(key);
        return entry && entry.until > now() ? { usd: entry.usd } : null;
      },
      async putPrice(key, usd, days = 30) {
        const all = await loadPrices();
        all.set(key, { usd, until: now() + (usd === null ? 1 : days) * DAY_MS });
        writing = writing.then(() => writeAtomically(join(dir, 'prices.json'), JSON.stringify(Object.fromEntries(all))));
        await writing;
      },
    },
  };
}
