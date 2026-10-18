// All custom groups' grants, read from the fleet store and kept 60 s per API instance (tags design §4): group
// membership travels in the token, the grants are read here.
import type { Grant } from './access.js';

const TTL_MS = 60_000;
// When the store cannot be read: the last grants are served for at most this long, and it is not asked again before the
// backoff. Past the limit nobody has a group's grants (fails closed) until a read succeeds.
const STALE_MAX_MS = 10 * 60_000;
const BACKOFF_MS = 10_000;

export function createGroupGrants({ list, now = Date.now, ttlMs = TTL_MS }: {
  list(): Promise<{ name: string; grants: Grant[] }[]>;
  now?: () => number;
  ttlMs?: number;
}) {
  let kept: { byName: Map<string, Grant[]>; at: number } | null = null;
  let reading: Promise<Map<string, Grant[]>> | null = null;
  let failedAt: number | null = null;
  // A write bumps it: a read started before is not kept.
  let generation = 0;

  const stale = () => (kept && now() - kept.at <= STALE_MAX_MS ? kept.byName : new Map<string, Grant[]>());

  function read(): Promise<Map<string, Grant[]>> {
    if (reading) return reading;
    const mine = generation;
    const promise = list().then((groups) => {
      const byName = new Map(groups.map((g) => [g.name, g.grants]));
      if (mine === generation) {
        kept = { byName, at: now() };
        failedAt = null;
      }
      return byName;
    }).catch((err: Error) => {
      console.error(JSON.stringify({ level: 'error', event: 'GroupsUnknown', error: err.message }));
      if (mine === generation) failedAt = now();
      return stale();
    }).finally(() => { if (reading === promise) reading = null; });
    reading = promise;
    return promise;
  }

  return {
    // The grants of each group named, in that order (none for a group that does not exist).
    async of(names: string[]): Promise<Grant[][]> {
      if (names.length === 0) return [];
      const byName = kept && now() - kept.at < ttlMs ? kept.byName : failedAt !== null && now() - failedAt < BACKOFF_MS ? stale() : await read();
      return names.map((name) => byName.get(name) ?? []);
    },
    // After a group is written by this instance: the next request reads them again.
    changed(): void {
      generation++;
      kept = null;
      reading = null;
      failedAt = null;
    },
  };
}
