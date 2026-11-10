import { describe, expect, it } from 'vitest';
import type { Candidate } from '@dormeto/discovery';
import type { RouterSummary } from '@dormeto/fleet';
import type { InstalledRouter, Operation } from '@dormeto/operations';
import { createApi, RouterError, type ApiEvent, type AuditEntry, type OperationsApi } from '../src/api.js';
import { candidate, memoryStore } from './memory-store.js';

const NOW = Date.UTC(2026, 9, 5, 12, 0);
const MANAGER = '121014831971';
const TG = `arn:aws:elasticloadbalancing:eu-west-3:${MANAGER}:targetgroup/paris-app/73e2d6bc24d8a067`;

function setup({ installed = [] as InstalledRouter[], conflict = null as string | null, listed = null as Operation[] | null, visible = undefined as (() => boolean) | undefined, answers = '0.18.0', summaries = undefined as RouterSummary[] | undefined } = {}) {
  const audit: AuditEntry[] = [];
  const created: [string, Record<string, unknown>, string][] = [];
  const calls: [string, Record<string, unknown>][] = [];
  const operation = (type: string, input: Record<string, unknown>): Operation => ({
    id: 'op1', type: type as Operation['type'], target: {}, input, status: 'running', steps: [], cursor: 0, holds: { locks: [], slots: [] }, activeKey: 'k', context: {},
    by: 'ops@example.com', createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
  });
  const operations: OperationsApi = {
    async create(type, input, by) {
      if (conflict) throw Object.assign(new Error(`another operation is running on this target: ${conflict}`), { operationId: conflict, name: 'Conflict' });
      created.push([type, input, by]);
      // As the engine's: the target names the account and region when the input does.
      return { ...operation(type, input), target: (typeof input.account === 'string' ? { account: input.account, region: input.region as string } : {}) as Operation['target'] };
    },
    list: async () => listed ?? [operation('onboard', {})],
    get: async (id) => (listed ? listed.find((op) => op.id === id) ?? null : id === 'op1' ? operation('onboard', {}) : null),
    installedRouters: async () => installed,
  };
  const api = createApi({
    routers: [{ name: 'dmt-dev', region: 'eu-west-1', controller: 'dmt-dev-controller', account: MANAGER }],
    managerAccount: MANAGER,
    invoke: async (router, payload) => {
      calls.push([router.name, payload]);
      if (payload.action === 'router') return { router: { version: answers, build: 'b' }, pauses: [], workloads: { total: 0, byState: {}, paused: 0, lastActivityAt: null }, health: { status: 'ok', problems: [], checkSchedule: null, lastScheduledCheckAt: null } };
      throw new RouterError('unexpected');
    },
    audit: { write: async (e) => { audit.push(e); }, list: async () => audit },
    now: () => NOW, newId: () => 'id-1', version: '0.2.0', routerVersion: '0.18.0',
    discovery: { store: memoryStore([candidate(TG, { targetGroupArn: TG, region: 'eu-west-3' })]), run: async () => {} },
    operations,
    ...(visible ? { visible } : {}),
    ...(summaries ? { fleet: { listRouters: async () => summaries, listWorkloads: async () => [], getWorkload: async () => null } } : {}),
  });
  return { api, audit, created, calls, operation };
}

function event(method: string, path: string, groups = 'dmt-viewer', body?: unknown): ApiEvent {
  return {
    rawPath: path,
    requestContext: { http: { method }, authorizer: { jwt: { claims: { sub: 'u-1', email: 'ops@example.com', 'cognito:groups': `[${groups}]` } } } },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}
const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');
const installedParis: InstalledRouter = {
  name: 'dmt-dev', account: MANAGER, region: 'eu-west-3', controller: `arn:aws:lambda:eu-west-3:${MANAGER}:function:dmt-dev-controller`, onboarder: `arn:aws:lambda:eu-west-3:${MANAGER}:function:dmt-dev-onboarder`,
  version: '0.18.0', build: 'b', installedBy: 'admin@example.com', installedAt: '2026-10-05T11:00:00.000Z',
};

describe('operations', () => {
  it('onboards a candidate for operators: 202 with the operation, audited', async () => {
    const { api, created, audit } = setup();
    expect((await api(event('POST', '/api/operations', 'dmt-viewer', { type: 'onboard', candidateId: TG }))).statusCode).toBe(403);
    // A name for people (optional, the target group name by default); the router derives the workload id.
    const res = await api(event('POST', '/api/operations', 'dmt-operator', { type: 'onboard', candidateId: TG, name: '  Paris (demo) ', settings: { idleMinutes: 30, wakeMode: 'browser' } }));
    expect(res.statusCode).toBe(202);
    expect(json(res).operation.id).toBe('op1');
    expect(created).toEqual([['onboard', { candidateId: TG, name: 'Paris (demo)', settings: { idleMinutes: 30, wakeMode: 'browser' }, databases: [] }, 'ops@example.com']]);
    expect(audit.at(-1)).toMatchObject({ action: 'operation-onboard', target: `${TG} as Paris (demo)`, result: 'started op1' });
    await api(event('POST', '/api/operations', 'dmt-operator', { type: 'onboard', candidateId: TG, workloadId: 'ignored' }));
    expect(created.at(-1)![1]).toEqual({ candidateId: TG, settings: {}, databases: [] });
    expect(audit.at(-1)).toMatchObject({ target: TG });
  });

  it('refuses an invalid name, an unknown candidate and a wrong settings type', async () => {
    const { api, created } = setup();
    for (const body of [
      { type: 'onboard', candidateId: TG, name: 'x'.repeat(65) },
      { type: 'onboard', candidateId: TG, name: 42 },
      { type: 'onboard', candidateId: TG, name: 'a\u0007b' },
      { type: 'onboard', candidateId: 'arn:nope' },
      { type: 'onboard', candidateId: TG, settings: 'fast' },
      { type: 'unknown' },
    ]) expect((await api(event('POST', '/api/operations', 'dmt-operator', body))).statusCode).toBe(400);
    expect(created).toEqual([]);
  });

  it('passes fallback instance types and the failed-retry delay, and refuses bad ones with their message (R7b)', async () => {
    const { api, created } = setup();
    const ok = await api(event('POST', '/api/operations', 'dmt-operator', { type: 'onboard', candidateId: TG, settings: { fallbackInstanceTypes: ['t3a.medium', 'm6i.large'], failedRetrySeconds: 120 } }));
    expect(ok.statusCode).toBe(202);
    expect(created.at(-1)![1]).toMatchObject({ settings: { fallbackInstanceTypes: ['t3a.medium', 'm6i.large'], failedRetrySeconds: 120 } });
    for (const [settings, message] of [
      [{ fallbackInstanceTypes: ['t3a medium'] }, /fallbackInstanceTypes: must be a list of at most 5 EC2 instance types/],
      [{ fallbackInstanceTypes: ['t3.small', 't3.medium', 't3.large', 't3a.small', 't3a.medium', 't3a.large'] }, /at most 5/],
      [{ fallbackInstanceTypes: 't3.small' }, /fallbackInstanceTypes/],
      [{ failedRetrySeconds: 5 }, /failedRetrySeconds: must be a whole number from 10 to 600/],
      [{ failedRetrySeconds: '60' }, /failedRetrySeconds/],
    ] as const) {
      const res = await api(event('POST', '/api/operations', 'dmt-operator', { type: 'onboard', candidateId: TG, settings }));
      expect(res.statusCode).toBe(400);
      expect(json(res).message).toMatch(message);
    }
    expect(created).toHaveLength(1);
  });

  it('passes a boolean hibernate with the onboarding settings and refuses another value', async () => {
    const { api, created } = setup();
    const ok = await api(event('POST', '/api/operations', 'dmt-operator', { type: 'onboard', candidateId: TG, settings: { hibernate: false } }));
    expect(ok.statusCode).toBe(202);
    expect(created.at(-1)![1]).toMatchObject({ settings: { hibernate: false } });
    const res = await api(event('POST', '/api/operations', 'dmt-operator', { type: 'onboard', candidateId: TG, settings: { hibernate: 'x' } }));
    expect(res.statusCode).toBe(400);
    expect(json(res).message).toBe('settings: hibernate must be true or false');
    expect(created).toHaveLength(1);
  });

  it('refuses Hibernate up front on a router before 0.32.0 (409), whatever it reports or answers; lets it through elsewhere', async () => {
    const hibernate = { type: 'onboard', candidateId: TG, settings: { hibernate: true } };
    const old = setup({ installed: [installedParis] });
    const res = await old.api(event('POST', '/api/operations', 'dmt-operator', hibernate));
    expect([res.statusCode, json(res)]).toEqual([409, { error: 'conflict', message: 'router dmt-dev-eu-west-3 is older than 0.32.0: upgrade it to onboard with Hibernate' }]);
    expect(old.created).toEqual([]);
    // Without hibernate, the router is not asked.
    expect((await old.api(event('POST', '/api/operations', 'dmt-operator', { type: 'onboard', candidateId: TG, settings: { idleMinutes: 30 } }))).statusCode).toBe(202);
    expect(old.calls).toHaveLength(1);
    // A router that reports: the version of its last report, without a call.
    const summary = { account: MANAGER, region: 'eu-west-3', name: 'dmt-dev', version: '0.31.0', build: 'b', checkSchedule: 'rate(5 minutes)', checkedAt: new Date(NOW - 60_000).toISOString(), durationMs: 1, health: null, pauses: [], counts: {}, check: { checkedAt: new Date(NOW - 60_000).toISOString(), total: 1, received: [0] } };
    const reporting = setup({ installed: [installedParis], answers: '0.32.0', summaries: [summary] });
    expect((await reporting.api(event('POST', '/api/operations', 'dmt-operator', hibernate))).statusCode).toBe(409);
    expect(reporting.calls).toEqual([]);
    for (const ok of [setup({ installed: [installedParis], answers: '0.32.0' }), setup({ installed: [installedParis], answers: '0.32.0-dev.1' }), setup()]) {
      expect((await ok.api(event('POST', '/api/operations', 'dmt-operator', hibernate))).statusCode).toBe(202);
      expect(ok.created.at(-1)![1]).toMatchObject({ settings: { hibernate: true } });
    }
  });

  it('a second operation on the same target answers 409 with the running one', async () => {
    const { api } = setup({ conflict: 'op0' });
    const res = await api(event('POST', '/api/operations', 'dmt-operator', { type: 'onboard', candidateId: TG, workloadId: 'paris' }));
    expect(res.statusCode).toBe(409);
    expect(json(res)).toEqual({ error: 'conflict', message: 'another operation is running on this target: op0', operationId: 'op0' });
  });

  it('offboards a workload of a router by its name; installs, upgrades and uninstalls routers for administrators only', async () => {
    const { api, created } = setup({ installed: [installedParis] });
    expect((await api(event('POST', '/api/operations', 'dmt-operator', { type: 'offboard', router: 'dmt-dev-eu-west-3', workloadId: 'paris' }))).statusCode).toBe(202);
    expect(created.at(-1)).toEqual(['offboard', { router: 'dmt-dev-eu-west-3', account: MANAGER, region: 'eu-west-3', workloadId: 'paris' }, 'ops@example.com']);
    // A name in the request is ignored: the workflow takes it from the router.
    expect((await api(event('POST', '/api/operations', 'dmt-operator', { type: 'offboard', router: 'dmt-dev-eu-west-3', workloadId: '7010ea54b5c02245', name: 'Not checked' }))).statusCode).toBe(202);
    expect(created.at(-1)![1]).toEqual({ router: 'dmt-dev-eu-west-3', account: MANAGER, region: 'eu-west-3', workloadId: '7010ea54b5c02245' });
    expect((await api(event('POST', '/api/operations', 'dmt-operator', { type: 'install-router', account: MANAGER, region: 'eu-west-2' }))).statusCode).toBe(403);
    expect((await api(event('POST', '/api/operations', 'dmt-admin', { type: 'install-router', account: MANAGER, region: 'eu-west-2' }))).statusCode).toBe(202);
    expect(created.at(-1)).toEqual(['install-router', { account: MANAGER, region: 'eu-west-2' }, 'ops@example.com']);
    expect((await api(event('POST', '/api/operations', 'dmt-admin', { type: 'upgrade-router', router: 'dmt-dev-eu-west-3' }))).statusCode).toBe(202);
    expect(created.at(-1)).toEqual(['upgrade-router', { account: MANAGER, region: 'eu-west-3' }, 'ops@example.com']);
    expect((await api(event('POST', '/api/operations', 'dmt-admin', { type: 'install-router', account: '12', region: 'eu-west-2' }))).statusCode).toBe(400);
    expect((await api(event('POST', '/api/operations', 'dmt-admin', { type: 'uninstall-router', router: 'nope' }))).statusCode).toBe(404);
  });

  it('lists operations to viewers and reads one', async () => {
    const { api } = setup();
    expect(json(await api(event('GET', '/api/operations'))).operations.map((o: Operation) => o.id)).toEqual(['op1']);
    expect(json(await api(event('GET', '/api/operations/op1'))).id).toBe('op1');
    expect((await api(event('GET', '/api/operations/nope'))).statusCode).toBe(404);
  });

  it('says the cloud of each operation\'s account in its target: gcp for a project, aws for an account, none for a record without one', async () => {
    const op = setup().operation;
    const aws = { ...op('onboard', {}), id: 'op-aws', target: { account: MANAGER, region: 'eu-west-3', targetGroupArn: TG } };
    const gcp = { ...op('onboard', {}), id: 'op-gcp', target: { account: 'dormeto-dev', region: 'europe-west1', backendService: 'projects/dormeto-dev/global/backendServices/web' } };
    const bare = { ...op('onboard', {}), id: 'op-bare', target: {} };
    const s = setup({ listed: [aws, gcp, bare] });
    const listed = json(await s.api(event('GET', '/api/operations', 'dmt-admin'))).operations as Operation[];
    expect(listed.map((o) => [o.id, (o.target as { cloud?: string }).cloud])).toEqual([['op-aws', 'aws'], ['op-gcp', 'gcp'], ['op-bare', undefined]]);
    expect(json(await s.api(event('GET', '/api/operations/op-gcp', 'dmt-admin'))).target).toMatchObject({ account: 'dormeto-dev', cloud: 'gcp' });
  });

  it('the 202 answer of a started operation says its target\'s cloud, as the list does', async () => {
    const { api } = setup();
    const res = await api(event('POST', '/api/operations', 'dmt-admin', { type: 'install-router', account: MANAGER, region: 'eu-west-2' }));
    expect([res.statusCode, json(res).operation.target]).toEqual([202, { account: MANAGER, region: 'eu-west-2', cloud: 'aws' }]);
  });

  it('refuses an AWS onboarding\'s database of another kind or shape, in one message form, and starts nothing; RDS instances and clusters go through', async () => {
    const s = setup();
    const form = 'is not an RDS instance or cluster: give {"kind": "rds-instance" or "rds-cluster", "id": "<identifier>"}';
    for (const databases of [[{ kind: 'cloudsql-instance', id: 'db-1' }], ['db-1'], [{ kind: 'rds-instance' }], [{ kind: 'rds-cluster', id: '' }], [{ kind: 'rds', id: 'db-1' }], [null]]) {
      const res = await s.api(event('POST', '/api/operations', 'dmt-operator', { type: 'onboard', candidateId: TG, databases }));
      expect([res.statusCode, json(res).error], JSON.stringify(databases)).toEqual([400, 'bad_request']);
      expect(json(res).message).toBe(`databases: ${JSON.stringify(databases[0])} ${form}`);
    }
    expect((await s.api(event('POST', '/api/operations', 'dmt-operator', { type: 'onboard', candidateId: TG, databases: 'db-1' }))).statusCode).toBe(400);
    expect(s.created).toEqual([]);
    // Each form the onboarder takes (onboarding.mjs databasesOf; the dashboard's and the CLI's {kind, id}; a kind-less entry is an instance).
    for (const ok of [[{ kind: 'rds-instance', id: 'db-1' }], [{ kind: 'rds-cluster', id: 'aurora-1' }], [{ id: 'db-1' }], [{ kind: 'rds-instance', id: 'db-1' }, { kind: 'rds-cluster', id: 'aurora-1' }]]) {
      expect((await s.api(event('POST', '/api/operations', 'dmt-operator', { type: 'onboard', candidateId: TG, databases: ok }))).statusCode, JSON.stringify(ok)).toBe(202);
      expect(s.created.at(-1)![1]).toMatchObject({ databases: ok });
    }
  });

  it('lists and reads the manager\'s update operations for administrators only, whatever the perimeter', async () => {
    const op = setup().operation;
    const onboard = { ...op('onboard', {}), target: { account: MANAGER, region: 'eu-west-3' } };
    const update = { ...op('update-manager', { action: 'plan', version: '0.12.0', request: 'r' }), id: 'op-u', target: { account: MANAGER, region: 'eu-west-1', version: '0.12.0' } };
    const all = setup({ listed: [update, onboard] });
    for (const group of ['dmt-viewer', 'dmt-operator']) {
      expect(json(await all.api(event('GET', '/api/operations', group))).operations.map((o: Operation) => o.id)).toEqual(['op1']);
      expect((await all.api(event('GET', '/api/operations/op-u', group))).statusCode).toBe(404);
    }
    expect(json(await all.api(event('GET', '/api/operations', 'dmt-admin'))).operations.map((o: Operation) => o.id)).toEqual(['op-u', 'op1']);
    expect(json(await all.api(event('GET', '/api/operations/op-u', 'dmt-admin'))).id).toBe('op-u');
    // A perimeter that leaves out the manager's account and region: still the administrators' only.
    const none = setup({ listed: [update, onboard], visible: () => false });
    expect(json(await none.api(event('GET', '/api/operations', 'dmt-admin'))).operations.map((o: Operation) => o.id)).toEqual(['op-u']);
    expect((await none.api(event('GET', '/api/operations/op-u', 'dmt-admin'))).statusCode).toBe(200);
    expect(json(await none.api(event('GET', '/api/operations', 'dmt-operator'))).operations).toEqual([]);
  });

  it('starts no manager update from the operations route', async () => {
    const { api, created } = setup();
    expect((await api(event('POST', '/api/operations', 'dmt-admin', { type: 'update-manager', version: '0.12.0' }))).statusCode).toBe(400);
    expect(created).toEqual([]);
  });

  it('lists installed routers with the Terraform ones, each under a unique name, and operates them', async () => {
    const { api, calls } = setup({ installed: [installedParis, { ...installedParis, account: '038606077307' }, { ...installedParis, region: 'eu-west-1' }] });
    const { routers } = json(await api(event('GET', '/api/routers')));
    expect(routers.map((r: { name: string; region: string; source: string }) => [r.name, r.region, r.source])).toEqual([
      ['dmt-dev', 'eu-west-1', 'terraform'], ['dmt-dev-eu-west-3', 'eu-west-3', 'manager'], ['dmt-dev-038606077307-eu-west-3', 'eu-west-3', 'manager'],
    ]);
    expect(calls.map(([name]) => name).sort()).toEqual(['dmt-dev', 'dmt-dev-038606077307-eu-west-3', 'dmt-dev-eu-west-3']);
  });
});

describe('onboarding on Google Cloud', () => {
  const PROJECT = 'dormeto-dev';
  const NUMBER = '1034397096264';
  const SERVICE = `projects/${PROJECT}/global/backendServices/dmt-demo-app`;
  const MAP = `projects/${PROJECT}/global/urlMaps/dmt-dev`;
  const INTERNAL = `projects/${PROJECT}/regions/europe-west2/backendServices/dmt-int-app`;
  const INTERNAL_MAP = `projects/${PROJECT}/regions/europe-west2/urlMaps/dmt-int`;
  const READ = `https://cloudresourcemanager.googleapis.com/v3/projects/${PROJECT}`;
  const registered = (region: string, version = '0.40.0'): InstalledRouter => ({
    name: `dmtr-${region}`, account: PROJECT, region, controller: `https://dmtr-${region}-controller-abc123-nw.a.run.app`, onboarder: '', version, build: '', installedBy: 'cli', cloud: 'gcp',
    installedAt: '2026-11-09T10:00:00.000Z',
  });
  const google = (over: Partial<Candidate>): Partial<Candidate> => ({ account: PROJECT, targetGroupArn: null, loadBalancerArn: '', listener: '', priority: '', rules: [], ...over });

  // The operations engine creates the operation (its target), as the API's handler wires it; the project's number answered
  // by Resource Manager, or `refused`.
  async function googleSetup({ installed = [registered('europe-west2'), registered('us-central1')], refused = null as Error | null } = {}) {
    const { createEngine, createRecords } = await import('@dormeto/operations');
    const { fakeDynamo } = await import('../../operations/test/dynamo-fake.js');
    const store = memoryStore([
      candidate(SERVICE, google({ region: 'global', loadBalancer: 'dmt-dev', targetGroup: 'dmt-demo-app', backendService: SERVICE, urlMap: MAP, lb: { kind: 'global' } })),
      candidate(INTERNAL, google({ region: 'europe-west2', loadBalancer: 'dmt-int', targetGroup: 'dmt-int-app', backendService: INTERNAL, urlMap: INTERNAL_MAP, lb: { kind: 'internal' } })),
      candidate(TG, { targetGroupArn: TG, region: 'eu-west-3' }),
    ]);
    let ids = 0;
    const engine = createEngine({
      records: createRecords({ dynamo: fakeDynamo(), table: 't', now: () => NOW }), discovery: store, routers: async () => [],
      target: async () => { throw new Error('no AWS call at creation'); }, bundle: async () => { throw new Error('no bundle at creation'); },
      settings: { env: 'dev', principals: [], routerSettings: { checkSchedule: '', ipLists: '', ipListsCatalog: '', ipListsBucket: '', noWakeRules: '', metrics: '', managerBus: '', commandRole: '' } },
      start: async (op) => `arn:execution:${op.id}`, now: () => NOW, newId: () => `op${++ids}`, log: { info() {}, warn() {}, error() {} },
    });
    const created: [string, Record<string, unknown>][] = [];
    const reads: string[][] = [];
    const calls: string[] = [];
    const audit: AuditEntry[] = [];
    const api = createApi({
      routers: [{ name: 'dmt-dev', region: 'eu-west-1', controller: 'dmt-dev-controller', account: MANAGER }],
      managerAccount: MANAGER,
      invoke: async (router) => { calls.push(router.name); throw new RouterError('unexpected'); },
      audit: { write: async (e) => { audit.push(e); }, list: async () => audit },
      now: () => NOW, newId: () => 'id-1', version: '0.2.0', routerVersion: '0.40.0',
      discovery: { store, run: async () => {} },
      google: {
        get: async () => null, put: async () => {}, delete: async () => {}, routers: { list: async () => installed, put: async () => {}, delete: async () => {} },
        call: async <T>(sa: string, method: string, url: string) => {
          reads.push([sa, method, url]);
          if (refused) throw refused;
          return { name: `projects/${NUMBER}`, projectId: PROJECT } as T;
        },
      },
      operations: {
        create: async (type, input, by) => { created.push([type, input]); return engine.create(type, input, by); },
        list: async () => [], get: async () => null, installedRouters: async () => installed,
      },
    });
    return { api, created, reads, calls, audit };
  }
  const onboard = (body: Record<string, unknown>) => event('POST', '/api/operations', 'dmt-operator', { type: 'onboard', ...body });

  it('a global candidate of a project with two routers is onboarded on the router the body names, its target the project\'s, the router\'s region and the project number', async () => {
    const s = await googleSetup();
    const unnamed = await s.api(onboard({ candidateId: SERVICE }));
    expect([unnamed.statusCode, json(unnamed)]).toEqual([400, {
      error: 'bad_request', message: `project ${PROJECT} has 2 routers: name the one to onboard on in router (dmtr-${PROJECT}-europe-west2, dmtr-${PROJECT}-us-central1)`,
    }]);
    const body = {
      candidateId: SERVICE, router: `dmtr-${PROJECT}-us-central1`, name: 'Demo', settings: { fallbackInstanceTypes: ['e2-medium', 'n2-standard-2'], hibernate: true },
      databases: [{ kind: 'cloudsql-instance', id: 'db-1' }], tags: { team: 'web' },
    };
    // Tags at onboarding are the administrators'.
    const operator = await s.api(onboard(body));
    expect([operator.statusCode, json(operator).message]).toEqual([403, 'admin role required to set tags at onboarding']);
    const res = await s.api(event('POST', '/api/operations', 'dmt-admin', { type: 'onboard', ...body }));
    expect(res.statusCode).toBe(202);
    expect(s.created).toEqual([['onboard', {
      candidateId: SERVICE, router: `dmtr-${PROJECT}-us-central1`, region: 'us-central1', projectNumber: NUMBER, name: 'Demo',
      settings: { fallbackInstanceTypes: ['e2-medium', 'n2-standard-2'], hibernate: true }, databases: [{ kind: 'cloudsql-instance', id: 'db-1' }], tags: { team: 'web' },
    }]]);
    const { operation } = json(res);
    expect(operation.target).toEqual({ account: PROJECT, cloud: 'gcp', region: 'us-central1', router: `dmtr-${PROJECT}-us-central1`, backendService: SERVICE, urlMap: MAP, projectNumber: NUMBER });
    expect(operation.activeKey).toBe(`TG#${SERVICE}`);
    expect(operation.steps.map((x: { name: string }) => x.name)).toEqual(['find router', 'slot', 'lock load balancer', 'preview', 'tag', 'onboard', 'verify', 'candidate']);
    // The project's number read once, as the discovery account; no router called (Hibernate needs no version check there).
    expect(s.reads).toEqual([['discovery', 'GET', READ]]);
    expect(s.calls).toEqual([]);
    expect(s.audit.at(-1)).toMatchObject({ action: 'operation-onboard', target: `${SERVICE} as Demo`, result: 'started op1' });
  });

  it('a project\'s only router takes its global candidates, and a regional candidate goes to the router of its region', async () => {
    const one = await googleSetup({ installed: [registered('us-central1')] });
    expect((await one.api(onboard({ candidateId: SERVICE }))).statusCode).toBe(202);
    expect(one.created.at(-1)![1]).toMatchObject({ router: `dmtr-${PROJECT}-us-central1`, region: 'us-central1' });
    const two = await googleSetup();
    expect((await two.api(onboard({ candidateId: INTERNAL }))).statusCode).toBe(202);
    expect(two.created.at(-1)![1]).toMatchObject({ router: `dmtr-${PROJECT}-europe-west2`, region: 'europe-west2' });
    const elsewhere = await two.api(onboard({ candidateId: INTERNAL, router: `dmtr-${PROJECT}-us-central1` }));
    expect([elsewhere.statusCode, json(elsewhere).message]).toEqual([400, 'router: a regional load balancer is onboarded on the router of its region, europe-west2']);
    const unknown = await two.api(onboard({ candidateId: SERVICE, router: 'dmt-dev' }));
    expect([unknown.statusCode, json(unknown).message]).toEqual([400, `router: "dmt-dev" is not a router of project ${PROJECT} (dmtr-${PROJECT}-europe-west2, dmtr-${PROJECT}-us-central1)`]);
    expect(two.created).toHaveLength(1);
  });

  it('a project without a router there answers 400 with the command that installs one; a router before 0.40.0, 409 with the router_too_old text', async () => {
    const none = await googleSetup({ installed: [] });
    const global = await none.api(onboard({ candidateId: SERVICE }));
    expect([global.statusCode, json(global)]).toEqual([400, { error: 'bad_request', message: `no router in project ${PROJECT}: dormeto gcp routers install --project ${PROJECT} --region <region> --version 0.40.0` }]);
    const other = await googleSetup({ installed: [registered('us-central1')] });
    const regional = await other.api(onboard({ candidateId: INTERNAL }));
    expect([regional.statusCode, json(regional).message]).toEqual([400, `no router in project ${PROJECT}, region europe-west2: dormeto gcp routers install --project ${PROJECT} --region europe-west2 --version 0.40.0`]);
    const old = await googleSetup({ installed: [registered('europe-west2', '0.39.2')] });
    const tooOld = await old.api(onboard({ candidateId: INTERNAL }));
    expect([tooOld.statusCode, json(tooOld)]).toEqual([409, { error: 'router_too_old', message: `router 0.39.2 can't report to the manager: dormeto gcp routers install --project ${PROJECT} --region europe-west2 --version 0.40.0` }]);
    expect([...none.created, ...other.created, ...old.created, ...none.reads, ...other.reads, ...old.reads]).toEqual([]);
  });

  it('takes Compute Engine machine types as fallback types and Cloud SQL instances as databases, refusing an EC2 type and another database', async () => {
    const s = await googleSetup({ installed: [registered('europe-west2')] });
    for (const [body, message] of [
      [{ settings: { fallbackInstanceTypes: ['t3a.medium'] } }, 'settings: fallbackInstanceTypes: "t3a.medium" is not a machine type name'],
      [{ settings: { fallbackInstanceTypes: 'e2-medium' } }, 'settings: fallbackInstanceTypes: must be a list of at most 5 machine types, such as e2-medium'],
      [{ settings: { fallbackInstanceTypes: ['e2-small', 'e2-medium', 'e2-standard-2', 'n2-standard-2', 'n2d-standard-2', 'c3-standard-4'] } }, /fallbackInstanceTypes: must be a list of at most 5 machine types, such as e2-medium/],
      [{ settings: { fallbackInstanceTypes: ['e2-medium', 'e2-medium'] } }, 'settings: fallbackInstanceTypes: e2-medium is named twice'],
      [{ databases: [{ kind: 'rds-instance', id: 'db-1' }] }, 'databases: {"kind":"rds-instance","id":"db-1"} is not a Cloud SQL instance: give {"kind": "cloudsql-instance", "id": "<instance name>"}'],
      [{ databases: ['db-1'] }, /is not a Cloud SQL instance/],
      [{ databases: [{ kind: 'cloudsql-instance', id: 'DB_1' }] }, /is not a Cloud SQL instance/],
      [{ databases: [{ kind: 'cloudsql-instance', id: 'db-1' }, { kind: 'cloudsql-instance', id: 'db-1' }] }, 'databases: Cloud SQL instance db-1 is named twice'],
    ] as const) {
      const res = await s.api(onboard({ candidateId: SERVICE, ...body }));
      expect(res.statusCode).toBe(400);
      expect(json(res).message).toMatch(message);
    }
    expect(s.created).toEqual([]);
    // One message form on both clouds: each names the other's kind as wrong and gives its own.
    const wrong = await s.api(onboard({ candidateId: SERVICE, databases: [{ kind: 'rds-cluster', id: 'aurora-1' }] }));
    expect([wrong.statusCode, json(wrong).error, json(wrong).message]).toEqual([400, 'bad_request', 'databases: {"kind":"rds-cluster","id":"aurora-1"} is not a Cloud SQL instance: give {"kind": "cloudsql-instance", "id": "<instance name>"}']);
    expect((await s.api(onboard({ candidateId: SERVICE, settings: { fallbackInstanceTypes: ['e2-medium'] }, databases: [{ kind: 'cloudsql-instance', id: 'db-1' }] }))).statusCode).toBe(202);
  });

  it('a project number Google refuses to read answers 502 with Google\'s words, and starts nothing', async () => {
    const { GoogleError } = await import('@dormeto/google');
    const s = await googleSetup({ refused: new GoogleError({ status: 403, reason: 'IAM_PERMISSION_DENIED', host: 'cloudresourcemanager.googleapis.com', message: 'Permission \'resourcemanager.projects.get\' denied' }) });
    const res = await s.api(onboard({ candidateId: INTERNAL }));
    expect([res.statusCode, json(res)]).toEqual([502, {
      error: 'google_error',
      message: `project ${PROJECT}: its number can't be read as the discovery account (Google: cloudresourcemanager.googleapis.com 403 IAM_PERMISSION_DENIED: Permission 'resourcemanager.projects.get' denied)`,
    }]);
    expect(s.created).toEqual([]);
  });

  it('offboards a workload of a Google Cloud router: its project, the router\'s region and the project\'s number in the target, the Google Cloud plan; a number Google refuses to read starts nothing', async () => {
    const s = await googleSetup();
    const res = await s.api(event('POST', '/api/operations', 'dmt-operator', { type: 'offboard', router: `dmtr-${PROJECT}-europe-west2`, workloadId: 'dmt-demo-app' }));
    expect(res.statusCode).toBe(202);
    const { operation } = json(res);
    expect(operation.target).toEqual({ account: PROJECT, cloud: 'gcp', region: 'europe-west2', router: `dmtr-${PROJECT}-europe-west2`, workloadId: 'dmt-demo-app', projectNumber: NUMBER });
    expect(operation.activeKey).toBe(`WL#${PROJECT}#europe-west2#dmt-demo-app`);
    expect(operation.steps.map((x: { name: string }) => x.name)).toEqual(['locate', 'slot', 'lock load balancer', 'pause', 'wait awake', 'offboard', 'untag', 'candidate']);
    expect(s.reads).toEqual([['discovery', 'GET', READ]]);
    expect(s.calls).toEqual([]);
    expect(s.audit.at(-1)).toMatchObject({ action: 'operation-offboard', target: `dmtr-${PROJECT}-europe-west2/dmt-demo-app`, result: 'started op1' });
    const { GoogleError } = await import('@dormeto/google');
    const refused = await googleSetup({ refused: new GoogleError({ status: 403, reason: 'IAM_PERMISSION_DENIED', host: 'cloudresourcemanager.googleapis.com', message: 'Permission \'resourcemanager.projects.get\' denied' }) });
    const unread = await refused.api(event('POST', '/api/operations', 'dmt-operator', { type: 'offboard', router: `dmtr-${PROJECT}-europe-west2`, workloadId: 'dmt-demo-app' }));
    expect([unread.statusCode, json(unread).error]).toEqual([502, 'google_error']);
    expect(refused.created).toEqual([]);
  });

  it('an AWS onboarding beside Google Cloud routers keeps its body and its target', async () => {
    const s = await googleSetup();
    const res = await s.api(onboard({ candidateId: TG, router: `dmtr-${PROJECT}-europe-west2`, settings: { fallbackInstanceTypes: ['t3a.medium'] } }));
    expect(res.statusCode).toBe(202);
    expect(s.created).toEqual([['onboard', { candidateId: TG, settings: { fallbackInstanceTypes: ['t3a.medium'] }, databases: [] }]]);
    expect(json(res).operation.target).toEqual({ account: MANAGER, cloud: 'aws', region: 'eu-west-3', targetGroupArn: TG, loadBalancerArn: 'lb' });
    expect(json(res).operation.steps.map((x: { name: string }) => x.name)).toContain('install roles');
    expect(s.reads).toEqual([]);
    const ec2 = await s.api(onboard({ candidateId: TG, settings: { fallbackInstanceTypes: ['e2-medium'] } }));
    expect([ec2.statusCode, json(ec2).message]).toEqual([400, 'settings: fallbackInstanceTypes: must be a list of at most 5 EC2 instance types, such as t3a.medium']);
  });
});

describe('router version', () => {
  it('gives the router version the manager installs, the available upgrade', async () => {
    const { api } = setup();
    expect(json(await api(event('GET', '/api/routers'))).available).toEqual({ version: '0.18.0' });
  });
});
