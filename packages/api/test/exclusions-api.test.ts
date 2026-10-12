import { describe, expect, it } from 'vitest';
import type { Candidate, Exclusion } from '@dormeto/discovery';
import { createApi, RouterError, type ApiEvent, type AuditEntry } from '../src/api.js';
import { NOW, candidate, memoryStore } from './memory-store.js';

const DAY = 86_400_000;
const ACCOUNT = '121014831971';
const LB = `arn:aws:elasticloadbalancing:eu-west-1:${ACCOUNT}:loadbalancer/app/dmt-dev/50dc6c495c0c9188`;
const TG = `arn:aws:elasticloadbalancing:eu-west-1:${ACCOUNT}:targetgroup/dmt-dev-asg-app/73e2d6bc24d8a067`;
const TG2 = `arn:aws:elasticloadbalancing:eu-west-1:${ACCOUNT}:targetgroup/dmt-dev-ecs-app/1111111111111111`;

const managed = (id: string, workloadId: string, targetGroupArn: string, over: Partial<Candidate> = {}) => candidate(id, {
  loadBalancerArn: LB, loadBalancer: 'dmt-dev', targetGroupArn, eligibility: 'managed', workloadId, backend: null,
  status: 'managed', statusReason: `managed as workload ${workloadId}`, ...over,
});

function setup(candidates: Candidate[] = [managed(TG, 'demo-asg', TG), managed(TG2, 'other', TG2), candidate('free', { loadBalancerArn: LB, targetGroupArn: 'arn:free' })]) {
  const audit: AuditEntry[] = [];
  const calls: [string, Record<string, unknown>][] = [];
  const store = memoryStore(candidates);
  store.config = { config: { version: 1, mode: 'organization', regions: ['eu-west-1'], refreshHours: 24, globalExcludes: [], filters: [{ name: 'a', include: [{ accountIds: [ACCOUNT] }], exclude: [] }] }, updatedAt: '', updatedBy: '' };
  let ids = 0;
  const api = createApi({
    routers: [
      { name: 'dmt-dev', region: 'eu-west-1', controller: 'dmt-dev-controller', account: ACCOUNT },
      { name: 'dmt-paris', region: 'eu-west-3', controller: 'dmt-paris-controller', account: ACCOUNT },
    ],
    async invoke(router, payload) {
      calls.push([router.name, payload]);
      if (payload.workloadId === 'other') throw new RouterError('workload not configured: other');
      if (payload.action === 'pause') return { pause: {}, woken: [payload.workloadId] };
      if (payload.action === 'resume') return { resumed: true };
      return null;
    },
    audit: { write: async (e) => { audit.push(e); }, list: async () => audit },
    now: () => NOW, newId: () => `x${++ids}`, version: '0.2.0',
    discovery: { store, run: async () => {} },
  });
  return { api, audit, calls, store };
}

function event(method: string, path: string, groups = '', body?: unknown): ApiEvent {
  return {
    rawPath: path,
    requestContext: { http: { method }, authorizer: { jwt: { claims: { sub: 'u-1', email: 'ops@example.com', 'cognito:groups': `[${groups}]` } } } },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}
const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');
const expiresAt = new Date(NOW + 7 * DAY).toISOString();

describe('exclusions', () => {
  it('excludes a target group: stored, its candidate waits for offboarding, its workload is paused in its router, audited', async () => {
    const { api, audit, calls, store } = setup();
    expect((await api(event('POST', '/api/exclusions', 'dmt-viewer', { target: { kind: 'target-group', arn: TG }, reason: 'migration' }))).statusCode).toBe(403);
    const res = await api(event('POST', '/api/exclusions', 'dmt-operator', { target: { kind: 'target-group', arn: TG }, reason: ' migration ', expiresAt }));
    expect(res.statusCode).toBe(201);
    const exclusion: Exclusion = {
      id: 'x1', target: { kind: 'target-group', arn: TG, account: ACCOUNT, region: 'eu-west-1', name: 'dmt-dev-asg-app' },
      reason: 'migration', by: 'ops@example.com', at: new Date(NOW).toISOString(), expiresAt, paused: [{ router: 'dmt-dev', workloadId: 'demo-asg' }],
    };
    expect(json(res)).toEqual({ exclusion, candidates: 1, paused: [{ router: 'dmt-dev', workloadId: 'demo-asg' }], unpaused: [] });
    expect(await store.getExclusion('x1')).toEqual(exclusion);
    expect(calls).toEqual([['dmt-dev', { action: 'pause', workloadId: 'demo-asg', by: 'ops@example.com', reason: 'excluded: migration', until: expiresAt, exclusionId: 'x1' }]]);
    const stored = await store.getCandidate(TG);
    expect([stored!.status, stored!.statusReason]).toEqual(['pending-offboarding', 'excluded: manual exclusion by ops@example.com: migration']);
    expect((await store.getCandidate('free'))!.status).toBe('pending-onboarding');
    expect(audit).toEqual([{ id: 'x2', at: new Date(NOW).toISOString(), who: 'ops@example.com', role: 'operator', action: 'exclude', target: 'target group dmt-dev-asg-app', result: `migration; until ${expiresAt}; paused dmt-dev/demo-asg` }]);
  });

  it('excludes a load balancer: every candidate on it, a workload no registered router manages is reported', async () => {
    const { api, store } = setup();
    const res = json(await api(event('POST', '/api/exclusions', 'dmt-operator', { target: { kind: 'load-balancer', arn: LB }, reason: 'legacy' })));
    expect([res.candidates, res.paused, res.unpaused]).toEqual([3, [{ router: 'dmt-dev', workloadId: 'demo-asg' }], ['other']]);
    expect((await store.getCandidate('free'))!.status).toBe('excluded');
    expect((await store.getExclusion('x1'))!.target).toEqual({ kind: 'load-balancer', arn: LB, account: ACCOUNT, region: 'eu-west-1', name: 'dmt-dev' });
  });

  it('excludes an account, named from the organization inventory', async () => {
    const { api, store } = setup();
    const res = json(await api(event('POST', '/api/exclusions', 'dmt-operator', { target: { kind: 'account', account: ACCOUNT }, reason: 'payments' })));
    expect(res.exclusion.target).toEqual({ kind: 'account', account: ACCOUNT, name: 'dormeto' });
    expect((await store.listCandidates()).map((c) => c.status).sort()).toEqual(['excluded', 'pending-offboarding', 'pending-offboarding']);
  });

  it('pauses the workload it was created from, even without a discovery candidate', async () => {
    const { api, calls } = setup([]);
    const res = json(await api(event('POST', '/api/exclusions', 'dmt-operator', { target: { kind: 'target-group', arn: TG }, reason: 'migration', workload: { router: 'dmt-dev', id: 'demo-asg' } })));
    expect(res.paused).toEqual([{ router: 'dmt-dev', workloadId: 'demo-asg' }]);
    expect(calls.map(([router, p]) => [router, p.action, p.workloadId])).toEqual([['dmt-dev', 'pause', 'demo-asg']]);
  });

  it('refuses an unknown kind, a malformed ARN or account, a missing reason, an expiry in the past or an unknown router', async () => {
    const { api, store, audit } = setup();
    for (const body of [
      { target: { kind: 'rule', arn: TG }, reason: 'a' },
      { target: { kind: 'target-group', arn: LB }, reason: 'a' },
      { target: { kind: 'load-balancer', arn: 'web' }, reason: 'a' },
      { target: { kind: 'account', account: '1234' }, reason: 'a' },
      { target: { kind: 'target-group', arn: TG } },
      { target: { kind: 'target-group', arn: TG }, reason: 'a', expiresAt: new Date(NOW - 1).toISOString() },
      { target: { kind: 'target-group', arn: TG }, reason: 'a', workload: { router: 'nope', id: 'demo' } },
    ]) {
      expect((await api(event('POST', '/api/exclusions', 'dmt-operator', body))).statusCode).toBe(400);
    }
    expect(await store.listExclusions()).toEqual([]);
    expect(audit).toEqual([]);
  });

  it('lists exclusions to viewers, expired ones marked', async () => {
    const { api, store } = setup();
    await store.putExclusion({ id: 'old', target: { kind: 'account', account: ACCOUNT, name: 'dormeto' }, reason: 'a', by: 'ops@example.com', at: '2026-10-01T00:00:00.000Z', expiresAt: '2026-10-02T00:00:00.000Z' });
    await api(event('POST', '/api/exclusions', 'dmt-operator', { target: { kind: 'target-group', arn: TG }, reason: 'migration' }));
    const { exclusions } = json(await api(event('GET', '/api/exclusions')));
    expect(exclusions.map((e: Exclusion & { expired: boolean }) => [e.id, e.expired])).toEqual([['old', true], ['x1', false]]);
  });

  it('lifting resumes the workloads paused for it only, and brings the candidates back', async () => {
    const { api, audit, calls, store } = setup();
    await api(event('POST', '/api/exclusions', 'dmt-operator', { target: { kind: 'target-group', arn: TG }, reason: 'migration' }));
    calls.length = 0;
    expect((await api(event('DELETE', '/api/exclusions/x1', 'dmt-viewer'))).statusCode).toBe(403);
    const res = await api(event('DELETE', '/api/exclusions/x1', 'dmt-operator'));
    expect(json(res)).toEqual({ candidates: 1, resumed: [{ router: 'dmt-dev', workloadId: 'demo-asg' }], errors: [] });
    expect(calls).toEqual([['dmt-dev', { action: 'resume', workloadId: 'demo-asg', by: 'ops@example.com', exclusionId: 'x1' }]]);
    expect(await store.getExclusion('x1')).toBeNull();
    expect((await store.getCandidate(TG))!.status).toBe('managed');
    expect(audit.at(-1)).toMatchObject({ action: 'exclusion-lift', target: 'target group dmt-dev-asg-app', result: 'migration; resumed dmt-dev/demo-asg' });
    expect((await api(event('DELETE', '/api/exclusions/x1', 'dmt-operator'))).statusCode).toBe(404);
  });

  it('the perimeter lint counts the active exclusions', async () => {
    const { api } = setup();
    await api(event('POST', '/api/exclusions', 'dmt-operator', { target: { kind: 'account', account: ACCOUNT }, reason: 'payments' }));
    const { lint } = json(await api(event('GET', '/api/discovery/config')));
    expect(lint).toEqual([expect.objectContaining({ code: 'include-shadowed-by-global-exclude', by: 'manual exclusion by ops@example.com: payments' })]);
  });
});
