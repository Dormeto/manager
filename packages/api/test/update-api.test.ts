import { describe, expect, it, vi } from 'vitest';
import type { Operation } from '@dormeto/operations';
import type { UpdateCheck, UpdateResult } from '@dormeto/fleet';
import { createApi, type ApiEvent, type AuditEntry } from '../src/api.js';
import { absent, missingStream, createUpdate, fetchText, FETCH_MS, type Build, type Pending, type UpdatePort } from '../src/update.js';

const RELEASES = 'https://releases.test/manager';
const START = Date.parse('2026-10-20T10:00:00Z');
const ID = 'dmt-prod-install';
const ACCOUNT = '121014831971';
const REGION = 'eu-west-1';
const ETAG = 'abcdef0123456789abcdef0123456789';
const PLAN_JSON = JSON.stringify({ format_version: '1.2', resource_changes: [{ address: 'aws_x.a', change: { actions: ['create'] } }, { address: 'aws_x.b', change: { actions: ['update'] } }] });

const build = (n: number, status: string, env: Record<string, string> = {}, extra: Partial<Build> = {}): Build => ({
  id: `${ID}:00000000-0000-0000-0000-${String(n).padStart(12, '0')}`, status, phase: status === 'IN_PROGRESS' ? 'BUILD' : 'COMPLETED',
  startedAt: new Date(START - (100 - n) * 60_000).toISOString(), endedAt: status === 'IN_PROGRESS' ? null : new Date(START - (100 - n) * 60_000 + 30_000).toISOString(),
  env, logStream: `stream-${n}`, arn: `arn:aws:codebuild:${REGION}:${ACCOUNT}:build/${ID}:00000000-0000-0000-0000-${String(n).padStart(12, '0')}`, ...extra,
});
// The CodeBuild console page of build n.
const consoleOf = (n: number) => `https://${REGION}.console.aws.amazon.com/codesuite/codebuild/${ACCOUNT}/projects/${ID}/build/${ID}%3A00000000-0000-0000-0000-${String(n).padStart(12, '0')}/?region=${REGION}`;

function setup(opts: { running?: string; files?: Record<string, string>; urls?: Record<string, string>; builds?: Build[]; logs?: Record<string, string[]>; pending?: Pending | null; operations?: Operation[] } = {}) {
  const files = new Map<string, string>(Object.entries({
    'prod/cli.json': JSON.stringify({ version: '0.2.0' }),
    'prod/release/SHA256SUMS': '',
    ...opts.files,
  }));
  const urls = new Map<string, string>(Object.entries({
    [`${RELEASES}/versions.json`]: JSON.stringify({ versions: [
      { version: '0.12.0', router: '0.29.0', minCli: '0.2.0', published: '2026-10-20T10:00:00Z' },
      { version: '0.11.0', router: '0.29.0', minCli: '0.2.0', published: '2026-10-17T10:00:00Z' },
      { version: '0.10.0', router: '0.28.0', minCli: null, published: '2026-10-10T10:00:00Z' },
    ] }),
    [`${RELEASES}/0.12.0/CHANGELOG.md`]: '## 0.12.0 — 2026-10-20\n\nSelf-update.\n\nRouter 0.29.0. Access: apply again.\n\n## 0.11.0 — 2026-10-17\n\nOlder.\n',
    [`${RELEASES}/0.11.0/CHANGELOG.md`]: '## 0.11.0 — 2026-10-17\n\nEleven.\n\nRouter 0.29.0. Access: nothing to apply again.\n',
    ...opts.urls,
  }));
  const state = {
    builds: opts.builds ?? [], pending: opts.pending ?? null, puts: [] as Array<[string, string]>, now: START,
    // What the service read: the bucket's keys, the builds and logs listed, the pending item.
    gets: [] as string[], calls: { builds: 0, logLines: 0, pending: 0 },
    // Operations the workflow was asked to start.
    workflow: [] as string[],
    // CodeBuild refuses to list the builds.
    throttled: false,
    // S3 refuses the request; the records refuse the next n updates; the records written after the creation.
    putFails: false, updateFails: 0, updates: 0,
    // What the operations index lists, when it lags behind the records.
    listed: null as Operation[] | null,
  };
  // The operation records (the records module's items), by id.
  const ops = new Map<string, Operation>((opts.operations ?? []).map((op) => [op.id, op]));
  let opIds = 0;
  const port: UpdatePort = {
    get: async (key) => { state.gets.push(key); return files.get(key) ?? null; },
    put: async (key, body) => {
      if (state.putFails) throw Object.assign(new Error('Service Unavailable'), { name: 'ServiceUnavailable' });
      files.set(key, body);
      state.puts.push([key, body]);
      return ETAG;
    },
    builds: async () => {
      state.calls.builds++;
      if (state.throttled) throw Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
      return state.builds;
    },
    logLines: async (_group, stream) => { state.calls.logLines++; return opts.logs?.[stream] ?? []; },
    fetchText: async (url) => urls.get(url) ?? null,
    pending: { get: async () => { state.calls.pending++; return state.pending; }, put: async (p) => { state.pending = p; } },
    operations: {
      create: async (op) => { ops.set(op.id, structuredClone(op)); },
      get: async (id) => structuredClone(ops.get(id) ?? null),
      update: async (op) => {
        if (state.updateFails > 0) {
          state.updateFails--;
          throw Object.assign(new Error('Throughput exceeds the current capacity'), { name: 'ProvisionedThroughputExceededException' });
        }
        state.updates++;
        ops.set(op.id, structuredClone(op));
      },
    },
  };
  const update = createUpdate(port, {
    env: 'prod', logGroup: '/aws/codebuild/dmt-prod-install', version: opts.running ?? '0.10.0', releasesUrl: RELEASES, now: () => new Date(state.now), random: () => 'a1b2c3d4',
    account: ACCOUNT, region: REGION, newId: () => `op-${++opIds}`,
  });
  const audit: AuditEntry[] = [];
  const api = createApi({
    routers: [], invoke: async () => ({}), audit: { write: async (e) => { audit.push(e); }, list: async () => audit },
    now: () => state.now, newId: () => 'id', version: opts.running ?? '0.10.0', update,
    operations: {
      create: async (type) => { state.workflow.push(type); throw new Error('not in these tests'); },
      list: async () => structuredClone(state.listed ?? [...ops.values()].reverse()),
      get: async (id) => structuredClone(ops.get(id) ?? null),
      installedRouters: async () => [],
    },
  });
  return { api, audit, files, urls, state, update, ops };
}

const event = (method: string, path: string, groups: string, body?: unknown): ApiEvent => ({
  rawPath: path.split('?')[0]!,
  queryStringParameters: Object.fromEntries(new URLSearchParams(path.split('?')[1] ?? '')),
  requestContext: { http: { method }, authorizer: { jwt: { claims: { sub: 'u', email: 'admin@example.com', 'cognito:groups': `[${groups}]` } } } },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');
const get = async (s: ReturnType<typeof setup>) => json(await s.api(event('GET', '/api/update', 'dmt-admin')));

describe('the update routes', () => {
  it('say the install\'s env and region', async () => {
    const s = setup();
    expect(await get(s)).toMatchObject({ installedWithCli: true, env: 'prod', region: REGION });
  });

  it('are for administrators only', async () => {
    const s = setup();
    for (const group of ['dmt-viewer', 'dmt-operator']) {
      for (const [method, path] of [['GET', '/api/update'], ['GET', '/api/update/changes?to=0.12.0'], ['POST', '/api/update/plan'], ['POST', '/api/update/apply']]) {
        expect((await s.api(event(method!, path!, group, { version: '0.12.0', planBuild: 'x' }))).statusCode).toBe(403);
      }
    }
    expect(s.state.puts).toEqual([]);
  });

  it('without the service: not installed with the CLI, and nothing else', async () => {
    const api = createApi({ routers: [], invoke: async () => ({}), audit: { write: async () => {}, list: async () => [] }, version: '0.1.0', install: { env: 'dev', region: 'eu-west-1' } });
    const res = await api(event('GET', '/api/update', 'dmt-admin'));
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ installedWithCli: false, version: '0.1.0', env: 'dev', region: 'eu-west-1' });
    expect((await api(event('GET', '/api/update/changes?to=0.2.0', 'dmt-admin'))).statusCode).toBe(404);
    expect((await api(event('POST', '/api/update/plan', 'dmt-admin', { version: '0.2.0' }))).statusCode).toBe(404);
    expect((await api(event('POST', '/api/update/apply', 'dmt-admin', { planBuild: 'x' }))).statusCode).toBe(404);
    expect((await api(event('GET', '/api/update', 'dmt-viewer'))).statusCode).toBe(403);
  });
});

describe('the state', () => {
  it('lists the versions offered, the CLI and the applied version with its date', async () => {
    const applied = build(1, 'SUCCEEDED', { ACTION: 'apply' });
    const s = setup({ builds: [applied], files: { 'prod/applied.json': JSON.stringify({ version: '0.10.0', build: applied.id }) } });
    const body = await get(s);
    expect(body).toMatchObject({ installedWithCli: true, version: '0.10.0', cli: '0.2.0', pending: null, plan: null });
    expect(body.versions.map((v: { version: string }) => v.version)).toEqual(['0.12.0', '0.11.0']);
    expect(body.applied).toEqual({ version: '0.10.0', build: applied.id, at: applied.endedAt });
  });

  it('leaves the applied date null when the build is no longer listed', async () => {
    const s = setup({ files: { 'prod/applied.json': JSON.stringify({ version: '0.10.0', build: 'dmt-prod-install:gone' }) } });
    expect((await get(s)).applied).toEqual({ version: '0.10.0', build: 'dmt-prod-install:gone', at: null });
  });

  it('disables every version without cli.json', async () => {
    const s = setup();
    s.files.delete('prod/cli.json');
    const body = await get(s);
    expect(body.cli).toBeNull();
    expect(body.versions.map((v: { disabled: string }) => v.disabled)).toEqual(Array(2).fill('run `dormeto install` with the CLI 0.2.0 or later'));
    const res = await s.api(event('POST', '/api/update/plan', 'dmt-admin', { version: '0.12.0' }));
    expect(res.statusCode).toBe(400);
    expect(json(res).message).toBe('run `dormeto install` with the CLI 0.2.0 or later');
  });

  it('offers latest.json alone without versions.json', async () => {
    const s = setup({ urls: { [`${RELEASES}/latest.json`]: JSON.stringify({ version: '0.12.0', router: '0.29.0', published: '2026-10-20T10:00:00Z' }) } });
    s.urls.delete(`${RELEASES}/versions.json`);
    expect((await get(s)).versions).toEqual([{ version: '0.12.0', router: '0.29.0', minCli: null, published: '2026-10-20T10:00:00Z' }]);
    s.urls.set(`${RELEASES}/versions.json`, 'not json');
    expect((await get(s)).versions.map((v: { version: string }) => v.version)).toEqual(['0.12.0']);
  });

  it('offers the staged release, and says the releases are unreachable when no list can be read', async () => {
    const s = setup({ files: { 'prod/release/SHA256SUMS': 'abc  terraform-aws-dormeto-0.13.0-dev.1.zip\ndef  other.zip\n' } });
    s.urls.clear();
    const body = await get(s);
    expect(body.versions).toEqual([{ version: '0.13.0-dev.1', router: null, minCli: null, published: null, staged: true }]);
    expect(body.releasesUnreachable).toBe(true);
    s.urls.set(`${RELEASES}/versions.json`, 'not json');
    s.urls.set(`${RELEASES}/latest.json`, '{"router":"0.29.0"}');
    expect((await get(s)).releasesUnreachable).toBe(true);
  });

  it('does not say the releases are unreachable when either list is read, even with nothing newer', async () => {
    const s = setup({ running: '0.12.0' });
    let body = await get(s);
    expect(body.versions).toEqual([]);
    expect(body).not.toHaveProperty('releasesUnreachable');
    s.urls.delete(`${RELEASES}/versions.json`);
    s.urls.set(`${RELEASES}/latest.json`, JSON.stringify({ version: '0.12.0', router: '0.29.0', published: '2026-10-20T10:00:00Z' }));
    body = await get(s);
    expect(body.versions).toEqual([]);
    expect(body).not.toHaveProperty('releasesUnreachable');
  });

  it('shows a CLI build running, with the dormeto steps, and refuses a plan', async () => {
    const b = build(5, 'IN_PROGRESS', { ACTION: 'apply', RELEASE_VERSION: '0.11.0' });
    const s = setup({ builds: [b], logs: { 'stream-5': ['noise', 'dormeto: planning', 'more noise', 'dormeto: applying'] } });
    const body = await get(s);
    expect(body.build).toEqual({ id: b.id, by: 'cli', action: 'apply', version: '0.11.0', status: 'IN_PROGRESS', phase: 'BUILD', startedAt: b.startedAt, endedAt: null, steps: ['planning', 'applying'], tail: [], consoleUrl: consoleOf(5) });
    const res = await s.api(event('POST', '/api/update/plan', 'dmt-admin', { version: '0.12.0' }));
    expect(res.statusCode).toBe(409);
    expect(json(res).error).toBe('busy');
    expect(s.state.puts).toEqual([]);
  });

  it('shows the last 40 log lines of a failed build', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
    const s = setup({ builds: [build(5, 'FAILED', { ACTION: 'plan' })], logs: { 'stream-5': lines } });
    const body = await get(s);
    expect(body.build.tail).toEqual(lines.slice(20));
  });

  it('knows a dashboard build by its request: the action and the version come from its result', async () => {
    const b = build(5, 'SUCCEEDED', { ACTION: 'request', REQUEST_ETAG: '0123' });
    const s = setup({ builds: [b], files: { [`prod/results/${b.id}.json`]: JSON.stringify({ build: b.id, status: 'succeeded', message: '', action: 'plan', version: '0.12.0' }) } });
    expect((await get(s)).build).toMatchObject({ by: 'dashboard', action: 'plan', version: '0.12.0' });
  });
});

describe('a plan request', () => {
  it('writes the request, the pending item and the audit entry', async () => {
    const s = setup();
    const res = await s.api(event('POST', '/api/update/plan', 'dmt-admin', { version: '0.12.0' }));
    expect(res.statusCode).toBe(202);
    expect(s.state.puts).toHaveLength(1);
    const [key, body] = s.state.puts[0]!;
    expect(key).toBe('prod/requests/20261020T100000Z-a1b2c3d4.json');
    expect(body).toBe('{"action":"plan","version":"0.12.0","requestedBy":"admin@example.com","requestedAt":"2026-10-20T10:00:00.000Z"}');
    expect(s.state.pending).toEqual({ key, id: '20261020T100000Z-a1b2c3d4', etag: ETAG, action: 'plan', version: '0.12.0', at: '2026-10-20T10:00:00.000Z', who: 'admin@example.com', operation: 'op-1' });
    expect(json(res)).toEqual(s.state.pending);
    expect(s.audit).toHaveLength(1);
    expect(s.audit[0]).toMatchObject({ action: 'update-plan', target: '0.12.0', who: 'admin@example.com' });
  });

  it('rejects a version not offered, a bad body, and a pending request blocks another', async () => {
    const s = setup();
    for (const body of [{ version: '0.9.0' }, { version: '0.99.0' }, { version: 12 }, { version: '1.0; rm' }, {}]) {
      expect((await s.api(event('POST', '/api/update/plan', 'dmt-admin', body))).statusCode).toBe(400);
    }
    expect((await s.api(event('POST', '/api/update/plan', 'dmt-admin', { version: '0.12.0' }))).statusCode).toBe(202);
    const again = await s.api(event('POST', '/api/update/plan', 'dmt-admin', { version: '0.11.0' }));
    expect(again.statusCode).toBe(409);
    expect(s.state.puts).toHaveLength(1);
  });

  it('stays pending while its result runs, and is cleared by a succeeded or failed one', async () => {
    const s = setup();
    await s.api(event('POST', '/api/update/plan', 'dmt-admin', { version: '0.12.0' }));
    const id = '20261020T100000Z-a1b2c3d4';
    s.files.set(`prod/results/${id}.json`, JSON.stringify({ build: 'x', status: 'running', message: '', action: 'plan', version: '0.12.0' }));
    s.state.now += 10 * 60_000;
    expect((await get(s)).pending).toMatchObject({ id });
    expect((await get(s)).pending.notStarted).toBeUndefined();
    s.files.set(`prod/results/${id}.json`, JSON.stringify({ build: 'x', status: 'failed', message: 'no', action: 'plan', version: '0.12.0' }));
    expect((await get(s)).pending).toBeNull();
    expect(s.state.pending).toBeNull();
  });

  it('is marked not started after 2 minutes without a result, and then no longer blocks', async () => {
    const s = setup();
    await s.api(event('POST', '/api/update/plan', 'dmt-admin', { version: '0.12.0' }));
    s.state.now += 119_000;
    expect((await get(s)).pending.notStarted).toBeUndefined();
    s.state.now += 2_000;
    expect((await get(s)).pending).toMatchObject({ notStarted: true });
    expect(s.state.pending).not.toBeNull();
    expect((await s.api(event('POST', '/api/update/plan', 'dmt-admin', { version: '0.11.0' }))).statusCode).toBe(202);
    expect(s.state.puts).toHaveLength(2);
  });
});

describe('the confirmable plan and the apply request', () => {
  const reqBuild = (n: number, status = 'SUCCEEDED') => build(n, status, { ACTION: 'request', REQUEST_ETAG: `e${n}` });
  const result = (n: number, b: Build, action: string, status = 'succeeded') => [`prod/results/${b.id}.json`, JSON.stringify({ build: b.id, status, message: '', action, version: '0.12.0' })] as const;
  const withPlan = (b: Build, version = '0.12.0') => ({ [`prod/plans/${b.id}/release.json`]: JSON.stringify({ version, base: 'x', request: 'y', appliedBuild: '' }), [`prod/plans/${b.id}/plan.json`]: PLAN_JSON });

  it('offers the newest succeeded dashboard plan, summarized', async () => {
    const p = reqBuild(7);
    const s = setup({ builds: [p], files: { ...Object.fromEntries([result(7, p, 'plan')]), ...withPlan(p) } });
    expect((await get(s)).plan).toEqual({ build: p.id, version: '0.12.0', summary: { add: 1, change: 1, destroy: 0, replaced: [], destroyed: [] } });
  });

  it('is no longer the plan once another plan started, or an apply succeeded, after it', async () => {
    const p = reqBuild(7);
    const files = { ...Object.fromEntries([result(7, p, 'plan')]), ...withPlan(p) };
    for (const later of [build(8, 'FAILED', { ACTION: 'plan' }), build(8, 'SUCCEEDED', { ACTION: 'plan-destroy' }), build(8, 'SUCCEEDED', { ACTION: 'apply' }), build(8, 'SUCCEEDED', { ACTION: 'apply-destroy' })]) {
      expect((await get(setup({ builds: [later, p], files }))).plan).toBeNull();
    }
    const q = reqBuild(8, 'FAILED');
    expect((await get(setup({ builds: [q, p], files: { ...files, ...Object.fromEntries([result(8, q, 'plan', 'failed')]) } }))).plan).toBeNull();
    // A failed apply, or a refused request, does not make it stale.
    const failed = build(8, 'FAILED', { ACTION: 'apply' });
    expect((await get(setup({ builds: [failed, p], files }))).plan).toMatchObject({ build: p.id });
  });

  it('needs the release.json, and a plan result', async () => {
    const p = reqBuild(7);
    expect((await get(setup({ builds: [p], files: { ...Object.fromEntries([result(7, p, 'plan')]), [`prod/plans/${p.id}/plan.json`]: PLAN_JSON } }))).plan).toBeNull();
    expect((await get(setup({ builds: [p], files: { ...Object.fromEntries([result(7, p, 'apply')]), ...withPlan(p) } }))).plan).toBeNull();
  });

  it('writes the apply request for the confirmable plan, audited with the plan version', async () => {
    const p = reqBuild(7);
    const s = setup({ builds: [p], files: { ...Object.fromEntries([result(7, p, 'plan')]), ...withPlan(p) } });
    const res = await s.api(event('POST', '/api/update/apply', 'dmt-admin', { planBuild: p.id }));
    expect(res.statusCode).toBe(202);
    const [key, body] = s.state.puts[0]!;
    expect(key).toBe('prod/requests/20261020T100000Z-a1b2c3d4.json');
    expect(body).toBe(`{"action":"apply","version":"0.12.0","planBuild":"${p.id}","requestedBy":"admin@example.com","requestedAt":"2026-10-20T10:00:00.000Z"}`);
    expect(s.state.pending).toMatchObject({ action: 'apply', version: '0.12.0', planBuild: p.id });
    expect(s.audit[0]).toMatchObject({ action: 'update-apply', target: '0.12.0', who: 'admin@example.com' });
  });

  it('refuses an older plan build, a bad body, and a busy install', async () => {
    const p = reqBuild(7);
    const old = reqBuild(3);
    const s = setup({ builds: [p, old], files: { ...Object.fromEntries([result(7, p, 'plan'), result(3, old, 'plan')]), ...withPlan(p), ...withPlan(old) } });
    expect((await s.api(event('POST', '/api/update/apply', 'dmt-admin', { planBuild: old.id }))).statusCode).toBe(400);
    expect((await s.api(event('POST', '/api/update/apply', 'dmt-admin', { planBuild: 7 }))).statusCode).toBe(400);
    expect((await s.api(event('POST', '/api/update/apply', 'dmt-admin', {}))).statusCode).toBe(400);
    expect(s.state.puts).toEqual([]);
    expect(s.audit.map((a) => a.action)).toEqual(['update-apply']);
    const running = setup({ builds: [build(9, 'IN_PROGRESS', { ACTION: 'plan' }), p], files: { ...Object.fromEntries([result(7, p, 'plan')]), ...withPlan(p) } });
    expect((await running.api(event('POST', '/api/update/apply', 'dmt-admin', { planBuild: p.id }))).statusCode).toBe(409);
  });
});

describe('the changes', () => {
  it('lists the sections from the running version to the target, newest first, a missing one with null notes', async () => {
    const s = setup();
    const res = await s.api(event('GET', '/api/update/changes?to=0.12.0', 'dmt-admin'));
    expect(res.statusCode).toBe(200);
    const sections = json(res);
    expect(sections.map((x: { version: string }) => x.version)).toEqual(['0.12.0', '0.11.0']);
    expect(sections[0]).toEqual({ version: '0.12.0', notes: '## 0.12.0 — 2026-10-20\n\nSelf-update.\n\nRouter 0.29.0. Access: apply again.', access: 'Access: apply again.', accessNeeded: true });
    expect(sections[1]).toMatchObject({ version: '0.11.0', access: 'Access: nothing to apply again.', accessNeeded: false });
    s.urls.delete(`${RELEASES}/0.11.0/CHANGELOG.md`);
    expect(json(await s.api(event('GET', '/api/update/changes?to=0.12.0', 'dmt-admin')))[1]).toEqual({ version: '0.11.0', notes: null, access: null, accessNeeded: false });
    s.urls.set(`${RELEASES}/0.11.0/CHANGELOG.md`, '## 0.9.0\n\nwrong\n');
    expect(json(await s.api(event('GET', '/api/update/changes?to=0.11.0', 'dmt-admin')))[0].notes).toBeNull();
  });

  it('stops at the target and refuses one not offered', async () => {
    const s = setup();
    expect(json(await s.api(event('GET', '/api/update/changes?to=0.11.0', 'dmt-admin'))).map((x: { version: string }) => x.version)).toEqual(['0.11.0']);
    expect((await s.api(event('GET', '/api/update/changes?to=0.99.0', 'dmt-admin'))).statusCode).toBe(400);
    expect((await s.api(event('GET', '/api/update/changes', 'dmt-admin'))).statusCode).toBe(400);
  });

  it('reads the staged release notes from the bucket, disabled versions included', async () => {
    const s = setup({ files: { 'prod/release/SHA256SUMS': 'abc  terraform-aws-dormeto-0.13.0.zip\n', 'prod/release/CHANGELOG.md': '## 0.13.0 — 2026-10-21\n\nStaged.\n\n## 0.12.0\n\nx\n' } });
    s.files.delete('prod/cli.json');
    const sections = json(await s.api(event('GET', '/api/update/changes?to=0.13.0', 'dmt-admin')));
    expect(sections.map((x: { version: string }) => x.version)).toEqual(['0.13.0', '0.12.0', '0.11.0']);
    expect(sections[0].notes).toBe('## 0.13.0 — 2026-10-21\n\nStaged.');
  });
});

describe('a pending request whose build ended or is queueing', () => {
  const runningResult = (b: Build) => JSON.stringify({ build: b.id, status: 'running', message: '', action: 'plan', version: '0.12.0' });
  const ID_ = '20261020T100000Z-a1b2c3d4';
  const mine = (n: number, status: string) => build(n, status, { ACTION: 'request', REQUEST_ETAG: ETAG });

  it('stops blocking once its build ended without a final result', async () => {
    const s = setup();
    await s.api(event('POST', '/api/update/plan', 'dmt-admin', { version: '0.12.0' }));
    const b = mine(5, 'TIMED_OUT');
    s.state.builds = [b];
    s.files.set(`prod/results/${ID_}.json`, runningResult(b));
    s.state.now += 10 * 60_000;
    const body = await get(s);
    expect(body.pending).toBeNull();
    expect(body.build.status).toBe('TIMED_OUT');
    expect(s.state.pending).toBeNull();
    expect((await s.api(event('POST', '/api/update/plan', 'dmt-admin', { version: '0.12.0' }))).statusCode).toBe(202);
  });

  it('stops blocking when its build failed before writing any result', async () => {
    const s = setup();
    await s.api(event('POST', '/api/update/plan', 'dmt-admin', { version: '0.12.0' }));
    s.state.builds = [mine(5, 'FAILED')];
    expect((await get(s)).pending).toBeNull();
    expect(s.state.pending).toBeNull();
    expect((await s.api(event('POST', '/api/update/plan', 'dmt-admin', { version: '0.12.0' }))).statusCode).toBe(202);
  });

  it('matches its build by the request ETag only', async () => {
    const s = setup();
    await s.api(event('POST', '/api/update/plan', 'dmt-admin', { version: '0.12.0' }));
    expect(s.state.pending).toMatchObject({ etag: ETAG });
    s.state.builds = [build(5, 'FAILED', { ACTION: 'request', REQUEST_ETAG: 'ffff' })];
    s.state.now += 3 * 60_000;
    expect((await get(s)).pending).toMatchObject({ notStarted: true });
  });

  it('keeps blocking while its build is in progress', async () => {
    const s = setup();
    await s.api(event('POST', '/api/update/plan', 'dmt-admin', { version: '0.12.0' }));
    const b = mine(5, 'IN_PROGRESS');
    s.state.builds = [b];
    s.files.set(`prod/results/${ID_}.json`, runningResult(b));
    s.state.now += 10 * 60_000;
    expect((await s.api(event('POST', '/api/update/plan', 'dmt-admin', { version: '0.12.0' }))).statusCode).toBe(409);
  });

  it('is not marked not started while a build holds its request', async () => {
    const s = setup();
    await s.api(event('POST', '/api/update/plan', 'dmt-admin', { version: '0.12.0' }));
    s.state.builds = [mine(5, 'IN_PROGRESS')];
    s.state.now += 3 * 60_000;
    const body = await get(s);
    expect(body.pending).toMatchObject({ id: ID_ });
    expect(body.pending.notStarted).toBeUndefined();
  });
});

describe('the versions available', () => {
  it('counts the versions offered, disabled and staged included, from the versions, cli.json and the staged checksums only', async () => {
    const s = setup({
      files: { 'prod/release/SHA256SUMS': 'abc  terraform-aws-dormeto-0.13.0-dev.1.zip\n' },
      builds: [build(5, 'FAILED', { ACTION: 'request', REQUEST_ETAG: ETAG })], logs: { 'stream-5': ['dormeto: x'] },
    });
    const res = await s.api(event('GET', '/api/update/available', 'dmt-admin'));
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ count: 3 });
    // Neither the builds, their logs, the pending request nor any other object.
    expect(s.state.calls).toEqual({ builds: 0, logLines: 0, pending: 0 });
    expect([...s.state.gets].sort()).toEqual(['prod/cli.json', 'prod/release/SHA256SUMS']);
    s.files.delete('prod/cli.json');
    expect(json(await s.api(event('GET', '/api/update/available', 'dmt-admin')))).toEqual({ count: 3 });
  });

  it('is 0 when nothing is newer, and without the service', async () => {
    expect(json(await setup({ running: '0.12.0' }).api(event('GET', '/api/update/available', 'dmt-admin')))).toEqual({ count: 0 });
    const api = createApi({ routers: [], invoke: async () => ({}), audit: { write: async () => {}, list: async () => [] }, version: '0.1.0' });
    const res = await api(event('GET', '/api/update/available', 'dmt-admin'));
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ count: 0 });
    expect((await api(event('GET', '/api/update/available', 'dmt-operator'))).statusCode).toBe(403);
  });

  it('is for administrators only', async () => {
    const s = setup();
    for (const group of ['dmt-viewer', 'dmt-operator']) expect((await s.api(event('GET', '/api/update/available', group))).statusCode).toBe(403);
  });
});

describe('an operation per dashboard request', () => {
  const REQ = '20261020T100000Z-a1b2c3d4';
  const AT = '2026-10-20T10:00:00.000Z';
  const mine = (n: number, status: string) => build(n, status, { ACTION: 'request', REQUEST_ETAG: ETAG });
  const result = (b: Build | null, status: string, message = '') => JSON.stringify({ build: b?.id ?? '', status, message, action: 'plan', version: '0.12.0' });
  const plan = async (s: ReturnType<typeof setup>) => expect((await s.api(event('POST', '/api/update/plan', 'dmt-admin', { version: '0.12.0' }))).statusCode).toBe(202);
  const later = (s: ReturnType<typeof setup>, ms: number) => { s.state.now += ms; return new Date(s.state.now).toISOString(); };

  it('records a plan request as a running manager update, through the records only (never the workflow)', async () => {
    const s = setup();
    await plan(s);
    expect([...s.ops.values()]).toEqual([{
      id: 'op-1', type: 'update-manager', target: { account: ACCOUNT, region: REGION, version: '0.12.0' }, input: { action: 'plan', version: '0.12.0', request: REQ, etag: ETAG },
      status: 'running', steps: [{ name: 'Plan manager 0.12.0', status: 'running', startedAt: AT }], cursor: 0, holds: { locks: [], slots: [] }, activeKey: '',
      context: {}, by: 'admin@example.com', createdAt: AT, updatedAt: AT,
    }]);
    expect(s.state.pending).toMatchObject({ id: REQ, operation: 'op-1' });
    expect(s.state.workflow).toEqual([]);
  });

  it('records an apply request with its plan build', async () => {
    const p = build(7, 'SUCCEEDED', { ACTION: 'request', REQUEST_ETAG: 'e7' });
    const s = setup({ builds: [p], files: {
      [`prod/results/${p.id}.json`]: JSON.stringify({ build: p.id, status: 'succeeded', message: '', action: 'plan', version: '0.12.0' }),
      [`prod/plans/${p.id}/release.json`]: JSON.stringify({ version: '0.12.0', base: 'x', request: 'y' }), [`prod/plans/${p.id}/plan.json`]: PLAN_JSON,
    } });
    expect((await s.api(event('POST', '/api/update/apply', 'dmt-admin', { planBuild: p.id }))).statusCode).toBe(202);
    expect(s.ops.get('op-1')).toMatchObject({
      type: 'update-manager', target: { account: ACCOUNT, region: REGION, version: '0.12.0' }, input: { action: 'apply', version: '0.12.0', request: REQ, planBuild: p.id, etag: ETAG },
      status: 'running', steps: [{ name: 'Apply manager 0.12.0', status: 'running' }], by: 'admin@example.com',
    });
  });

  it('fails at once when the request cannot be written, and answers the error', async () => {
    const s = setup();
    s.state.putFails = true;
    const res = await s.api(event('POST', '/api/update/plan', 'dmt-admin', { version: '0.12.0' }));
    expect(res.statusCode).toBe(500);
    expect(s.ops.get('op-1')).toMatchObject({
      status: 'failed', finishedAt: AT, error: 'the request could not be written', steps: [{ name: 'Plan manager 0.12.0', status: 'failed', finishedAt: AT }],
      input: { action: 'plan', version: '0.12.0', request: REQ },
    });
    expect(s.ops.get('op-1')!.input).not.toHaveProperty('etag');
    expect(s.state.pending).toBeNull();
    expect(s.audit[0]).toMatchObject({ action: 'update-plan', result: 'error: Service Unavailable' });
  });

  it('records nothing for a refused request', async () => {
    const s = setup({ builds: [build(9, 'IN_PROGRESS', { ACTION: 'plan' })] });
    expect((await s.api(event('POST', '/api/update/plan', 'dmt-admin', { version: '0.12.0' }))).statusCode).toBe(409);
    expect(s.ops.size).toBe(0);
    const t = setup();
    expect((await t.api(event('POST', '/api/update/plan', 'dmt-admin', { version: '0.99.0' }))).statusCode).toBe(400);
    expect((await t.api(event('POST', '/api/update/apply', 'dmt-admin', { planBuild: `${ID}:00000000-0000-0000-0000-000000000007` }))).statusCode).toBe(400);
    expect(t.ops.size).toBe(0);
  });

  it('succeeds with its final result when the state is read, with its build and the build\'s console link', async () => {
    const s = setup();
    await plan(s);
    const b = mine(5, 'SUCCEEDED');
    s.state.builds = [b];
    s.files.set(`prod/results/${REQ}.json`, result(b, 'succeeded', 'planned'));
    const end = later(s, 5 * 60_000);
    await get(s);
    const op = s.ops.get('op-1')!;
    expect(op).toMatchObject({
      status: 'succeeded', finishedAt: end, updatedAt: end, steps: [{ name: 'Plan manager 0.12.0', status: 'done', startedAt: AT, finishedAt: end }],
      context: { build: b.id, consoleUrl: consoleOf(5) },
    });
    expect(op).not.toHaveProperty('error');
    expect(s.state.pending).toBeNull();
  });

  it('fails with its result\'s message', async () => {
    const s = setup();
    await plan(s);
    const b = mine(5, 'FAILED');
    s.state.builds = [b];
    s.files.set(`prod/results/${REQ}.json`, result(b, 'failed', 'manager 0.12.0 is neither published nor staged'));
    const end = later(s, 60_000);
    await get(s);
    expect(s.ops.get('op-1')).toMatchObject({
      status: 'failed', finishedAt: end, error: 'manager 0.12.0 is neither published nor staged', steps: [{ status: 'failed', finishedAt: end }],
      context: { build: b.id, consoleUrl: consoleOf(5) },
    });
  });

  it('fails when its build ended without its final result', async () => {
    const s = setup();
    await plan(s);
    const b = mine(5, 'TIMED_OUT');
    s.state.builds = [b];
    s.files.set(`prod/results/${REQ}.json`, result(b, 'running'));
    later(s, 60 * 60_000);
    await get(s);
    expect(s.ops.get('op-1')).toMatchObject({ status: 'failed', error: 'the build ended without its result', steps: [{ status: 'failed' }], context: { build: b.id, consoleUrl: consoleOf(5) } });
    // A build that failed before writing any result, found by the request's ETag.
    const t = setup();
    await plan(t);
    t.state.builds = [mine(6, 'FAILED')];
    await get(t);
    expect(t.ops.get('op-1')).toMatchObject({ status: 'failed', error: 'the build ended without its result', context: { build: mine(6, 'FAILED').id, consoleUrl: consoleOf(6) } });
  });

  it('fails when no build took it within 2 minutes', async () => {
    const s = setup();
    await plan(s);
    later(s, 119_000);
    await get(s);
    expect(s.ops.get('op-1')).toMatchObject({ status: 'running', context: {} });
    const end = later(s, 2_000);
    expect((await get(s)).pending).toMatchObject({ notStarted: true });
    expect(s.ops.get('op-1')).toMatchObject({ status: 'failed', finishedAt: end, error: 'the update did not start', steps: [{ status: 'failed' }], context: {} });
  });

  it('stays running while its build runs, and links that build as soon as it is known', async () => {
    const s = setup();
    await plan(s);
    const b = mine(5, 'IN_PROGRESS');
    s.state.builds = [b];
    later(s, 3 * 60_000);
    await get(s);
    expect(s.ops.get('op-1')).toMatchObject({ status: 'running', steps: [{ status: 'running' }], context: { build: b.id, consoleUrl: consoleOf(5) } });
    expect(s.ops.get('op-1')).not.toHaveProperty('finishedAt');
  });

  it('is brought up to date when the operations are listed: the running update operations only, one result read each', async () => {
    const s = setup();
    await plan(s);
    const b = mine(5, 'SUCCEEDED');
    s.state.builds = [b];
    s.files.set(`prod/results/${REQ}.json`, result(b, 'succeeded'));
    const done: Operation = { ...s.ops.get('op-1')!, id: 'op-0', input: { action: 'plan', version: '0.11.0', request: '20261019T100000Z-00000000' }, status: 'succeeded' };
    const router: Operation = { ...s.ops.get('op-1')!, id: 'op-r', type: 'upgrade-router', input: {}, steps: [{ name: 'find router', status: 'running' }] };
    s.ops.set('op-0', done);
    s.ops.set('op-r', router);
    s.state.gets.length = 0;
    const listed = json(await s.api(event('GET', '/api/operations', 'dmt-admin'))).operations as Operation[];
    expect(listed.find((o) => o.id === 'op-1')).toMatchObject({ status: 'succeeded', context: { build: b.id, consoleUrl: consoleOf(5) } });
    expect(s.ops.get('op-1')!.status).toBe('succeeded');
    expect(listed.find((o) => o.id === 'op-0')).toEqual(done);
    expect(listed.find((o) => o.id === 'op-r')).toEqual(router);
    expect(s.state.gets).toEqual([`prod/results/${REQ}.json`]);
    // Nothing running: nothing read.
    s.state.gets.length = 0;
    s.state.calls.builds = 0;
    await s.api(event('GET', '/api/operations', 'dmt-admin'));
    expect(s.state.gets).toEqual([]);
    expect(s.state.calls.builds).toBe(0);
  });

  it('fails a listed update whose request no build took within 2 minutes, though no pending request names it', async () => {
    const s = setup();
    await plan(s);
    s.state.pending = null;
    later(s, 3 * 60_000);
    const listed = json(await s.api(event('GET', '/api/operations', 'dmt-admin'))).operations as Operation[];
    expect(listed[0]).toMatchObject({ id: 'op-1', status: 'failed', error: 'the update did not start' });
  });

  it('keeps a listed update running while a queued build carries the ETag on its record, though no pending request names it', async () => {
    const s = setup();
    await plan(s);
    s.state.pending = null;
    const queued = build(5, 'IN_PROGRESS', { ACTION: 'request', REQUEST_ETAG: ETAG }, { phase: 'QUEUED', startedAt: null });
    s.state.builds = [queued];
    later(s, 5 * 60_000);
    const listed = json(await s.api(event('GET', '/api/operations', 'dmt-admin'))).operations as Operation[];
    expect(listed[0]).toMatchObject({ id: 'op-1', status: 'running', context: { build: queued.id, consoleUrl: consoleOf(5) } });
    expect(s.ops.get('op-1')).toMatchObject({ status: 'running' });
  });

  it('follows the pending request\'s ETag when its record could not take it', async () => {
    const s = setup();
    s.state.updateFails = 1;
    expect((await s.api(event('POST', '/api/update/plan', 'dmt-admin', { version: '0.12.0' }))).statusCode).toBe(500);
    expect(s.ops.get('op-1')!.input).not.toHaveProperty('etag');
    expect(s.state.pending).toMatchObject({ etag: ETAG, operation: 'op-1' });
    s.state.builds = [build(5, 'IN_PROGRESS', { ACTION: 'request', REQUEST_ETAG: ETAG }, { phase: 'QUEUED', startedAt: null })];
    later(s, 5 * 60_000);
    const listed = json(await s.api(event('GET', '/api/operations', 'dmt-admin'))).operations as Operation[];
    expect(listed[0]).toMatchObject({ id: 'op-1', status: 'running' });
  });

  it('never writes a lagging listed copy over its record: the record is read again, and left unless still running', async () => {
    const s = setup();
    await plan(s);
    const stale = structuredClone(s.ops.get('op-1')!);
    const b = mine(5, 'IN_PROGRESS');
    s.state.builds = [b];
    s.files.set(`prod/results/${REQ}.json`, result(b, 'running'));
    const stored: Operation = { ...stale, status: 'succeeded', finishedAt: AT, steps: [{ ...stale.steps[0]!, status: 'done', finishedAt: AT }], context: { build: b.id, consoleUrl: consoleOf(5) } };
    s.ops.set('op-1', structuredClone(stored));
    s.state.listed = [stale];
    s.state.updates = 0;
    later(s, 60_000);
    const listed = json(await s.api(event('GET', '/api/operations', 'dmt-admin'))).operations as Operation[];
    expect(s.state.updates).toBe(0);
    expect(s.ops.get('op-1')).toEqual(stored);
    expect(listed[0]).toEqual(stored);
  });

  it('lists the operations as they are when they cannot be brought up to date', async () => {
    const s = setup();
    await plan(s);
    s.state.throttled = true;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await s.api(event('GET', '/api/operations', 'dmt-admin'));
    expect(res.statusCode).toBe(200);
    expect(json(res).operations).toMatchObject([{ id: 'op-1', status: 'running' }]);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('UpdateOperationsNotRefreshed'));
    logged.mockRestore();
  });

  it('is neither listed nor read, nor brought up to date, for operators and viewers', async () => {
    const s = setup();
    await plan(s);
    s.state.gets.length = 0;
    for (const group of ['dmt-viewer', 'dmt-operator']) {
      expect(json(await s.api(event('GET', '/api/operations', group))).operations).toEqual([]);
      expect((await s.api(event('GET', '/api/operations/op-1', group))).statusCode).toBe(404);
    }
    expect(s.state.gets).toEqual([]);
    expect((await s.api(event('GET', '/api/operations/op-1', 'dmt-admin'))).statusCode).toBe(200);
  });
});

describe('the port decisions', () => {
  it('reads an absent object, also as AccessDenied (no ListBucket), but not a throttle or a 500', () => {
    expect(absent({ name: 'NoSuchKey' })).toBe(true);
    expect(absent({ name: 'NotFound', $metadata: { httpStatusCode: 404 } })).toBe(true);
    expect(absent({ name: 'AccessDenied', $metadata: { httpStatusCode: 403 } })).toBe(true);
    expect(absent({ name: 'Whatever', $metadata: { httpStatusCode: 403 } })).toBe(true);
    expect(absent({ name: 'SlowDown', $metadata: { httpStatusCode: 503 } })).toBe(false);
    expect(absent({ name: 'InternalError', $metadata: { httpStatusCode: 500 } })).toBe(false);
    expect(absent(new Error('boom'))).toBe(false);
  });

  it('reads a log stream not created yet as empty', () => {
    expect(missingStream({ name: 'ResourceNotFoundException' })).toBe(true);
    expect(missingStream({ name: 'ThrottlingException' })).toBe(false);
  });

  it('reads a releases URL within 5 s: the text when it answers 200, null for an HTTP error, a failure or a timeout', async () => {
    const seen: Array<AbortSignal | null | undefined> = [];
    const answering = (res: Response) => (async (_url: string | URL | Request, init?: RequestInit) => { seen.push(init?.signal); return res; }) as typeof fetch;
    expect(await fetchText('https://r.test/a', answering(new Response('hello')))).toBe('hello');
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(seen[0]!.aborted).toBe(false);
    expect(await fetchText('https://r.test/a', answering(new Response('no', { status: 403 })))).toBeNull();
    expect(await fetchText('https://r.test/a', (async () => { throw new TypeError('fetch failed'); }) as typeof fetch)).toBeNull();
    // A server that never answers: the request is aborted at the timeout.
    const hanging = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    })) as typeof fetch;
    const started = Date.now();
    expect(await fetchText('https://r.test/a', hanging, 50)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(FETCH_MS).toBe(5_000);
  });
});

describe('the daily update check', () => {
  function checking(over: { result?: UpdateResult | null } = {}) {
    let check: UpdateCheck = { enabled: false, alert: false };
    const audit: AuditEntry[] = [];
    const api = createApi({
      routers: [], invoke: async () => ({}), audit: { write: async (e) => { audit.push(e); }, list: async () => audit }, now: () => START, newId: () => 'id', version: '0.10.0',
      fleet: {
        getUpdateCheck: async () => check,
        putUpdateCheck: async (c: UpdateCheck & { updatedBy: string }) => { const { updatedBy, ...rest } = c; check = { ...rest, updatedAt: new Date(START).toISOString(), updatedBy }; },
        getUpdateResult: async () => over.result ?? null,
      } as never,
    });
    return { api, audit };
  }

  it('is for administrators only', async () => {
    const s = checking();
    for (const group of ['dmt-viewer', 'dmt-operator']) {
      for (const method of ['GET', 'PUT']) expect((await s.api(event(method, '/api/update/check', group, { enabled: true, alert: false }))).statusCode).toBe(403);
    }
    expect(s.audit).toEqual([]);
  });

  it('is off by default, with no result', async () => {
    const res = await checking().api(event('GET', '/api/update/check', 'dmt-admin'));
    expect([res.statusCode, json(res)]).toEqual([200, { enabled: false, alert: false, result: null }]);
  });

  it('is set, then read with who set it, the last result and an audit entry', async () => {
    const result = { checkedAt: '2026-10-20T07:00:00.000Z', running: '0.10.0', latest: '0.12.0' };
    const s = checking({ result });
    const put = await s.api(event('PUT', '/api/update/check', 'dmt-admin', { enabled: true, alert: true }));
    expect([put.statusCode, json(put)]).toEqual([200, { enabled: true, alert: true, updatedAt: new Date(START).toISOString(), updatedBy: 'admin@example.com', result }]);
    expect(json(await s.api(event('GET', '/api/update/check', 'dmt-admin')))).toMatchObject({ enabled: true, alert: true, updatedBy: 'admin@example.com', result });
    expect(s.audit).toEqual([expect.objectContaining({ action: 'update-check', target: 'update', result: 'enabled, alert' })]);
  });

  it('refuses the alert without the check, and a body that is not two booleans', async () => {
    const s = checking();
    for (const body of [{ enabled: false, alert: true }, { enabled: 'yes', alert: false }, { enabled: true }, {}]) {
      expect((await s.api(event('PUT', '/api/update/check', 'dmt-admin', body))).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await s.api(event('GET', '/api/update/check', 'dmt-admin'))).statusCode).toBe(200);
    expect(s.audit).toEqual([]);
  });

  it('is absent without the fleet store', async () => {
    const api = createApi({ routers: [], invoke: async () => ({}), audit: { write: async () => {}, list: async () => [] }, version: '0.1.0' });
    expect((await api(event('GET', '/api/update/check', 'dmt-admin'))).statusCode).toBe(404);
  });
});
