// The discovery phase's progress (the user, 2026-10-11): in a terminal (status), one line rewritten in place — a bar by
// the regions scanned of each account, the accounts done, the regions, workloads and failures, the time — redrawn every
// second, the last accounts still read named with how long they take; elsewhere (a log, CI), one line per account done,
// and every minute the accounts still read.
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

interface Account { regions: number; scanned: number; workloads: number; cached: number; failed: number; done: boolean; startedAt?: number }
// Every ms, fn; returns what stops it (a timer that never keeps the process alive).
type Every = (ms: number, fn: () => void) => () => void;
const interval: Every = (ms, fn) => {
  const timer = setInterval(fn, ms);
  timer.unref?.();
  return () => clearInterval(timer);
};
// The accounts (regions) still read are named once this few remain.
const NAMED = 3;
const bar = (share: number) => {
  const filled = Math.round(share * BAR);
  return `[${'█'.repeat(filled)}${'░'.repeat(BAR - filled)}] ${String(Math.round(share * 100)).padStart(3)}%`;
};

export function discoveryView({ accounts, now, log, status, every = interval }: { accounts: number; now: () => number; log: (line: string) => void; status?: Status; every?: Every }) {
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
    const failed = sum('failed');
    const waiting = accounts - done <= NAMED ? reading() : [];
    return `  Discovery ${bar(share)} · ${done}/${n(accounts, 'account')}`
      + ` · ${n(sum('scanned'), 'region')} · ${n(sum('workloads'), 'workload')}${failed ? ` · ${failed} failed` : ''} · ${clock(now() - started)}`
      + (waiting.length ? ` · waiting for ${waiting.join(', ')}` : '');
  };
  // The accounts started and not done, with how long each has taken.
  const reading = () => [...of].filter(([, a]) => !a.done && a.startedAt !== undefined).map(([id, a]) => `${id} (${clock(now() - a.startedAt!)})`);
  const stop = status
    ? every(1000, () => status.update(line()))
    : every(60_000, () => {
      const still = reading();
      if (still.length) log(`  discovery: still reading ${n(still.length, 'account')}: ${still.slice(0, 5).join(', ')}${still.length > 5 ? ` and ${still.length - 5} more` : ''}`);
    });
  return {
    account(e: AccountEvent) {
      const a = account(e.account);
      a.regions = e.regions;
      if (e.state === 'started') a.startedAt = now();
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
      stop();
      status?.end(line());
    },
  };
}

// Phase 2's CloudWatch reads by region (the requests, then the uptime): in a terminal, one line redrawn every second —
// the regions read of those to read, the workloads, failures and time, the last regions still read named; elsewhere, a
// line per region read and every minute the regions still read.
export function regionsView({ label, now, log, status, every = interval }: { label: 'Requests' | 'Uptime'; now: () => number; log: (line: string) => void; status?: Status; every?: Every }) {
  const started = now();
  const phase = label.toLowerCase();
  const reading = new Map<string, number>();
  let total = 0;
  let done = 0;
  let workloads = 0;
  let failed = 0;
  const waiting = () => [...reading].map(([where, at]) => `${where} (${clock(now() - at)})`);
  const line = () => {
    const named = total - done <= NAMED ? waiting() : [];
    return `  ${label} ${bar(total ? done / total : 1)} · ${done}/${n(total, 'region')} · ${n(workloads, 'workload')}${failed ? ` · ${failed} failed` : ''} · ${clock(now() - started)}`
      + (named.length ? ` · waiting for ${named.join(', ')}` : '');
  };
  const stop = status
    ? every(1000, () => { if (total) status.update(line()); })
    : every(60_000, () => {
      const still = waiting();
      if (still.length) log(`  ${phase}: still reading ${n(still.length, 'region')}: ${still.slice(0, 5).join(', ')}${still.length > 5 ? ` and ${still.length - 5} more` : ''}`);
    });
  return {
    // How many regions are to be read.
    plan(count: number) {
      total = count;
      if (total) status?.update(line());
    },
    start(account: string, region: string) {
      reading.set(`${account} ${region}`, now());
      status?.update(line());
    },
    done(p: ProgressEvent) {
      reading.delete(`${p.account} ${p.region}`);
      done += 1;
      workloads += p.workloads;
      if (p.error) failed += 1;
      if (!status) log(`  ${p.phase} ${p.account} ${p.region}: ${p.error ? `failed (${p.error})` : n(p.workloads, 'workload')}${p.from === 'cache' ? ' (cache)' : ''}`);
      status?.update(line());
    },
    end() {
      stop();
      if (total) status?.end(line());
    },
  };
}
