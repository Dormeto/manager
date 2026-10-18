import { describe, expect, it } from 'vitest';
import { createApi, type ApiEvent, type AuditEntry } from '../src/api.js';
import { absent, missingStream, createUpdate, type Build, type Pending, type UpdatePort } from '../src/update.js';

const RELEASES = 'https://releases.test/manager';
const START = Date.parse('2026-10-20T10:00:00Z');
const ID = 'dmt-prod-install';
const PLAN_JSON = JSON.stringify({ format_version: '1.2', resource_changes: [{ address: 'aws_x.a', change: { actions: ['create'] } }, { address: 'aws_x.b', change: { actions: ['update'] } }] });

const build = (n: number, status: string, env: Record<string, string> = {}, extra: Partial<Build> = {}): Build => ({
  id: `${ID}:00000000-0000-0000-0000-${String(n).padStart(12, '0')}`, status, phase: status === 'IN_PROGRESS' ? 'BUILD' : 'COMPLETED',
  startedAt: new Date(START - (100 - n) * 60_000).toISOString(), endedAt: status === 'IN_PROGRESS' ? null : new Date(START - (100 - n) * 60_000 + 30_000).toISOString(),
  env, logStream: `stream-${n}`, ...extra,
});

function setup(opts: { running?: string; files?: Record<string, string>; urls?: Record<string, string>; builds?: Build[]; logs?: Record<string, string[]>; pending?: Pending | null } = {}) {
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
  const state = { builds: opts.builds ?? [], pending: opts.pending ?? null, puts: [] as Array<[string, string]>, now: START };
  const port: UpdatePort = {
    get: async (key) => files.get(key) ?? null,
    put: async (key, body) => { files.set(key, body); state.puts.push([key, body]); },
    builds: async () => state.builds,
    logLines: async (_group, stream) => opts.logs?.[stream] ?? [],
    fetchText: async (url) => urls.get(url) ?? null,
    pending: { get: async () => state.pending, put: async (p) => { state.pending = p; } },
  };
  const update = createUpdate(port, { env: 'prod', logGroup: '/aws/codebuild/dmt-prod-install', version: opts.running ?? '0.10.0', releasesUrl: RELEASES, now: () => new Date(state.now), random: () => 'a1b2c3d4' });
  const audit: AuditEntry[] = [];
  const api = createApi({
    routers: [], invoke: async () => ({}), audit: { write: async (e) => { audit.push(e); }, list: async () => audit },
    now: () => state.now, newId: () => 'id', version: opts.running ?? '0.10.0', update,
  });
  return { api, audit, files, urls, state, update };
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
    const api = createApi({ routers: [], invoke: async () => ({}), audit: { write: async () => {}, list: async () => [] }, version: '0.1.0' });
    const res = await api(event('GET', '/api/update', 'dmt-admin'));
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ installedWithCli: false, version: '0.1.0' });
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

  it('offers the staged release, and nothing when no list is reachable', async () => {
    const s = setup({ files: { 'prod/release/SHA256SUMS': 'abc  terraform-aws-dormeto-0.13.0-dev.1.zip\ndef  other.zip\n' } });
    s.urls.clear();
    expect((await get(s)).versions).toEqual([{ version: '0.13.0-dev.1', router: null, minCli: null, published: null, staged: true }]);
  });

  it('shows a CLI build running, with the dormeto steps, and refuses a plan', async () => {
    const b = build(5, 'IN_PROGRESS', { ACTION: 'apply', RELEASE_VERSION: '0.11.0' });
    const s = setup({ builds: [b], logs: { 'stream-5': ['noise', 'dormeto: planning', 'more noise', 'dormeto: applying'] } });
    const body = await get(s);
    expect(body.build).toEqual({ id: b.id, by: 'cli', action: 'apply', version: '0.11.0', status: 'IN_PROGRESS', phase: 'BUILD', startedAt: b.startedAt, endedAt: null, steps: ['planning', 'applying'], tail: [] });
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
    const b = build(5, 'SUCCEEDED', { ACTION: 'request', REQUEST_KEY: 'prod/requests/20261020T095000Z-aaaaaaaa.json' });
    const s = setup({ builds: [b], files: { 'prod/results/20261020T095000Z-aaaaaaaa.json': JSON.stringify({ build: b.id, status: 'succeeded', message: '', action: 'plan', version: '0.12.0' }) } });
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
    expect(s.state.pending).toEqual({ key, id: '20261020T100000Z-a1b2c3d4', action: 'plan', version: '0.12.0', at: '2026-10-20T10:00:00.000Z', who: 'admin@example.com' });
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
  const requestKey = (n: number) => `prod/requests/20261020T09${String(n).padStart(2, '0')}00Z-aaaaaaa${n}.json`;
  const reqBuild = (n: number, status = 'SUCCEEDED') => build(n, status, { ACTION: 'request', REQUEST_KEY: requestKey(n) });
  const result = (n: number, b: Build, action: string, status = 'succeeded') => [`prod/results/${requestKey(n).split('/')[2]!.replace('.json', '')}.json`, JSON.stringify({ build: b.id, status, message: '', action, version: '0.12.0' })] as const;
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
  const mine = (n: number, status: string) => build(n, status, { ACTION: 'request', REQUEST_KEY: `prod/requests/${ID_}.json` });

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
});
