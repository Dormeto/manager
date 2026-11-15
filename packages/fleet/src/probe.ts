// The watchdog's probe of the Google Cloud routers (router push design 2026-11-14 §6.3, §6.4). The routers report to the
// manager's API after each state change and check (§4); the manager calls only one that is silent (no check within 3 periods
// of its schedule, the watchdog's `reporting` rule) or never reported, at each watchdog run (the watchdog invokes the fleet
// function with `{task: 'probe'}`: the fleet function holds the command account's federation, the watchdog doesn't). Each
// router probed: its health (GET /v1/health, which every router answers), its version kept in the registry when it changed;
// at 0.41.0 or later, `manager-settings` with where to report (`events` alone: the router answers the ETag it holds), then
// settings.json when it holds another; below 0.41.0 it can't report: too old, with the command that upgrades it. A router
// whose controller URL answers Google's own 404 twice running is uninstalled: unregistered. A refusal (the manager's access,
// a controller not found yet) is recorded with its command for the watchdog. 10 routers at once, each call within 10 s, none
// started after 40 s, the least recently probed first. What a probe did not do is its RS# item's probe.
import type { Google, GoogleConnection } from '@dormeto/google';
import { accessMissingText, callRouter, controllerUnknownText, RouterCallError, routerHealth } from '@dormeto/google/router';
import { GOOGLE_REPORT_MINIMUM, reportsTooOld, tooOldText } from './clouds.js';
import type { ReportTarget } from './google-report.js';
import type { InstalledRouter, Registry } from './registry.js';
import { GOOGLE_CALL_MS } from './router-call.js';
import { settingsDocument } from './settings-json.js';
import { reporting, type FleetStore, type RouterProbe } from './store.js';

export const PROBE_AT_ONCE = 10;
// No router is started after 40 s: one started then ends by 70 s (its health and two pushes, 10 s each), within the
// watchdog's bound on the invocation (90 s) and both functions' timeout (120 s).
export const PROBE_BUDGET_MS = 40_000;
// Google's own 404s in a row that unregister a router.
const MISSES_MAX = 2;

type Json = Record<string, any>;

// Memoized for a run: settings.json is read once, whatever the number of routers.
const once = <T>(work: () => Promise<T>) => {
  let kept: Promise<T> | undefined;
  return () => (kept ??= work());
};

// A refusal the router answered (refusals: true).
class Refused extends Error {}

export interface ProbeDeps {
  store: Pick<FleetStore, 'routerProbes' | 'putProbe'>;
  registry: Pick<Registry, 'list' | 'update' | 'deleteIf'>;
  // The connection's record and its Google instance (one per execution environment), null while there is none.
  google: { current(): Promise<{ connection: GoogleConnection; google: Pick<Google, 'request'> } | null> };
  // The lists bucket's settings.json: its ETag as S3 gives it (quotes included), and its text; null while it doesn't exist.
  settings: { etag(): Promise<string | null>; read(): Promise<{ etag: string; text: string } | null> };
  env: string; // the manager's environment, for the commands the refusals name
  routerVersion?: string | undefined; // the router version the manager pins
  events?: ReportTarget | undefined; // where a router reports (the credentials route and its token's audience)
  now?: () => number;
  log?: { info(event: string, data: object): void; warn(event: string, data: object): void };
}

export function createProbe({ store, registry, google, settings, env, routerVersion, events, now = Date.now, log }: ProbeDeps) {
  type Run = {
    connection: GoogleConnection; google: Pick<Google, 'request'>; deadline: number;
    etag: () => Promise<string | null>; document: () => Promise<{ etag: string; settings: unknown } | null>;
  };
  type Known = { checkedAt: string | null; checkSchedule: string | null; probe: RouterProbe | null };
  const keyOf = (r: { account: string; region: string }) => `${r.account}#${r.region}`;
  const named = (router: InstalledRouter) => ({ router: router.name, account: router.account, region: router.region });

  // What a step could not do, with the command that fixes a refusal, as the API says it.
  const textOf = (err: unknown, run: Run) => {
    if (err instanceof RouterCallError && err.refusal === 'no_access') return accessMissingText(run.connection.project, env, err.said);
    return err instanceof Error ? err.message : String(err);
  };

  async function probeRouter(router: InstalledRouter, known: Known | undefined, run: Run) {
    const was = known?.probe ?? null;
    const at = new Date(now()).toISOString();
    const probe: RouterProbe = { probedAt: at, misses: was?.misses ?? 0, ...(was?.askedAt && was.tooOld === undefined ? { askedAt: was.askedAt } : {}) };
    // Any answer at the controller URL but Google's own 404 (the controller's, or Google's 403 for a service it has) says the
    // router is there; no answer (none in time, a token refused) says nothing.
    let gone = false;
    const counted = async <T>(call: () => Promise<T>): Promise<T> => {
      try {
        const answer = await call();
        probe.misses = 0;
        return answer;
      } catch (err) {
        if (err instanceof RouterCallError && err.google && err.status === 404) gone = true;
        else if (err instanceof RouterCallError && !err.token && err.status !== 0) probe.misses = 0;
        throw err;
      }
    };
    const act = async (payload: Json): Promise<Json> => {
      const answer = await counted(() => callRouter(run.google, router, { ...payload, refusals: true }, { timeoutMs: GOOGLE_CALL_MS })) as Json | null;
      if (answer?.refused) throw new Refused(String(answer.refused.message ?? answer.refused.code ?? 'refused'));
      return answer ?? {};
    };
    let step = 'health';
    try {
      const { version } = await counted(() => routerHealth(run.google, router, { timeoutMs: GOOGLE_CALL_MS }));
      if (version !== router.version) {
        if (await registry.update({ ...router, version })) log?.info('RouterVersionRead', { ...named(router), from: router.version, version });
        else log?.info('RouterVersionNotKept', { ...named(router), version, reason: 'its registration is gone' });
      }
      if (reportsTooOld(version)) {
        probe.tooOld = version;
        delete probe.askedAt;
        probe.lastRefusal = 'router_too_old';
        probe.lastError = `health: ${tooOldText(version, router.account, router.region, routerVersion, GOOGLE_REPORT_MINIMUM)}`;
      } else {
        step = 'manager-settings';
        // Where to report alone answers the ETag the router holds; without the routers' reports, it is unknown.
        const held = events ? (await act({ action: 'manager-settings', events })).etag : undefined;
        if (events) {
          // A router that could not report before (it never reported, or was too old) has the watchdog's grace from now.
          if (!probe.askedAt && (!known?.checkedAt || was?.tooOld !== undefined)) probe.askedAt = at;
          log?.info('ReportsAsked', { ...named(router), version });
        }
        const current = await run.etag();
        const doc = current && current !== held ? await run.document() : null;
        if (doc) {
          await act({ action: 'manager-settings', settings: doc.settings, etag: doc.etag, ...(events ? { events } : {}) });
          log?.info('ManagerSettingsPushed', { ...named(router), etag: doc.etag });
        }
      }
    } catch (err) {
      if (gone) probe.misses += 1;
      if (err instanceof RouterCallError && err.refusal) probe.lastRefusal = err.refusal;
      probe.lastError = `${step}: ${textOf(err, run)}`;
      log?.warn('RouterProbeFailed', { ...named(router), step, error: probe.lastError });
    }
    // Only at a probe Google answered with its own 404: a count kept from before never removes a router on its own.
    if (gone && probe.misses >= MISSES_MAX) {
      // Only the registration this probe read: a controller connect rewrote since is another router's.
      const removed = await registry.deleteIf(router.account, router.region, router);
      // Registered again later (installed again), it counts from 0.
      probe.misses = 0;
      if (removed) log?.warn('RouterUnregistered', { ...named(router), reason: 'its controller URL answered Google\'s own 404 twice running: the router is uninstalled' });
      else log?.info('RouterKept', { ...named(router), reason: 'its registration changed since the probe read it' });
    }
    await store.putProbe(router.account, router.region, probe);
  }

  return async function probe(): Promise<{ routers: number; probed: number; left: number }> {
    const started = now();
    const registered = (await registry.list()).filter((r) => r.cloud === 'gcp');
    if (!registered.length) return { routers: 0, probed: 0, left: 0 };
    const known = new Map((await store.routerProbes()).map((p) => [keyOf(p), p]));
    // A router that reports is never called; one silent or that never reported is.
    const silent = registered.filter((r) => !reporting({ checkedAt: known.get(keyOf(r))?.checkedAt ?? null, checkSchedule: known.get(keyOf(r))?.checkSchedule ?? null }, now()));
    const routers = silent.filter((r) => r.controller);
    const current = await google.current();
    if (!current) {
      if (routers.length) log?.warn('RoutersNotProbed', { routers: routers.length, reason: 'no Google Cloud connection' });
      return { routers: routers.length, probed: 0, left: routers.length };
    }
    const probeOf = (r: InstalledRouter) => known.get(keyOf(r))?.probe ?? null;
    // A router whose controller discovery hasn't found yet can't be called: its probe says so, once.
    for (const router of silent.filter((r) => !r.controller && probeOf(r)?.lastRefusal !== 'router_unknown')) {
      await store.putProbe(router.account, router.region, {
        probedAt: probeOf(router)?.probedAt ?? new Date(now()).toISOString(), misses: probeOf(router)?.misses ?? 0,
        lastRefusal: 'router_unknown', lastError: `controller: ${controllerUnknownText(current.connection.project, env)}`,
      });
    }
    // The least recently probed first: the routers a run left go first at the next.
    const due = routers.map((router) => ({ router, at: probeOf(router)?.probedAt ?? '' })).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const run: Run = {
      ...current, deadline: started + PROBE_BUDGET_MS,
      etag: once(() => settings.etag()),
      document: once(() => settingsDocument(settings)),
    };
    let next = 0;
    let probed = 0;
    await Promise.all(Array.from({ length: Math.min(PROBE_AT_ONCE, due.length) }, async () => {
      while (next < due.length && now() < run.deadline) {
        const { router } = due[next++]!;
        try {
          await probeRouter(router, known.get(keyOf(router)), run);
        } catch (err) {
          log?.warn('RouterProbeNotSaved', { ...named(router), error: (err as Error).message });
        }
        probed += 1;
      }
    }));
    log?.info('RoutersProbed', { routers: due.length, probed, left: due.length - probed, ms: now() - started });
    return { routers: due.length, probed, left: due.length - probed };
  };
}
