// The discovery phase's progress (the user, 2026-10-11): in a terminal (status), one line rewritten in place — a bar by
// the regions scanned of each account, the accounts done, the regions, workloads and failures, the time; elsewhere (a
// log, CI), one line per account done.
import type { AccountEvent, ProgressEvent } from './discover.js';

export interface Status {
  update(line: string): void;
  end(line: string): void;
}

const BAR = 20;
const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

interface Account { regions: number; scanned: number; workloads: number; cached: number; failed: number; done: boolean }

export function discoveryView({ accounts, now, log, status }: { accounts: number; now: () => number; log: (line: string) => void; status?: Status }) {
  const started = now();
  const of = new Map<string, Account>();
  const account = (id: string) => {
    if (!of.has(id)) of.set(id, { regions: 0, scanned: 0, workloads: 0, cached: 0, failed: 0, done: false });
    return of.get(id)!;
  };
  const line = () => {
    const all = [...of.values()];
    const sum = (key: 'scanned' | 'workloads' | 'failed') => all.reduce((total, a) => total + a[key], 0);
    const done = all.filter((a) => a.done).length;
    // An account done counts whole, one started by the share of its regions scanned, one not started yet nothing.
    const share = accounts ? Math.min(all.reduce((total, a) => total + (a.done ? 1 : a.regions ? Math.min(a.scanned / a.regions, 1) : 0), 0) / accounts, 1) : 1;
    const filled = Math.round(share * BAR);
    const failed = sum('failed');
    return `  Discovery [${'█'.repeat(filled)}${'░'.repeat(BAR - filled)}] ${String(Math.round(share * 100)).padStart(3)}% · ${done}/${n(accounts, 'account')}`
      + ` · ${n(sum('scanned'), 'region')} · ${n(sum('workloads'), 'workload')}${failed ? ` · ${failed} failed` : ''} · ${clock(now() - started)}`;
  };
  return {
    account(e: AccountEvent) {
      const a = account(e.account);
      a.regions = e.regions;
      if (e.state === 'done') {
        a.done = true;
        if (e.error) a.failed += 1;
        if (!status) {
          const position = `${[...of.values()].filter((x) => x.done).length}/${accounts}`;
          log(e.error && !a.scanned
            ? `  discovery ${e.account} (${position}): failed (${e.error})`
            : `  discovery ${e.account} (${position}): ${n(a.scanned, 'region')}, ${n(a.workloads, 'workload')}${a.cached ? `, ${a.cached} from the cache` : ''}${a.failed ? `, ${a.failed} failed` : ''}`);
        }
      }
      status?.update(line());
    },
    region(p: ProgressEvent) {
      const a = account(p.account);
      a.scanned += 1;
      a.workloads += p.workloads;
      if (p.from === 'cache') a.cached += 1;
      if (p.error) a.failed += 1;
      status?.update(line());
    },
    end() {
      status?.end(line());
    },
  };
}
