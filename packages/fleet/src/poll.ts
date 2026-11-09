// The poll of the Google Cloud routers (Google Cloud manager design §6.3, §6.1): a Google Cloud router holds no AWS
// credential and pushes nothing, so the fleet function calls each one every minute, 10 at once for at most 50 s a run, the
// least recently polled first (the others first at the next run). For each, through its /v1/actions: its journal
// (`events`) from 5 minutes before the newest `at` already read, each event ingested as an AWS router's `Workload state
// changed`; when its check is newer than its summary, its rows (`list`) as `Router checked` chunks; when the organization's
// settings it holds are not settings.json's, settings.json pushed (`manager-settings`). The router called is the identity
// (its project and region), never the payload. A router whose controller URL answers Google's own 404 twice in a row is
// uninstalled: unregistered. One too old to poll (below 0.40.0, or one that answered it has no /v1/actions) is kept and not
// polled until its version changes: its version is read from its health (GET /v1/health) at most every 10 minutes and kept
// in the registry, so that the advised `dormeto gcp install` clears too-old within 10 minutes. What a poll did not do, and
// where the journal was read up to, is its RS# item's poll.
import type { Google, GoogleConnection } from '@dormeto/google';
import { accessMissingText, callRouter, RouterCallError, routerHealth, routerTooOld, tooOldText } from '@dormeto/google/router';
import { CHUNK_WORKLOADS_MAX, timely } from './clean.js';
import { eachAtOnce, type RouterEvent } from './ingest.js';
import type { InstalledRouter, Registry } from './registry.js';
import type { FleetStore, RouterPoll } from './store.js';

export const POLL_AT_ONCE = 10;
export const POLL_BUDGET_MS = 50_000;
// An event can commit after a later one (its time is taken before its transaction commits, and the waker and the controller
// are two services): the journal is read again from 5 minutes before the newest `at`, above a Firestore transaction's 270 s.
export const OVERLAP_MS = 5 * 60_000;
const EVENTS_LIMIT = 500;
// Each call's bound: a cold Cloud Run start (design §6.2).
const CALL_MS = 10_000;
// Google's own 404s in a row that unregister a router.
const MISSES_MAX = 2;
// How often a router too old to poll has its version read from its health.
export const VERSION_READ_MS = 10 * 60_000;
// Workloads whose events are ingested at once (each workload's in order).
const WORKLOADS_AT_ONCE = 10;

type Json = Record<string, any>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

// The journal's id before every event of a millisecond: ids are `<ms, 13 digits>-<workloadId>-<state>` and a workload id
// starts with a letter, so `0` sorts first, and the router takes it as an id.
export const eventIdBefore = (ms: number) => `${String(Math.max(0, Math.floor(ms))).padStart(13, '0')}-0-A`;

// Memoized for a run: settings.json is read once, whatever the number of routers.
const once = <T>(work: () => Promise<T>) => {
  let kept: Promise<T> | undefined;
  return () => (kept ??= work());
};

// A refusal the router answered (refusals: true).
class Refused extends Error {}

export interface PollDeps {
  store: Pick<FleetStore, 'routerPolls' | 'putPoll'>;
  ingest: (event: RouterEvent) => Promise<unknown>;
  registry: Pick<Registry, 'list' | 'put' | 'delete'>;
  // The connection's record and its Google instance (one per execution environment), null while there is none.
  google: { current(): Promise<{ connection: GoogleConnection; google: Pick<Google, 'request'> } | null> };
  // The lists bucket's settings.json: its ETag as S3 gives it (quotes included), and its text; null while it doesn't exist.
  settings: { etag(): Promise<string | null>; read(): Promise<{ etag: string; text: string } | null> };
  env: string; // the manager's environment, for the commands the refusals name
  routerVersion?: string; // the router version the manager pins
  now?: () => number;
  log?: { info(event: string, data: object): void; warn(event: string, data: object): void };
}

export function createPoll({ store, ingest, registry, google, settings, env, routerVersion, now = Date.now, log }: PollDeps) {
  type Run = {
    connection: GoogleConnection; google: Pick<Google, 'request'>; deadline: number;
    etag: () => Promise<string | null>; document: () => Promise<{ etag: string; settings: unknown } | null>;
  };
  const keyOf = (r: { account: string; region: string }) => `${r.account}#${r.region}`;

  // What a step could not do, with the command that fixes a refusal, as the API says it.
  const textOf = (err: unknown, router: InstalledRouter, run: Run) => {
    if (err instanceof RouterCallError && err.refusal === 'manager-access-missing') return accessMissingText(run.connection.project, env);
    if (err instanceof RouterCallError && err.refusal === 'router-too-old') return tooOldText('', router.account, router.region, routerVersion);
    return err instanceof Error ? err.message : String(err);
  };

  // A page of the journal: each workload's events in their order, 10 workloads at once, as the router called says them.
  async function ingestEvents(router: InstalledRouter, events: Json[]) {
    const byWorkload = new Map<unknown, Json[]>();
    for (const e of events) byWorkload.set(e.workloadId, [...(byWorkload.get(e.workloadId) ?? []), e]);
    await eachAtOnce([...byWorkload.values()], WORKLOADS_AT_ONCE, async (mine) => {
      for (const { id: _id, ...detail } of mine) {
        await ingest({ account: router.account, region: router.region, 'detail-type': 'Workload state changed', detail: { ...detail, router: router.name || detail.router, region: router.region } });
      }
    });
  }

  // The rows of `list` as an AWS router's check: chunks of at most 1000 rows, each with the list's router block and the
  // check's fields.
  async function ingestRows(router: InstalledRouter, list: Json, check: Json) {
    const rows: unknown[] = Array.isArray(list.workloads) ? list.workloads : [];
    const block = isObject(list.router) ? list.router : {};
    const total = Math.max(1, Math.ceil(rows.length / CHUNK_WORKLOADS_MAX));
    for (let index = 0; index < total; index += 1) {
      await ingest({
        account: router.account, region: router.region, 'detail-type': 'Router checked',
        detail: {
          router: { ...block, name: router.name || block.name, region: router.region, checkSchedule: check.checkSchedule ?? block.checkSchedule },
          checkedAt: check.checkedAt, durationMs: check.durationMs, health: check.health, pauses: check.pauses, counts: check.counts,
          chunk: { index, total }, workloads: rows.slice(index * CHUNK_WORKLOADS_MAX, (index + 1) * CHUNK_WORKLOADS_MAX),
        },
      });
    }
  }

  async function pollRouter(router: InstalledRouter, known: { checkedAt: string | null; poll: RouterPoll | null } | undefined, run: Run) {
    const was = known?.poll ?? null;
    const poll: RouterPoll = { newestAt: was?.newestAt ?? null, misses: was?.misses ?? 0, polledAt: new Date(now()).toISOString(), ...(was?.etag ? { etag: was.etag } : {}) };
    // The router's answer, a refusal thrown. Any answer at the controller URL but Google's own 404 (the controller's, or
    // Google's 403 for a service it has) says the router is there; no answer (none in time, a token refused) says nothing.
    let gone = false;
    const call = async (payload: Json): Promise<Json> => {
      let answer: Json | null;
      try {
        answer = (await callRouter(run.google, router, { ...payload, refusals: true }, { timeoutMs: CALL_MS })) as Json | null;
      } catch (err) {
        if (err instanceof RouterCallError && err.google && err.status === 404) gone = true;
        else if (err instanceof RouterCallError && !err.token && err.status !== 0) poll.misses = 0;
        throw err;
      }
      poll.misses = 0;
      if (answer?.refused) throw new Refused(String(answer.refused.message ?? answer.refused.code ?? 'refused'));
      return answer ?? {};
    };
    let step = 'events';
    try {
      // The journal, page after page while there is more and the run has time.
      let after = poll.newestAt ? eventIdBefore(Date.parse(poll.newestAt) - OVERLAP_MS) : null;
      let page: Json;
      for (;;) {
        page = await call({ action: 'events', after, limit: EVENTS_LIMIT });
        const events: Json[] = Array.isArray(page.events) ? page.events.filter(isObject) : [];
        await ingestEvents(router, events);
        // The newest time read, never one ahead of the clock (its events are refused, and it would skip the ones before).
        const newest = Math.max(...events.map((e) => Date.parse(timely(e.at, now()) ?? '')).filter((t) => !Number.isNaN(t)));
        if (Number.isFinite(newest) && (!poll.newestAt || newest > Date.parse(poll.newestAt))) poll.newestAt = new Date(newest).toISOString();
        if (typeof page.next !== 'string' || !events.length || now() >= run.deadline) break;
        after = page.next;
      }
      const check = isObject(page.check) && timely(page.check.checkedAt, now()) ? page.check : null;
      if (check && (!known?.checkedAt || Date.parse(check.checkedAt) > Date.parse(known.checkedAt)) && now() < run.deadline) {
        step = 'list';
        await ingestRows(router, await call({ action: 'list' }), check);
      }
      const held = typeof page.managerSettings?.etag === 'string' && page.managerSettings.etag ? page.managerSettings.etag as string : null;
      if (held) poll.etag = held;
      else delete poll.etag;
      if (now() < run.deadline) {
        step = 'manager-settings';
        const current = await run.etag();
        const doc = current && current !== held ? await run.document() : null;
        if (doc) {
          await call({ action: 'manager-settings', settings: doc.settings, etag: doc.etag });
          poll.etag = doc.etag;
          log?.info('ManagerSettingsPushed', { router: router.name, account: router.account, region: router.region, etag: doc.etag });
        }
      }
    } catch (err) {
      if (gone) poll.misses += 1;
      if (err instanceof RouterCallError && err.refusal === 'router-too-old') poll.tooOld = router.version;
      poll.lastError = `${step}: ${textOf(err, router, run)}`;
      log?.warn('RouterPollFailed', { router: router.name, account: router.account, region: router.region, step, error: poll.lastError });
    }
    // Only at a poll Google answered with its own 404: a count kept from before never removes a router on its own.
    if (gone && poll.misses >= MISSES_MAX) {
      await registry.delete(router.account, router.region);
      // Registered again later (installed again), it counts from 0.
      poll.misses = 0;
      log?.warn('RouterUnregistered', {
        router: router.name, account: router.account, region: router.region, reason: 'its controller URL answered Google\'s own 404 twice in a row: the router is uninstalled',
      });
    }
    await store.putPoll(router.account, router.region, poll);
  }

  // A router too old to poll: its version from its health, which every router answers, kept in the registry when it changed,
  // so that it is polled at the next run once it is 0.40.0 or later. Its poll otherwise stays as it was.
  async function readVersion(router: InstalledRouter, known: { poll: RouterPoll | null } | undefined, run: Run) {
    const was = known?.poll ?? null;
    const at = new Date(now()).toISOString();
    const poll: RouterPoll = {
      newestAt: was?.newestAt ?? null, misses: was?.misses ?? 0, polledAt: was?.polledAt ?? at, ...(was?.etag ? { etag: was.etag } : {}),
      ...(was?.tooOld !== undefined ? { tooOld: was.tooOld } : {}), versionAt: at,
    };
    try {
      const { version } = await routerHealth(run.google, router, { timeoutMs: CALL_MS });
      if (version !== router.version) {
        await registry.put({ ...router, version });
        log?.info('RouterVersionRead', { router: router.name, account: router.account, region: router.region, from: router.version, version });
      }
      if (routerTooOld(version) || poll.tooOld === version) poll.lastError = `version: ${tooOldText(version, router.account, router.region, routerVersion)}`;
    } catch (err) {
      poll.lastError = `version: ${textOf(err, router, run)}`;
      log?.warn('RouterVersionNotRead', { router: router.name, account: router.account, region: router.region, error: poll.lastError });
    }
    await store.putPoll(router.account, router.region, poll);
  }

  return async function poll(): Promise<{ routers: number; polled: number; left: number }> {
    const started = now();
    const routers = (await registry.list()).filter((r) => r.cloud === 'gcp' && r.controller);
    if (!routers.length) return { routers: 0, polled: 0, left: 0 };
    const current = await google.current();
    if (!current) {
      log?.warn('RoutersNotPolled', { routers: routers.length, reason: 'no Google Cloud connection' });
      return { routers: routers.length, polled: 0, left: routers.length };
    }
    const known = new Map((await store.routerPolls()).map((p) => [keyOf(p), p]));
    const pollOf = (r: InstalledRouter) => known.get(keyOf(r))?.poll ?? null;
    // Too old to poll: a known version below 0.40.0, or the one it had when it answered it has no /v1/actions.
    const tooOld = (r: InstalledRouter) => routerTooOld(r.version) || pollOf(r)?.tooOld === r.version;
    const versionDue = (r: InstalledRouter) => {
      const at = pollOf(r)?.versionAt;
      return !at || now() - Date.parse(at) >= VERSION_READ_MS;
    };
    // The routers to poll, and those too old whose version is to read again; the least recently done first.
    const due = [
      ...routers.filter((r) => !tooOld(r)).map((router) => ({ router, at: pollOf(router)?.polledAt ?? '', work: pollRouter })),
      ...routers.filter((r) => tooOld(r) && versionDue(r)).map((router) => ({ router, at: pollOf(router)?.versionAt ?? '', work: readVersion })),
    ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const run: Run = {
      ...current, deadline: started + POLL_BUDGET_MS,
      etag: once(() => settings.etag()),
      // Pushed as it is when it is not JSON: the router reads it as unset and says it is unreadable, as an AWS router does.
      document: once(async () => {
        const read = await settings.read();
        if (!read) return null;
        try {
          return { etag: read.etag, settings: JSON.parse(read.text) as unknown };
        } catch {
          return { etag: read.etag, settings: read.text };
        }
      }),
    };
    let next = 0;
    let polled = 0;
    await Promise.all(Array.from({ length: Math.min(POLL_AT_ONCE, due.length) }, async () => {
      while (next < due.length && now() < run.deadline) {
        const { router, work } = due[next++]!;
        try {
          await work(router, known.get(keyOf(router)), run);
        } catch (err) {
          log?.warn('RouterPollNotSaved', { router: router.name, account: router.account, region: router.region, error: (err as Error).message });
        }
        polled += 1;
      }
    }));
    log?.info('RoutersPolled', { routers: due.length, polled, left: due.length - polled, ms: now() - started });
    return { routers: due.length, polled, left: due.length - polled };
  };
}
