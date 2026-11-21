// The idle signals at every level (vision standalone workloads design §4, §6; the router's handover, "Settings"): checked in
// the router's words, a workload's by its kind; the organization's held back while a router that does not know them is in
// the fleet (an AWS router before 0.42.0 or any Google Cloud router), never pushed to a Google Cloud router; a standalone
// workload's row, page and routes without what it has not.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { InstalledRouter } from '@dormeto/operations';
import { createApi, type ApiEvent, type AuditEntry, type Invoke } from '../src/api.js';
import { defaultsProblems, reachOf, typesProblems } from '../src/settings-levels.js';

const NOW = Date.UTC(2026, 11, 1, 12, 0);
const MANAGER = '121014831971';
const ROUTERS = [{ name: 'dmt-dev', region: 'eu-west-1', controller: 'dmt-dev-controller', account: MANAGER }];
const GCP_INSTALLED: InstalledRouter = {
  name: 'dmtr-europe-west2', account: 'dormeto-dev', region: 'europe-west2', controller: 'https://dmtr-europe-west2-controller-abc-nw.a.run.app', onboarder: '',
  version: '0.42.0', build: '', installedBy: 'cli', cloud: 'gcp', installedAt: new Date(NOW).toISOString(),
};
const ARN = `arn:aws:ec2:eu-west-1:${MANAGER}:instance/i-0abc`;
const STANDALONE = { account: MANAGER, region: 'eu-west-1', router: 'dmt-dev', workloadId: 'sa', kind: 'standalone', resourceArn: ARN, name: 'build-agent', state: 'AWAKE' };
const HTTP = { account: MANAGER, region: 'eu-west-1', router: 'dmt-dev', workloadId: 'web', name: 'web', state: 'AWAKE', targetGroupArn: `arn:aws:elasticloadbalancing:eu-west-1:${MANAGER}:targetgroup/web/0123456789abcdef`, url: 'https://web.example.com' };
const METRIC = { namespace: 'Custom/Jobs', name: 'Queue', dimensions: { Instance: '${resource}' }, statistic: 'Maximum', below: 1 };

function setup(opts: { version?: string | null; google?: boolean; gcpVersion?: string; doc?: Record<string, unknown> | null; invoke?: Invoke } = {}) {
  const audit: AuditEntry[] = [];
  const calls: [string, Record<string, unknown>][] = [];
  const store = { doc: opts.doc ?? null, writes: [] as Record<string, unknown>[] };
  const version = opts.version === undefined ? '0.42.0' : opts.version;
  const api = createApi({
    routers: ROUTERS, now: () => NOW, newId: () => 'id-1', version: '0.25.0', managerAccount: MANAGER,
    audit: { write: async (e) => { audit.push(e); }, list: async () => audit },
    async invoke(router, payload, options) {
      calls.push([router.name, payload]);
      if (opts.invoke) return opts.invoke(router, payload, options);
      if (payload.action === 'settings') return { level: payload.workloadId ? 'workload' : 'router', settings: payload.settings };
      if (payload.action === 'status') return payload.workloadId === 'sa' ? { workloadId: 'sa', kind: 'standalone', resourceArn: ARN, state: 'AWAKE', idle: [] } : { workloadId: 'web', state: 'AWAKE', route: 'app' };
      return {};
    },
    globalSettings: { read: async () => store.doc, write: async (d: Record<string, unknown>) => { store.writes.push(d); store.doc = d; return '"etag"'; } },
    fleet: {
      listRouters: async () => (version ? [{ account: MANAGER, region: 'eu-west-1', router: 'dmt-dev', version, checkedAt: new Date(NOW).toISOString() }] : []) as never,
      listWorkloads: async () => [STANDALONE, HTTP] as never,
      getWorkload: async (_a: string, _r: string, id: string) => ([STANDALONE, HTTP].find((w) => w.workloadId === id) ?? null) as never,
    },
    ...(opts.google ? { operations: { installedRouters: async () => [{ ...GCP_INSTALLED, version: opts.gcpVersion ?? GCP_INSTALLED.version }], create: async () => { throw new Error('no operation'); }, list: async () => [], get: async () => null } } : {}),
  });
  return { api, audit, calls, store };
}
const event = (method: string, path: string, groups: string, body?: unknown): ApiEvent => ({
  rawPath: path, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  requestContext: { http: { method }, authorizer: { jwt: { claims: { email: `${groups}@example.com`, sub: 'u-1', 'cognito:groups': `[${groups}]` } } } },
});
const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');

describe('the idle signals\' checks', () => {
  it('take them at the organization\'s, a type\'s and an AWS router\'s level, each in the router\'s words', () => {
    expect(defaultsProblems({ idleCpuPercent: 5, idleNetworkBytes: 'off', idleMetric: METRIC, idleMinutes: 120 }, { idle: true })).toEqual([]);
    expect(defaultsProblems({ idleCpuPercent: 101, idleNetworkBytes: 1.5, idleMetric: { ...METRIC, statistic: 'Median', extra: 1 } }, { idle: true })).toEqual([
      'idleCpuPercent: must be a number from 0 to 100, or off',
      'idleNetworkBytes: must be a whole number from 0 to 10000000000, or off',
      'idleMetric: unknown field extra', 'idleMetric: statistic must be Maximum, Average or Sum',
    ]);
    // Without them (a router before), they are unknown settings; a Google Cloud router's level takes them in its metric's shape (plan 5).
    expect(defaultsProblems({ idleCpuPercent: 5 }, { cloud: 'gcp' })).toEqual(['unknown setting idleCpuPercent']);
    expect(defaultsProblems({ idleCpuPercent: 5, idleMetric: { type: 'custom.googleapis.com/q', aligner: 'ALIGN_MAX', below: 1 } }, { cloud: 'gcp', idle: true })).toEqual([]);
    expect(defaultsProblems({ idleMetric: METRIC }, { cloud: 'gcp', idle: true })).toEqual(['idleMetric: unknown field namespace', 'idleMetric: unknown field name', 'idleMetric: unknown field dimensions', 'idleMetric: unknown field statistic', 'idleMetric: type must be a Cloud Monitoring metric type of at most 512 characters, such as custom.googleapis.com/queue/depth', 'idleMetric: aligner must be ALIGN_MAX, ALIGN_MEAN or ALIGN_SUM']);
    expect(typesProblems([{ name: 'ecs', settings: { idleCpuPercent: 'off' } }], { idle: true })).toEqual([]);
  });

  it('refuse at a workload the other kind\'s keys, whatever their value', () => {
    expect(defaultsProblems({ waitSeconds: 60, idleCpuPercent: 3 }, { workload: true, kind: 'standalone' })).toEqual(['waitSeconds: a standalone workload has no waker: waitSeconds is for an HTTP workload']);
    expect(defaultsProblems({ idleCpuPercent: 'x', waitSeconds: 60 }, { workload: true, kind: 'http' })).toEqual(['idleCpuPercent: an HTTP workload naps on its requests: the idle signals are for a standalone workload']);
  });

  it('count what a level reaches of the idle signals too, where a standalone workload holds them', () => {
    expect(reachOf([{ kind: 'standalone', settingsFrom: { idleCpuPercent: 'organization', idleMinutes: 'default' } }], 'organization').keys).toMatchObject({ idleCpuPercent: 1, idleNetworkBytes: 0, idleMetric: 0, idleMinutes: 1 });
    expect(reachOf([{ settingsFrom: { idleMinutes: 'default' } }], 'organization').keys).not.toHaveProperty('idleCpuPercent');
  });
});

// The router's checks on the same cases (lambda/src/lib/settings-levels.mjs). Skipped without the router's checkout.
const LEVELS = resolve(import.meta.dirname, '../../../../router/lambda/src/lib/settings-levels.mjs');
const router = (existsSync(LEVELS) ? await import(/* @vite-ignore */ LEVELS) : null) as {
  defaultsProblems(d: unknown, o?: Record<string, unknown>): string[]; typesProblems(t: unknown, o?: Record<string, unknown>): string[];
} | null;
describe.skipIf(!router)('the idle signals\' checks against the router\'s', () => {
  const docs: Record<string, unknown>[] = [
    { idleCpuPercent: 0 }, { idleCpuPercent: 100 }, { idleCpuPercent: 2.5 }, { idleCpuPercent: -1 }, { idleCpuPercent: '5' }, { idleCpuPercent: 'off' }, { idleCpuPercent: null },
    { idleNetworkBytes: 0 }, { idleNetworkBytes: 10_000_000_000 }, { idleNetworkBytes: 10_000_000_001 }, { idleNetworkBytes: 1.5 }, { idleNetworkBytes: 'off' },
    { idleMetric: 'off' }, { idleMetric: 'on' }, { idleMetric: METRIC }, { idleMetric: { ...METRIC, other: 1 } }, { idleMetric: { ...METRIC, namespace: '' } },
    { idleMetric: { ...METRIC, name: 'x'.repeat(256) } }, { idleMetric: { ...METRIC, dimensions: [] } }, { idleMetric: { ...METRIC, dimensions: { a: '${other}' } } },
    { idleMetric: { ...METRIC, dimensions: Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`d${i}`, 'v'])) } }, { idleMetric: { ...METRIC, statistic: 'p99' } },
    { idleMetric: { ...METRIC, below: '1' } }, { idleMetric: { ...METRIC, below: Infinity } }, { idleMetric: {} },
    { waitSeconds: 60 }, { wakeMode: 'any' }, { noWakeRules: [] }, { idleMinutes: 120 }, { wakeTimeoutSeconds: 30 }, { idleCpuPercent: 5, waitSeconds: 4 },
  ];
  it('gives the router\'s verdict for each level', () => {
    for (const doc of docs) {
      expect(defaultsProblems(doc, { idle: true }), JSON.stringify(doc)).toEqual(router!.defaultsProblems(doc, { idle: true }));
      for (const kind of ['standalone', 'http'] as const) expect(defaultsProblems(doc, { workload: true, kind }), `${kind} ${JSON.stringify(doc)}`).toEqual(router!.defaultsProblems(doc, { workload: true, kind }));
      if (Object.keys(doc).every((k) => k.startsWith('idle') && k !== 'idleMinutes')) expect(defaultsProblems(doc, { cloud: 'gcp' })).toEqual(router!.defaultsProblems(doc));
      const types = [{ name: 'ecs', settings: doc }];
      expect(typesProblems(types, { idle: true })).toEqual(router!.typesProblems(types, { idle: true }));
    }
  });
});

describe.skipIf(!router)('Google Cloud\'s idle signals\' checks against the router\'s (plan 5)', () => {
  const GCP = { type: 'custom.googleapis.com/queue/depth', filter: 'resource.labels.instance_id = "${resource}"', aligner: 'ALIGN_MAX', below: 1 };
  const docs: Record<string, unknown>[] = [
    { idleMetric: GCP }, { idleMetric: { ...GCP, filter: undefined } }, { idleMetric: { ...GCP, other: 1 } }, { idleMetric: { ...GCP, type: 'no slash' } }, { idleMetric: { ...GCP, type: 'x'.repeat(513) } },
    { idleMetric: { ...GCP, filter: '' } }, { idleMetric: { ...GCP, filter: 'a = "${other}"' } }, { idleMetric: { ...GCP, aligner: 'ALIGN_P99' } }, { idleMetric: { ...GCP, below: '1' } },
    { idleMetric: METRIC }, { idleMetric: 'off' }, { idleMetric: 'on' }, { idleCpuPercent: 3, idleNetworkBytes: 'off' },
  ];
  it('gives the router\'s verdict for a Google Cloud level and workload, and either shape at the organization\'s', () => {
    for (const doc of docs) {
      const clean = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
      expect(defaultsProblems(clean, { cloud: 'gcp', idle: true }), JSON.stringify(doc)).toEqual(router!.defaultsProblems(clean, { idle: true, cloud: 'gcp' }));
      for (const kind of ['standalone', 'http'] as const) expect(defaultsProblems(clean, { workload: true, kind, cloud: 'gcp' }), `${kind} ${JSON.stringify(doc)}`).toEqual(router!.defaultsProblems(clean, { workload: true, kind, cloud: 'gcp' }));
      // The organization's: each shape as its cloud's router checks it.
      const shape = (clean.idleMetric as { type?: unknown } | undefined)?.type !== undefined ? 'gcp' : 'aws';
      expect(defaultsProblems(clean, { idle: true, metric: 'any' }), `any ${JSON.stringify(doc)}`).toEqual(router!.defaultsProblems(clean, { idle: true, cloud: shape }));
    }
  });
});

describe('the organization\'s idle signals', () => {
  it('are written once every router knows them, the idle window not held back', async () => {
    const s = setup();
    const res = await s.api(event('PUT', '/api/settings/workloads', 'dmt-admin', { defaults: { idleCpuPercent: 3 } }));
    expect([res.statusCode, json(res).defaults]).toEqual([200, { idleCpuPercent: 3 }]);
    const types = await s.api(event('PUT', '/api/settings/types', 'dmt-admin', { types: [{ name: 'ecs', settings: { idleMetric: METRIC } }] }));
    expect([types.statusCode, json(types).types]).toEqual([200, [{ name: 'ecs', settings: { idleMetric: METRIC } }]]);
    expect(json(await s.api(event('GET', '/api/settings/workloads', 'dmt-viewer'))).defaults).toEqual({ idleCpuPercent: 3 });
  });

  it('are refused while an AWS router before 0.42.0, or one whose version is not known, is in the fleet, naming it; the idle window is not', async () => {
    for (const [version, named] of [['0.41.0', 'dmt-dev (0.41.0)'], [null, 'dmt-dev (version not known)']] as const) {
      const s = setup({ version });
      for (const [path, body] of [['/api/settings/workloads', { defaults: { idleNetworkBytes: 1000 } }], ['/api/settings/types', { types: [{ name: 'api', tags: { kind: 'api' }, settings: { idleCpuPercent: 'off' } }] }]] as const) {
        const res = await s.api(event('PUT', path, 'dmt-admin', body));
        expect([res.statusCode, json(res).message], path).toEqual([409, `the organization's idle signals need every router at 0.42.0 or later: 1 router must be upgraded first: ${named}`]);
      }
      expect(s.store.writes).toEqual([]);
      expect((await s.api(event('PUT', '/api/settings/workloads', 'dmt-admin', { defaults: { idleMinutes: 30 } }))).statusCode).toBe(200);
    }
  });

  it('are refused while a Google Cloud router before its first version that knows them is in the fleet, never for being Google Cloud; removing one is never', async () => {
    const s = setup({ google: true, gcpVersion: '0.41.0', doc: { workloads: { defaults: { idleCpuPercent: 3 } } } });
    const res = await s.api(event('PUT', '/api/settings/workloads', 'dmt-admin', { defaults: { idleCpuPercent: 4 } }));
    expect([res.statusCode, json(res).message]).toEqual([409, 'the organization\'s idle signals need every router at 0.42.0 or later: 1 router must be upgraded first: dmtr-dormeto-dev-europe-west2 (0.41.0)']);
    expect((await s.api(event('PUT', '/api/settings/workloads', 'dmt-admin', { defaults: { idleCpuPercent: null } }))).statusCode).toBe(200);
    const known = setup({ google: true, gcpVersion: '0.42.0', doc: { workloads: { defaults: { idleCpuPercent: 3 } } } });
    expect((await known.api(event('PUT', '/api/settings/workloads', 'dmt-admin', { defaults: { idleCpuPercent: 4 } }))).statusCode).toBe(200);
  });

  it('take either cloud\'s metric at the organization\'s, and say which cloud each applies to', async () => {
    const GCP = { type: 'custom.googleapis.com/queue/depth', filter: 'resource.labels.instance_id = "${resource}"', aligner: 'ALIGN_MAX', below: 1 };
    const s = setup();
    const res = await s.api(event('PUT', '/api/settings/workloads', 'dmt-admin', { defaults: { idleMetric: GCP } }));
    expect([res.statusCode, json(res).defaults, json(res).idleMetricCloud]).toEqual([200, { idleMetric: GCP }, 'gcp']);
    const types = await s.api(event('PUT', '/api/settings/types', 'dmt-admin', { types: [{ name: 'ecs', settings: { idleMetric: METRIC } }, { name: 'databases', settings: { idleMetric: GCP } }, { name: 'api', tags: { k: 'v' } }] }));
    expect([types.statusCode, json(types).idleMetricClouds]).toEqual([200, { ecs: 'aws', databases: 'gcp' }]);
    const bad = await s.api(event('PUT', '/api/settings/workloads', 'dmt-admin', { defaults: { idleMetric: { ...GCP, aligner: 'ALIGN_P99' } } }));
    expect([bad.statusCode, json(bad).message]).toEqual([400, 'idleMetric: aligner must be ALIGN_MAX, ALIGN_MEAN or ALIGN_SUM']);
  });

  it('kept as they are by another write of the file (the waiting page), which is not held back', async () => {
    const s = setup({ version: '0.41.0', doc: { workloads: { defaults: { idleCpuPercent: 3 } } } });
    const res = await s.api(event('PUT', '/api/settings/waiting-page', 'dmt-admin', { page: { mode: 'template' } }));
    expect(res.statusCode).toBe(200);
    expect(s.store.doc).toMatchObject({ workloads: { defaults: { idleCpuPercent: 3 } } });
  });

  it('have one writer of settings.json, the gated one', () => {
    const source = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');
    expect(source.match(/globalSettings\.write\(/g)).toHaveLength(1);
    expect(source).toMatch(/async function writeSettings\([^)]*\)[^{]*\{\n\s+await idleGate\(/);
  });

  it('are pushed to a Google Cloud router whose version knows them, never to one before', async () => {
    const DOC = { workloads: { hibernate: false, defaults: { idleCpuPercent: 3, idleMinutes: 30 }, types: [{ name: 'ecs', settings: { idleMetric: METRIC, idleMinutes: 60 } }] } };
    const old = setup({ google: true, gcpVersion: '0.41.0', version: null, doc: DOC });
    await old.api(event('PUT', '/api/settings/workloads', 'dmt-admin', { hibernate: true }));
    const stripped = old.calls.find(([, p]) => p.action === 'manager-settings')![1];
    expect((stripped.settings as { workloads: unknown }).workloads).toEqual({ hibernate: true, defaults: { idleMinutes: 30 }, types: [{ name: 'ecs', settings: { idleMinutes: 60 } }] });
    // The file keeps them for the routers that know them.
    expect(old.store.doc).toMatchObject({ workloads: { defaults: { idleCpuPercent: 3 } } });
    const known = setup({ google: true, gcpVersion: '0.42.0', doc: DOC });
    await known.api(event('PUT', '/api/settings/workloads', 'dmt-admin', { hibernate: true }));
    const pushed = known.calls.find(([, p]) => p.action === 'manager-settings')![1];
    expect((pushed.settings as { workloads: unknown }).workloads).toEqual({ ...DOC.workloads, hibernate: true });
  });
});

describe('a router\'s and a workload\'s idle signals', () => {
  it('go to a router of either cloud, which says whether it knows them; a Google Cloud router\'s in its metric\'s shape', async () => {
    const s = setup();
    expect((await s.api(event('PUT', '/api/routers/dmt-dev/settings', 'dmt-admin', { defaults: { idleCpuPercent: 3 } }))).statusCode).toBe(200);
    const old = setup({ invoke: async () => ({ problems: ['settings: defaults: unknown setting idleCpuPercent'] }) });
    const res = await old.api(event('PUT', '/api/routers/dmt-dev/settings', 'dmt-admin', { defaults: { idleCpuPercent: 3 } }));
    expect([res.statusCode, json(res).message]).toEqual([409, 'upgrade the router to 0.42.0']);
    const g = setup({ google: true });
    const gcp = await g.api(event('PUT', '/api/routers/dmtr-dormeto-dev-europe-west2/settings', 'dmt-admin', { defaults: { idleCpuPercent: 3 } }));
    expect(gcp.statusCode).toBe(200);
    const shape = await g.api(event('PUT', '/api/routers/dmtr-dormeto-dev-europe-west2/settings', 'dmt-admin', { defaults: { idleMetric: METRIC } }));
    expect([shape.statusCode, json(shape).message.split('; ')[0]]).toEqual([400, 'idleMetric: unknown field namespace']);
  });

  it('are a standalone workload\'s, never an HTTP one\'s; the waker\'s keys an HTTP one\'s only', async () => {
    const s = setup();
    expect((await s.api(event('PUT', '/api/workloads/dmt-dev/sa/settings', 'dmt-operator', { idleCpuPercent: 3, idleMinutes: 60 }))).statusCode).toBe(200);
    expect(s.calls.at(-1)![1]).toMatchObject({ action: 'settings', workloadId: 'sa', settings: { idleCpuPercent: 3, idleMinutes: 60 } });
    const waker = await s.api(event('PUT', '/api/workloads/dmt-dev/sa/settings', 'dmt-operator', { waitSeconds: 60 }));
    expect([waker.statusCode, json(waker).message]).toEqual([400, 'waitSeconds: a standalone workload has no waker: waitSeconds is for an HTTP workload']);
    const http = await s.api(event('PUT', '/api/workloads/dmt-dev/web/settings', 'dmt-operator', { idleCpuPercent: 3 }));
    expect([http.statusCode, json(http).message]).toEqual([400, 'idleCpuPercent: an HTTP workload naps on its requests: the idle signals are for a standalone workload']);
  });
});

describe('a standalone workload\'s routes', () => {
  it('answers its page without a URL, and its candidate\'s idle share by its resource', async () => {
    const s = setup();
    const page = json(await s.api(event('GET', '/api/workloads/dmt-dev/sa', 'dmt-viewer')));
    expect(page).toMatchObject({ workloadId: 'sa', kind: 'standalone', resourceArn: ARN });
    expect(page).not.toHaveProperty('url');
    expect(json(await s.api(event('GET', '/api/workloads/dmt-dev/web', 'dmt-viewer'))).url).toBe('https://web.example.com');
  });

  it('refuses its waiting page and a target group exclusion naming it before calling its router, in the router\'s words', async () => {
    const s = setup();
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const res = await s.api(event(method, '/api/workloads/dmt-dev/sa/waiting-page', 'dmt-admin', method === 'PUT' ? { page: { mode: 'template' } } : undefined));
      expect([res.statusCode, json(res).message], method).toEqual([409, 'workload sa is a standalone workload: it has no waiting page']);
    }
    expect(s.calls.filter(([, p]) => p.action === 'waiting-page')).toEqual([]);
  });

  it('relays the router\'s refusal of a nap window\'s wake', async () => {
    const problem = 'windows[0].wake: a standalone workload has no waiting page: nothing arrives to wake it in a nap window';
    const s = setup({ invoke: async (_r, p) => (p.action === 'schedule' ? { problems: [problem] } : {}) });
    const res = await s.api(event('PUT', '/api/workloads/dmt-dev/sa/schedule', 'dmt-operator', { timeZone: 'UTC', windows: [{ kind: 'nap', wake: 'header' }] }));
    expect([res.statusCode, json(res).message]).toEqual([400, problem]);
  });
});

describe('an HTTP candidate\'s onboarding', () => {
  it('refuses an idle signal in the router\'s words', async () => {
    const TG = `arn:aws:elasticloadbalancing:eu-west-1:${MANAGER}:targetgroup/web/0123456789abcdef`;
    const { memoryStore, candidate } = await import('./memory-store.js');
    const api = createApi({
      routers: ROUTERS, now: () => NOW, newId: () => 'id-1', version: '0.25.0', managerAccount: MANAGER,
      audit: { write: async () => {}, list: async () => [] }, async invoke() { return null; },
      discovery: { store: memoryStore([candidate(TG, { targetGroupArn: TG, account: MANAGER, region: 'eu-west-1' })]), run: async () => {} },
      operations: { create: async () => { throw new Error('not started'); }, list: async () => [], get: async () => null, installedRouters: async () => [] } as never,
    });
    const res = await api(event('POST', '/api/operations', 'dmt-operator', { type: 'onboard', candidateId: TG, settings: { idleCpuPercent: 3 } }));
    expect([res.statusCode, json(res).message]).toEqual([400, 'settings: idleCpuPercent: an HTTP workload naps on its requests: the idle signals are for a standalone workload']);
  });
});

describe('a standalone workload with its candidate', () => {
  async function withDiscovery() {
    const { memoryStore } = await import('./memory-store.js');
    const c = {
      kind: 'standalone', id: ARN, account: MANAGER, region: 'eu-west-1', resourceArn: ARN, name: 'build-agent', backend: { kind: 'instance', id: 'i-0abc', arn: ARN },
      tags: {}, eligibility: 'managed', workloadId: 'sa', idleHours7d: 100, accountName: 'dev', ouPath: [], scope: 'in', scopeReason: 'in', status: 'managed', statusReason: 'managed',
      firstSeenAt: 'x', lastSeenAt: 'x', history: [],
    };
    const store = memoryStore([c as never]);
    store.config = { config: { version: 1, mode: 'organization', regions: ['eu-west-1'], refreshHours: 24, globalExcludes: [], filters: [] }, updatedAt: '', updatedBy: '' };
    const calls: Record<string, unknown>[] = [];
    const api = createApi({
      routers: ROUTERS, now: () => NOW, newId: () => 'id-1', version: '0.25.0', managerAccount: MANAGER,
      audit: { write: async () => {}, list: async () => [] },
      async invoke(_r, payload) { calls.push(payload); return payload.action === 'status' ? { workloadId: 'sa', kind: 'standalone', resourceArn: ARN, state: 'AWAKE' } : {}; },
      fleet: { listRouters: async () => [], listWorkloads: async () => [STANDALONE] as never, getWorkload: async () => STANDALONE as never },
      discovery: { store, run: async () => {} },
      operations: { create: async () => { throw new Error('not started'); }, list: async () => [], get: async () => null, installedRouters: async () => [] } as never,
    });
    return { api, calls };
  }

  it('has its idle share from its candidate, found by its resource', async () => {
    const { api } = await withDiscovery();
    const page = json(await api(event('GET', '/api/workloads/dmt-dev/sa', 'dmt-viewer')));
    expect(page.idleHours7d).toBe(100);
    expect(page).not.toHaveProperty('requests7d');
  });

  it('refuses a target group exclusion naming it before anything changes', async () => {
    const { api, calls } = await withDiscovery();
    const TG = `arn:aws:elasticloadbalancing:eu-west-1:${MANAGER}:targetgroup/web/0123456789abcdef`;
    const res = await api(event('POST', '/api/exclusions', 'dmt-operator', { target: { kind: 'target-group', arn: TG }, reason: 'r', workload: { router: 'dmt-dev', id: 'sa' } }));
    expect([res.statusCode, json(res).message]).toEqual([409, 'workload sa is a standalone workload: it has no target group to exclude']);
    expect(calls).toEqual([]);
  });
});
