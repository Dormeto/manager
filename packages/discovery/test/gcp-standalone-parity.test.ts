// The Google Cloud standalone scan against the router's own Google Cloud reads (router gcp/src/onboarding.mjs, idle-signals.mjs):
// on the same Google answers, each listed resource's eligibility and reasons are what the router's preview says (plan 5, M50), and
// each candidate's idle hours what the router's idle signals say hour by hour. Skipped without the router's checkout beside the
// manager. Two differences, by design: the router cannot tell that a VM or a group backs a backend service (it may not list
// them: the scan's reason is left out of the comparison), and the scan cannot read a machine type (a GPU machine type is the
// router's alone to refuse: no such VM here).
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanProject } from '../src/gcp-scan.js';
import type { DiscoveredRule, StandaloneRule } from '../src/types.js';
import { PROJECT, workloadRow } from './gcp-fakes.js';
import { NOW, standaloneProject } from './gcp-standalone-world.js';

const GCP = resolve(import.meta.dirname, '../../../../router/gcp/src');
const present = existsSync(`${GCP}/onboarding.mjs`) && existsSync(`${GCP}/idle-signals.mjs`);
type Router = {
  onboarding: { createOnboarding(deps: Record<string, unknown>): { dryRun(input: { resource: string }): Promise<{ eligible: boolean; reasons: string[] }> } };
  compute: { createCompute(deps: Record<string, unknown>): unknown };
  cloudsql: { createCloudSql(deps: Record<string, unknown>): unknown };
  signals: { createIdleSignals(deps: Record<string, unknown>): (cfg: unknown, backends: unknown[], window: { startMs: number; endMs: number }) => Promise<{ signal: string; applies: boolean; underSince: number | null }[]> };
  activity: { isIdle(signals: unknown[], window: { startMs: number; endMs: number }): boolean };
};
const router = (present ? {
  onboarding: await import(/* @vite-ignore */ `${GCP}/onboarding.mjs`),
  compute: await import(/* @vite-ignore */ `${GCP}/compute.mjs`),
  cloudsql: await import(/* @vite-ignore */ `${GCP}/cloudsql.mjs`),
  signals: await import(/* @vite-ignore */ `${GCP}/idle-signals.mjs`),
  activity: await import(/* @vite-ignore */ `${GCP}/../../lambda/src/lib/activity.mjs`),
} : null) as Router | null;

const ZONE = 'europe-west1-b';
const HOUR = 3_600_000;
const BACKS = /^.* backs backend service [^:]+: it belongs to an HTTP workload$/;
const standaloneOf = (rules: DiscoveredRule[]) => rules.filter((r): r is StandaloneRule => r.kind === 'standalone');

describe.skipIf(!router)('the Google Cloud standalone scan against the router\'s preview', () => {
  it('gives each resource the router\'s eligibility and reasons, but the backend service the router cannot see', async () => {
    const w = standaloneProject();
    const { rules } = await scanProject(w, { project: PROJECT, managed: [workloadRow('dmt-demo-app')], now: NOW, standalone: true });
    // The router's Google client: the same world, its errors carrying Google's HTTP code as the router reads it.
    const google = { request: (method: string, url: string, body?: unknown) => w.call(method, url, body).catch((err: { status?: number }) => { throw Object.assign(err as object, { code: err.status }); }) };
    const onboarding = router!.onboarding.createOnboarding({
      store: { listConfigs: async () => [], getConfig: async () => null }, compute: router!.compute.createCompute({ google, project: PROJECT }),
      cloudsql: router!.cloudsql.createCloudSql({ google, project: PROJECT }), gke: {}, urlmaps: {}, regionalUrlmaps: {}, core: {},
      config: { project: PROJECT, region: 'europe-west2' }, log: { info() {}, warn() {}, error() {} },
    });
    const compared = standaloneOf(rules).filter((c) => c.eligibility !== 'managed');
    expect(compared.length).toBeGreaterThan(15);
    for (const c of compared) {
      const preview = await onboarding.dryRun({ resource: c.id });
      const ours = (c.reason ?? '').split('; ').filter((r) => r && !BACKS.test(r));
      expect([preview.eligible, preview.reasons], c.id).toEqual([ours.length === 0, ours]);
    }
  });
});

describe.skipIf(!router)('the Google Cloud standalone idle share against the router\'s idle signals', () => {
  it('counts the hours the router reads as idle with the built-in signals, for a VM, a group and a Cloud SQL instance', async () => {
    const w = standaloneProject();
    const end = Date.UTC(2026, 10, 9, 11);
    const start = end - 168 * HOUR;
    w.points[`vm:${ZONE}/build-agent`] = (t) => (t === start + 24 * HOUR + 30 * 60_000 ? undefined : new Date(t).getUTCHours() === 9 ? 0.5 : 0.0499);
    w.points[`vm:${ZONE}/workers-a1`] = (t) => (new Date(t).getUTCHours() % 5 === 0 ? 0.07 : 0.01);
    w.points[`vm:${ZONE}/workers-b2`] = (t) => (t === start + 3 * HOUR + 15 * 60_000 ? 0.0501 : 0.0499);
    w.points[`db:${PROJECT}:orders`] = (t) => (new Date(t).getUTCHours() % 7 === 0 ? 1 : 0);
    const found = Object.fromEntries(standaloneOf((await scanProject(w, { project: PROJECT, managed: [], now: NOW, standalone: true })).rules).map((r) => [r.name, r]));
    const google = { request: (method: string, url: string, body?: unknown) => w.call(method, url, body) };
    const read = router!.signals.createIdleSignals({ google, project: PROJECT, log: { warn() {} } });
    // The router's built-ins (settings-levels.mjs builtInsOf on Google Cloud): a VM's and a group's CPU under 5; a Cloud SQL
    // resource's CPU off and its connections under 1.
    const built = { idleMinutes: 60, idleNetworkBytes: 'off' };
    const cases: [string, Record<string, unknown>, unknown[]][] = [
      ['build-agent', { ...built, idleCpuPercent: 5, idleMetric: 'off' }, [{ kind: 'vm', location: ZONE, name: 'build-agent' }]],
      ['workers', { ...built, idleCpuPercent: 5, idleMetric: 'off' }, [{ kind: 'mig', location: ZONE, name: 'workers', instances: ['workers-a1', 'workers-b2'] }]],
      ['orders', { ...built, idleCpuPercent: 'off', idleMetric: { type: 'cloudsql.googleapis.com/database/network/connections', filter: 'resource.type = "cloudsql_database" AND resource.labels.database_id = ends_with(":orders")', aligner: 'ALIGN_MAX', below: 1 } }, [{ kind: 'cloudsql', name: 'orders' }]],
    ];
    for (const [name, cfg, backends] of cases) {
      let idle = 0;
      for (let h = 0; h < 168; h += 1) {
        const window = { startMs: start + h * HOUR, endMs: start + (h + 1) * HOUR };
        if (router!.activity.isIdle(await read({ workloadId: name, ...cfg }, backends, window), window)) idle += 1;
      }
      expect(idle, name).toBeGreaterThan(0);
      expect(found[name]!.idleHours7d, name).toBe(idle);
    }
  });
});
