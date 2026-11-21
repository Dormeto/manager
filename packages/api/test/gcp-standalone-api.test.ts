// Google Cloud standalone workloads in the API (plan 5, M51): onboarding a resource the last scan listed as eligible (its router,
// its project's number, the operation's target its path), refused otherwise in plain words (the safety net: the router cannot see
// a backend service); a resource exclusion by its path; a backend service exclusion and the waiting page refused before the router
// is called; the activity read from Cloud Monitoring through the discovery function.
import { describe, expect, it } from 'vitest';
import type { AnyCandidate } from '@dormeto/discovery';
import type { InstalledRouter } from '@dormeto/operations';
import { createApi, type ApiEvent, type AuditEntry } from '../src/api.js';
import type { IdleActivity } from '../src/idle-requests.js';
import { memoryStore } from './memory-store.js';

const NOW = Date.UTC(2026, 10, 21, 12, 7);
const MANAGER = '121014831971';
const PROJECT = 'dormeto-dev';
const NUMBER = '1034397096264';
const ZONE = 'europe-west2-b';
const VM = `projects/${PROJECT}/zones/${ZONE}/instances/build-agent`;
const BUSY_VM = `projects/${PROJECT}/zones/${ZONE}/instances/web-1`;
const registered = (region: string, version = '0.42.0'): InstalledRouter => ({
  name: `dmtr-${region}`, account: PROJECT, region, controller: `https://dmtr-${region}-controller-abc123-nw.a.run.app`, onboarder: '', version, build: '', installedBy: 'cli', cloud: 'gcp',
  installedAt: '2026-11-09T10:00:00.000Z',
});
const standalone = (id: string, over: Partial<AnyCandidate> = {}) => ({
  kind: 'standalone', id, resource: id, cloud: 'gcp', account: PROJECT, region: 'europe-west2', name: id.split('/').at(-1), backend: { kind: 'instance', id: id.split('/').at(-1), location: ZONE, resourceId: '4471' },
  tags: {}, eligibility: 'eligible', idleHours7d: 150, accountName: PROJECT, ouPath: [], scope: 'in', scopeReason: 'in scope', status: 'pending-onboarding', statusReason: 'eligible',
  firstSeenAt: 'x', lastSeenAt: 'x', history: [], ...over,
}) as unknown as AnyCandidate;
const ROW = { account: PROJECT, region: 'europe-west2', router: 'dmtr-europe-west2', workloadId: 'build-agent', name: 'build-agent', kind: 'standalone', resource: VM, state: 'AWAKE', source: 'manager' };
const STATUS = {
  workloadId: 'build-agent', name: 'build-agent', kind: 'standalone', resource: VM, state: 'AWAKE',
  backends: [{ kind: 'instance', id: 'build-agent', status: null, location: ZONE, resourceId: '4471' }],
  settings: { idleMinutes: 120, wakeTimeoutSeconds: 600, idleCpuPercent: 5, idleNetworkBytes: 'off', idleMetric: 'off' },
  settingsFrom: { idleMinutes: 'default', wakeTimeoutSeconds: 'default', idleCpuPercent: 'default', idleNetworkBytes: 'default', idleMetric: 'default' },
};

function setup({ installed = [registered('europe-west2')], read }: { installed?: InstalledRouter[]; read?: IdleActivity } = {}) {
  const audit: AuditEntry[] = [];
  const created: [string, Record<string, unknown>][] = [];
  const calls: [string, Record<string, unknown>][] = [];
  const asked: unknown[] = [];
  const store = memoryStore([standalone(VM) as never, standalone(BUSY_VM, { eligibility: 'ineligible', reason: 'VM web-1 backs backend service web: it belongs to an HTTP workload' }) as never]);
  const api = createApi({
    routers: [{ name: 'dmt-dev', region: 'eu-west-1', controller: 'dmt-dev-controller', account: MANAGER }], managerAccount: MANAGER,
    invoke: async (router, payload) => {
      calls.push([router.name, payload]);
      if (payload.action === 'status') return STATUS;
      return {};
    },
    audit: { write: async (e) => { audit.push(e); }, list: async () => audit },
    now: () => NOW, newId: () => 'id-1', version: '0.25.0', routerVersion: '0.42.0',
    discovery: { store, run: async () => {} },
    google: {
      get: async () => null, put: async () => {}, delete: async () => {}, routers: { list: async () => installed, put: async () => {}, delete: async () => {} },
      call: async <T>() => ({ name: `projects/${NUMBER}`, projectId: PROJECT }) as T,
    },
    operations: {
      create: async (type, input) => { created.push([type, input]); return { id: 'op1', type, target: {}, input, status: 'running', steps: [], cursor: 0, holds: { locks: [], slots: [] }, activeKey: 'k', context: {}, by: 'x', createdAt: 'x', updatedAt: 'x' } as never; },
      list: async () => [], get: async () => null, installedRouters: async () => installed,
    },
    fleet: {
      listRouters: async () => [] as never, listWorkloads: async () => [ROW] as never, getWorkload: async () => ROW as never,
      listHistory: async () => ({ entries: [], truncated: false }), historyBefore: async () => ({ account: PROJECT, region: 'europe-west2', workloadId: 'build-agent', at: new Date(NOW - 8 * 86_400_000).toISOString(), from: 'WAKING', to: 'AWAKE' }) as never,
      getActivity: async () => null, putActivity: async () => {},
    } as never,
    idleActivity: read ?? (async (account, region, queries, days) => {
      asked.push({ account, region, queries, days });
      const to = Date.UTC(2026, 10, 21, 11, 55);
      const from = to - 7 * 86_400_000;
      return {
        from: new Date(from).toISOString(), to: new Date(to).toISOString(),
        points: { 'cpu_0:build-agent': Array.from({ length: 7 * 288 }, (_, p) => [p * 5, p % 288 === 108 ? 0.6 : 0.01] as [number, number]) },
        signals: [{ signal: 'cpu', below: 5, applies: true, series: [{ ids: ['cpu_0:build-agent'], scale: 'percent' }] }, { signal: 'network', below: null, applies: false, reason: 'off', series: [] }, { signal: 'metric', below: null, applies: false, reason: 'off', series: [] }],
      };
    }),
  });
  return { api, audit, created, calls, asked };
}
const event = (method: string, path: string, groups: string, body?: unknown): ApiEvent => ({
  rawPath: path, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  requestContext: { http: { method }, authorizer: { jwt: { claims: { sub: 'u-1', email: 'ops@example.com', 'cognito:groups': `[${groups}]` } } } },
});
const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');
const onboard = (body: Record<string, unknown>) => event('POST', '/api/operations', 'dmt-operator', { type: 'onboard', ...body });

describe('onboarding a Google Cloud standalone resource', () => {
  it('goes to the router of its region with the project\'s number, its idle signals kept, the waker\'s refused', async () => {
    const s = setup();
    const res = await s.api(onboard({ candidateId: VM, name: 'Agent', settings: { idleCpuPercent: 3 }, databases: [{ kind: 'cloudsql-instance', id: 'side' }] }));
    expect(res.statusCode).toBe(202);
    expect(s.created).toEqual([['onboard', { candidateId: VM, router: `dmtr-${PROJECT}-europe-west2`, region: 'europe-west2', projectNumber: NUMBER, name: 'Agent', settings: { idleCpuPercent: 3 }, databases: [{ kind: 'cloudsql-instance', id: 'side' }] }]]);
    const waker = await s.api(onboard({ candidateId: VM, settings: { waitSeconds: 60 } }));
    expect([waker.statusCode, json(waker).message]).toEqual([400, 'settings: waitSeconds: a standalone workload has no waker: waitSeconds is for an HTTP workload']);
  });

  it('takes the project\'s only router when none is in its region, and asks which when several are', async () => {
    expect(setup({ installed: [registered('us-central1')] }).api).toBeDefined();
    const one = setup({ installed: [registered('us-central1')] });
    expect((await one.api(onboard({ candidateId: VM }))).statusCode).toBe(202);
    expect(one.created[0]![1]).toMatchObject({ router: `dmtr-${PROJECT}-us-central1`, region: 'us-central1' });
    const two = setup({ installed: [registered('us-central1'), registered('asia-east1')] });
    const res = await two.api(onboard({ candidateId: VM }));
    expect([res.statusCode, json(res).message]).toEqual([400, `project ${PROJECT} has 2 routers and none in europe-west2: name the one to onboard on in router (dmtr-${PROJECT}-us-central1, dmtr-${PROJECT}-asia-east1)`]);
  });

  it('refuses what the last scan found ineligible, or did not list, saying what to do; never calls the router', async () => {
    const s = setup();
    const ineligible = await s.api(onboard({ candidateId: BUSY_VM }));
    expect([ineligible.statusCode, json(ineligible).message]).toEqual([409, `cannot onboard ${BUSY_VM}: VM web-1 backs backend service web: it belongs to an HTTP workload`]);
    const other = `projects/${PROJECT}/zones/${ZONE}/instanceGroupManagers/workers`;
    const unlisted = await s.api(onboard({ candidateId: other }));
    expect([unlisted.statusCode, json(unlisted).message]).toEqual([400, `${other} is not a standalone candidate of the last discovery run: turn on Standalone resources in the discovery perimeter, run discovery, then onboard it from its candidate (the scan checks what the router cannot: that no backend service uses it)`]);
    expect([s.created, s.calls]).toEqual([[], []]);
  });
});

describe('a Google Cloud standalone workload\'s exclusions and page', () => {
  it('excludes its resource by its path, and refuses a backend service exclusion naming it and its waiting page before calling the router', async () => {
    const s = setup();
    const res = await s.api(event('POST', '/api/exclusions', 'dmt-operator', { target: { kind: 'resource', path: VM }, reason: 'a test' }));
    expect(res.statusCode).toBe(202);
    const bad = await s.api(event('POST', '/api/exclusions', 'dmt-operator', { target: { kind: 'resource', path: 'projects/p/global/backendServices/x' }, reason: 'r' }));
    expect(bad.statusCode).toBe(400);
    const service = await s.api(event('POST', '/api/exclusions', 'dmt-operator', {
      target: { kind: 'target-group', path: `projects/${PROJECT}/global/backendServices/web` }, reason: 'r', workload: { router: `dmtr-${PROJECT}-europe-west2`, id: 'build-agent' },
    }));
    expect([service.statusCode, json(service).message]).toEqual([409, 'workload build-agent is a standalone workload: it has no backend service to exclude']);
    const page = await s.api(event('GET', `/api/workloads/dmtr-${PROJECT}-europe-west2/build-agent/waiting-page`, 'dmt-admin'));
    expect([page.statusCode, json(page).message]).toEqual([409, 'workload build-agent is a standalone workload: it has no waiting page']);
    expect(s.calls.filter(([, p]) => p.action === 'waiting-page')).toEqual([]);
  });
});

describe('a Google Cloud standalone workload\'s activity', () => {
  it('asks the discovery function for its backends and settings, and replays the signals it planned', async () => {
    const s = setup();
    const res = await s.api(event('GET', `/api/workloads/dmtr-${PROJECT}-europe-west2/build-agent/activity`, 'dmt-viewer'));
    expect(res.statusCode).toBe(200);
    expect(s.asked).toEqual([{ account: PROJECT, region: 'europe-west2', days: 7, queries: { cloud: 'gcp', backends: [{ kind: 'instance', id: 'build-agent', location: ZONE }], settings: STATUS.settings } }]);
    const a = json(res);
    expect(a.signals.map((x: { signal: string; applies: boolean }) => [x.signal, x.applies])).toEqual([['cpu', true], ['network', false], ['metric', false]]);
    // The ratio as a percentage: 0.6 is 60 %, over the threshold.
    expect(a.signals[0].values[108]).toBeCloseTo(60, 9);
    expect(a.advice.windows.find((w: { minutes: number }) => w.minutes === 120).wakesPerDay).toBeCloseTo(1, 0);
  });
});
