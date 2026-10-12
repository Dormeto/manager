import { describe, expect, it } from 'vitest';
import type { Candidate, DiscoveryConfig, RunRecord } from '@dormeto/discovery';
import { createApi, type ApiEvent, type AuditEntry } from '../src/api.js';
import { NOW, candidate, memoryStore } from './memory-store.js';

const RUN: RunRecord = { startedAt: '2026-10-04T11:00:00.000Z', finishedAt: '2026-10-04T11:00:05.000Z', trigger: 'schedule', status: 'ok', targets: [], counts: { 'pending-onboarding': 2 }, lint: [] };

const R2 = candidate('r2', { region: 'eu-west-3', status: 'ineligible', statusReason: 'fixed response', eligibility: 'ineligible', backend: null });

function setup(candidates = [candidate('r1'), R2], { visible, workloads = [] }: {
  visible?: (identity: unknown, item: { account?: string; region: string }) => boolean; workloads?: Record<string, unknown>[];
} = {}) {
  const audit: AuditEntry[] = [];
  const runs: string[] = [];
  const store = memoryStore(candidates, RUN);
  const api = createApi({
    routers: [{ name: 'dmt-dev', region: 'eu-west-1', controller: 'dmt-dev-controller', account: '121014831971' }],
    invoke: async () => ({}),
    audit: { write: async (e) => { audit.push(e); }, list: async () => audit },
    now: () => NOW, newId: () => 'id-1', version: '0.1.0',
    discovery: { store, run: async (by) => { runs.push(by); } },
    fleet: {
      listRouters: async () => [], listWorkloads: async () => { throw new Error('the Discovery view never lists every workload'); },
      getWorkload: async (account: string, region: string, id: string) => (workloads.find((w) => w.account === account && w.region === region && w.workloadId === id) ?? null) as never,
    },
    ...(visible ? { visible } : {}),
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
  it('gives viewers the last run and the counts per status, without listing any candidate', async () => {
    const { api, store } = setup();
    const body = json(await api(event('GET', '/api/discovery')));
    expect([body.lastRun.startedAt, body.counts, body.candidates]).toEqual([RUN.startedAt, RUN.counts, undefined]);
    await store.putCounts({ 'pending-onboarding': 1, ineligible: 1 });
    expect(json(await api(event('GET', '/api/discovery'))).counts).toEqual({ 'pending-onboarding': 1, ineligible: 1 });
  });

  it('pages the candidates of a status, within an account or an account and region: 50 by default, at most 200', async () => {
    const many = Array.from({ length: 250 }, (_, i) => candidate(`c${String(i).padStart(3, '0')}`));
    const { api } = setup([...many, R2]);
    const page = async (q: Record<string, string>) => api(event('GET', '/api/discovery/candidates', '', undefined, q));
    const first = json(await page({ status: 'pending-onboarding' }));
    expect([first.candidates.length, first.candidates[0].id, typeof first.cursor]).toEqual([50, 'c000', 'string']);
    expect(json(await page({ status: 'pending-onboarding', cursor: first.cursor })).candidates[0].id).toBe('c050');
    expect(json(await page({ status: 'pending-onboarding', limit: '1000' })).candidates).toHaveLength(200);
    expect(json(await page({ status: 'ineligible', account: '121014831971', region: 'eu-west-3' })).candidates.map((c: Candidate) => c.id)).toEqual(['r2']);
    expect(json(await page({ status: 'ineligible', account: '121014831971', region: 'eu-west-1' })).candidates).toEqual([]);
    for (const q of [{}, { status: 'nope' }, { status: 'ineligible', region: 'eu-west-3' }, { status: 'ineligible', account: '12' }, { status: 'ineligible', cursor: 'x' }, { status: 'ineligible', limit: '0' }] as Record<string, string>[]) {
      expect((await page(q)).statusCode, JSON.stringify(q)).toBe(400);
    }
  });

  it('hides the candidates the caller may not see', async () => {
    const { api } = setup([candidate('r1'), candidate('r3', { region: 'eu-west-3' })], { visible: (_identity, item) => item.region !== 'eu-west-3' });
    const body = json(await api(event('GET', '/api/discovery/candidates', '', undefined, { status: 'pending-onboarding' })));
    expect(body.candidates.map((c: Candidate) => c.id)).toEqual(['r1']);
  });

  it('names the workload of a managed candidate from its summary, with the router the dashboard links to', async () => {
    const managed = candidate('m1', { status: 'managed', statusReason: 'managed', eligibility: 'managed', workloadId: 'a4dffc5bf369a297' });
    const { api } = setup([managed], { workloads: [{ account: '121014831971', region: 'eu-west-1', router: 'dmt-dev', workloadId: 'a4dffc5bf369a297', name: 'Shop' }] });
    const [c] = json(await api(event('GET', '/api/discovery/candidates', '', undefined, { status: 'managed' }))).candidates;
    expect(c.workload).toEqual({ router: 'dmt-dev', workloadId: 'a4dffc5bf369a297', name: 'Shop' });
  });

  it('dismissing and restoring move the counts per status', async () => {
    const { api, store } = setup();
    await store.putCounts({ 'pending-onboarding': 1, ineligible: 1 });
    await api(event('POST', '/api/discovery/dismiss', 'dmt-operator', { ids: ['r1'] }));
    expect((await store.getCounts())!.counts).toEqual({ dismissed: 1, ineligible: 1 });
    await api(event('POST', '/api/discovery/restore', 'dmt-operator', { ids: ['r1'] }));
    expect((await store.getCounts())!.counts).toEqual({ 'pending-onboarding': 1, ineligible: 1 });
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
