import { describe, expect, it } from 'vitest';
import type { Candidate, DiscoveryConfig, DiscoveryStore, OrgInventory, RunRecord, StoredConfig } from '@dormeto/discovery';
import { createApi, type ApiEvent, type AuditEntry } from '../src/api.js';

const NOW = Date.UTC(2026, 9, 4, 12, 0);

function memoryStore(candidates: Candidate[] = [], run: RunRecord | null = null): DiscoveryStore & { config: StoredConfig | null } {
  const items = new Map(candidates.map((c) => [c.id, c]));
  const store = {
    config: null as StoredConfig | null,
    async getConfig() { return store.config; },
    async putConfig(config: DiscoveryConfig, by: string) { store.config = { config, updatedAt: new Date(NOW).toISOString(), updatedBy: by }; },
    async acquireLock() { return true; },
    async releaseLock() {},
    async lastRun() { return run; },
    async putRun() {},
    async listCandidates() { return [...items.values()]; },
    async getCandidate(id: string) { return items.get(id) ?? null; },
    async putCandidates(list: Candidate[]) { for (const c of list) items.set(c.id, c); },
    async getInventory(): Promise<OrgInventory | null> { return { accounts: [{ id: '121014831971', name: 'dormeto', ouPath: ['r-1u0b'], tags: {} }], ous: { 'r-1u0b': { name: 'Root', parent: null } } }; },
    async putInventory() {},
  };
  return store;
}

const candidate = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  id, account: '121014831971', region: 'eu-west-1', loadBalancer: 'web', loadBalancerArn: 'lb', listener: 'HTTPS:443', priority: '10',
  conditions: 'host a.example.com', hosts: ['a.example.com'], targetGroup: 'a', targetGroupArn: 'tg', suggestedId: 'a',
  backend: { kind: 'instance', id: 'i-1' }, tags: {}, eligibility: 'eligible', idleHours7d: 160, requests7d: 3,
  accountName: 'dormeto', ouPath: ['r-1u0b'], scope: 'in', scopeReason: 'in scope: filter "a", include 1',
  status: 'pending-onboarding', statusReason: 'eligible: instance i-1', firstSeenAt: '2026-10-04T11:00:00.000Z', lastSeenAt: '2026-10-04T11:00:00.000Z',
  history: [{ at: '2026-10-04T11:00:00.000Z', status: 'pending-onboarding', reason: 'eligible: instance i-1' }],
  ...over,
});

const RUN: RunRecord = { startedAt: '2026-10-04T11:00:00.000Z', finishedAt: '2026-10-04T11:00:05.000Z', trigger: 'schedule', status: 'ok', targets: [], counts: { 'pending-onboarding': 2 }, lint: [] };

function setup(candidates = [candidate('r1'), candidate('r2', { region: 'eu-west-3', status: 'ineligible', statusReason: 'fixed response', eligibility: 'ineligible', backend: null })]) {
  const audit: AuditEntry[] = [];
  const runs: string[] = [];
  const store = memoryStore(candidates, RUN);
  const api = createApi({
    routers: [{ name: 'dmt-dev', region: 'eu-west-1', controller: 'dmt-dev-controller' }],
    invoke: async () => ({}),
    audit: { write: async (e) => { audit.push(e); }, list: async () => audit },
    now: () => NOW, newId: () => 'id-1', version: '0.1.0',
    discovery: { store, run: async (by) => { runs.push(by); } },
  });
  return { api, audit, runs, store };
}

function event(method: string, path: string, groups = '', body?: unknown, query?: Record<string, string>): ApiEvent {
  return {
    rawPath: path,
    requestContext: { http: { method }, authorizer: { jwt: { claims: { sub: 'u-1', email: 'ops@example.com', 'cognito:groups': `[${groups}]` } } } },
    ...(query ? { queryStringParameters: query } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}
const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');

const VALID: DiscoveryConfig = { version: 1, mode: 'organization', regions: ['eu-west-1'], refreshHours: 24, globalExcludes: [{ accountIds: ['038606077307'] }], filters: [{ name: 'test', include: [{ accountIds: ['121014831971', '038606077307'] }], exclude: [] }] };

describe('discovery routes', () => {
  it('lists the last run and the candidates to viewers, filtered by status, account and region', async () => {
    const { api } = setup();
    const all = json(await api(event('GET', '/api/discovery')));
    expect(all.lastRun.startedAt).toBe(RUN.startedAt);
    expect(all.candidates.map((c: Candidate) => c.id)).toEqual(['r1', 'r2']);
    expect(json(await api(event('GET', '/api/discovery', '', undefined, { status: 'pending-onboarding' }))).candidates.map((c: Candidate) => c.id)).toEqual(['r1']);
    expect(json(await api(event('GET', '/api/discovery', '', undefined, { region: 'eu-west-3', account: '121014831971' }))).candidates.map((c: Candidate) => c.id)).toEqual(['r2']);
  });

  it('runs discovery on demand for operators, audited', async () => {
    const { api, runs, audit } = setup();
    expect((await api(event('POST', '/api/discovery/run'))).statusCode).toBe(403);
    const res = await api(event('POST', '/api/discovery/run', 'dmt-operator'));
    expect(res.statusCode).toBe(202);
    expect(runs).toEqual(['ops@example.com']);
    expect(audit[0]).toMatchObject({ action: 'discovery-run', target: 'discovery', result: 'requested' });
  });

  it('returns the default configuration and its lint when none is saved', async () => {
    const { api } = setup();
    const body = json(await api(event('GET', '/api/discovery/config')));
    expect(body.config.filters).toEqual([]);
    expect(body.lint).toEqual([]);
  });

  it('saves a valid configuration for admins only, with its lint, audited', async () => {
    const { api, audit, store } = setup();
    expect((await api(event('PUT', '/api/discovery/config', 'dmt-operator', VALID))).statusCode).toBe(403);
    const res = await api(event('PUT', '/api/discovery/config', 'dmt-admin', VALID));
    expect(res.statusCode).toBe(200);
    expect(json(res).lint).toEqual([]);
    const shadowed = { ...VALID, filters: [{ name: 'website', include: [{ accountIds: ['038606077307'] }], exclude: [] }] };
    expect(json(await api(event('PUT', '/api/discovery/config', 'dmt-admin', shadowed))).lint.map((f: { code: string }) => f.code)).toEqual(['include-shadowed-by-global-exclude']);
    expect(store.config!.updatedBy).toBe('ops@example.com');
    expect(audit[0]).toMatchObject({ action: 'discovery-config', target: 'discovery', result: '1 filter, 1 global exclude, regions eu-west-1' });
  });

  it('refuses an invalid configuration with every error', async () => {
    const { api, store } = setup();
    const res = await api(event('PUT', '/api/discovery/config', 'dmt-admin', { ...VALID, refreshHours: 0, regions: ['nowhere'] }));
    expect(res.statusCode).toBe(400);
    expect(json(res).errors).toEqual(['regions: "nowhere" is not a region name', 'refreshHours: must be an integer from 1 to 168']);
    expect(store.config).toBeNull();
  });

  it('dismisses and restores candidates for operators, audited; unknown IDs are refused before any change', async () => {
    const { api, audit, store } = setup();
    expect((await api(event('POST', '/api/discovery/dismiss', 'dmt-operator', { ids: ['r1', 'nope'] }))).statusCode).toBe(404);
    expect((await store.getCandidate('r1'))!.status).toBe('pending-onboarding');
    const dismissed = await api(event('POST', '/api/discovery/dismiss', 'dmt-operator', { ids: ['r1'], note: 'legacy app' }));
    expect(dismissed.statusCode).toBe(200);
    expect((await store.getCandidate('r1'))!).toMatchObject({ status: 'dismissed', dismissed: { by: 'ops@example.com', note: 'legacy app' } });
    await api(event('POST', '/api/discovery/restore', 'dmt-operator', { ids: ['r1'] }));
    expect((await store.getCandidate('r1'))!.status).toBe('pending-onboarding');
    expect(audit.map((a) => [a.action, a.target])).toEqual([['discovery-dismiss', 'r1'], ['discovery-restore', 'r1']]);
    expect((await api(event('POST', '/api/discovery/dismiss', '', { ids: ['r1'] }))).statusCode).toBe(403);
    expect((await api(event('POST', '/api/discovery/dismiss', 'dmt-operator', { ids: [] }))).statusCode).toBe(400);
  });

  it('no longer serves the per-router discovery', async () => {
    const { api } = setup();
    expect((await api(event('GET', '/api/discovery/dmt-dev'))).statusCode).toBe(404);
  });
});
