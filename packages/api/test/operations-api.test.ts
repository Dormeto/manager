import { describe, expect, it } from 'vitest';
import type { InstalledRouter, Operation } from '@dormeto/operations';
import { createApi, RouterError, type ApiEvent, type AuditEntry, type OperationsApi } from '../src/api.js';
import { candidate, memoryStore } from './memory-store.js';

const NOW = Date.UTC(2026, 9, 5, 12, 0);
const MANAGER = '121014831971';
const TG = `arn:aws:elasticloadbalancing:eu-west-3:${MANAGER}:targetgroup/paris-app/73e2d6bc24d8a067`;

function setup({ installed = [] as InstalledRouter[], conflict = null as string | null } = {}) {
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
      return operation(type, input);
    },
    list: async () => [operation('onboard', {})],
    get: async (id) => (id === 'op1' ? operation('onboard', {}) : null),
    installedRouters: async () => installed,
  };
  const api = createApi({
    routers: [{ name: 'dmt-dev', region: 'eu-west-1', controller: 'dmt-dev-controller', account: MANAGER }],
    managerAccount: MANAGER,
    invoke: async (router, payload) => {
      calls.push([router.name, payload]);
      if (payload.action === 'router') return { router: { version: '0.18.0', build: 'b' }, pauses: [], workloads: { total: 0, byState: {}, paused: 0, lastActivityAt: null }, health: { status: 'ok', problems: [], checkSchedule: null, lastScheduledCheckAt: null } };
      throw new RouterError('unexpected');
    },
    audit: { write: async (e) => { audit.push(e); }, list: async () => audit },
    now: () => NOW, newId: () => 'id-1', version: '0.2.0',
    discovery: { store: memoryStore([candidate(TG, { targetGroupArn: TG, region: 'eu-west-3' })]), run: async () => {} },
    operations,
  });
  return { api, audit, created, calls };
}

function event(method: string, path: string, groups = '', body?: unknown): ApiEvent {
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
    expect((await api(event('POST', '/api/operations', 'dmt-viewer', { type: 'onboard', candidateId: TG, workloadId: 'paris' }))).statusCode).toBe(403);
    const res = await api(event('POST', '/api/operations', 'dmt-operator', { type: 'onboard', candidateId: TG, workloadId: 'paris', settings: { idleMinutes: 30, wakeMode: 'browser' } }));
    expect(res.statusCode).toBe(202);
    expect(json(res).operation.id).toBe('op1');
    expect(created).toEqual([['onboard', { candidateId: TG, workloadId: 'paris', settings: { idleMinutes: 30, wakeMode: 'browser' }, databases: [] }, 'ops@example.com']]);
    expect(audit.at(-1)).toMatchObject({ action: 'operation-onboard', target: `${TG} as paris`, result: 'started op1' });
  });

  it('refuses an invalid workload id, an unknown candidate and a wrong settings type', async () => {
    const { api, created } = setup();
    for (const body of [
      { type: 'onboard', candidateId: TG, workloadId: 'Paris_1' },
      { type: 'onboard', candidateId: 'arn:nope', workloadId: 'paris' },
      { type: 'onboard', candidateId: TG, workloadId: 'paris', settings: 'fast' },
      { type: 'unknown' },
    ]) expect((await api(event('POST', '/api/operations', 'dmt-operator', body))).statusCode).toBe(400);
    expect(created).toEqual([]);
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

  it('lists installed routers with the Terraform ones, each under a unique name, and operates them', async () => {
    const { api, calls } = setup({ installed: [installedParis, { ...installedParis, account: '038606077307' }, { ...installedParis, region: 'eu-west-1' }] });
    const { routers } = json(await api(event('GET', '/api/routers')));
    expect(routers.map((r: { name: string; region: string; source: string }) => [r.name, r.region, r.source])).toEqual([
      ['dmt-dev', 'eu-west-1', 'terraform'], ['dmt-dev-eu-west-3', 'eu-west-3', 'manager'], ['dmt-dev-038606077307-eu-west-3', 'eu-west-3', 'manager'],
    ]);
    expect(calls.map(([name]) => name).sort()).toEqual(['dmt-dev', 'dmt-dev-038606077307-eu-west-3', 'dmt-dev-eu-west-3']);
  });
});
