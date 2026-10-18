// All custom groups' grants, read from the fleet store and kept 60 s per API instance (tags design §4): group
// membership travels in the token, the grants are read here.
import type { Grant } from './access.js';

const TTL_MS = 60_000;

export function createGroupGrants({ list, now = Date.now, ttlMs = TTL_MS }: {
  list(): Promise<{ name: string; grants: Grant[] }[]>;
  now?: () => number;
  ttlMs?: number;
}) {
  let kept: { byName: Map<string, Grant[]>; at: number } | null = null;
  let reading: Promise<Map<string, Grant[]>> | null = null;

  function read(): Promise<Map<string, Grant[]>> {
    reading ??= list().then((groups) => {
      const byName = new Map(groups.map((g) => [g.name, g.grants]));
      kept = { byName, at: now() };
      return byName;
    }).catch((err: Error) => {
      // The last grants stay; with none, nobody has a group's grants (fails closed).
      console.error(JSON.stringify({ level: 'error', event: 'GroupsUnknown', error: err.message }));
      return kept?.byName ?? new Map<string, Grant[]>();
    }).finally(() => { reading = null; });
    return reading;
  }

  return {
    // The grants of each group named, in that order (none for a group that does not exist).
    async of(names: string[]): Promise<Grant[][]> {
      if (names.length === 0) return [];
      const byName = kept && now() - kept.at < ttlMs ? kept.byName : await read();
      return names.map((name) => byName.get(name) ?? []);
    },
    // After a group is written by this instance: the next request reads them again.
    changed(): void {
      kept = null;
    },
  };
}
