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

type Answer = (router: string, payload: Record<string, unknown>) => unknown;
function setup(candidates: Candidate[] = [managed(TG, 'demo-asg', TG), managed(TG2, 'other', TG2), candidate('free', { loadBalancerArn: LB, targetGroupArn: 'arn:free' })], answer?: Answer) {
  const audit: AuditEntry[] = [];
  const calls: [string, Record<string, unknown>][] = [];
  const store = memoryStore(candidates);
  store.config = { config: { version: 1, mode: 'organization', regions: ['eu-west-1'], refreshHours: 24, globalExcludes: [], filters: [{ name: 'a', include: [{ accountIds: [ACCOUNT] }], exclude: [] }] }, updatedAt: '', updatedBy: '' };
  let ids = 0;
  const api = createApi({
    routers: [
      { name: 'dmt-dev', region: 'eu-west-1', controller: 'dmt-dev-controller', account: ACCOUNT },
      { name: 'dmt-dev2', region: 'eu-west-1', controller: 'dmt-dev2-controller', account: ACCOUNT },
      { name: 'dmt-paris', region: 'eu-west-3', controller: 'dmt-paris-controller', account: ACCOUNT },
    ],
    async invoke(router, payload) {
      calls.push([router.name, payload]);
      if (answer) return answer(router.name, payload);
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
    expect(calls).toEqual([['dmt-dev', { action: 'pause', workloadId: 'demo-asg', targetGroupArn: TG, by: 'ops@example.com', reason: 'excluded: migration', until: expiresAt, exclusionId: 'x1' }]]);
    const stored = await store.getCandidate(TG);
    expect([stored!.status, stored!.statusReason]).toEqual(['pending-offboarding', 'excluded: manual exclusion by ops@example.com: migration']);
    expect((await store.getCandidate('free'))!.status).toBe('pending-onboarding');
    expect(audit).toEqual([{ id: 'x2', at: new Date(NOW).toISOString(), who: 'ops@example.com', role: 'operator', action: 'exclude', target: 'target group dmt-dev-asg-app', result: `migration; until ${expiresAt}; paused dmt-dev/demo-asg` }]);
  });

  it('excludes a load balancer: every candidate on it, a workload no registered router manages is reported', async () => {
    const { api, store } = setup();
    const res = json(await api(event('POST', '/api/exclusions', 'dmt-operator', { target: { kind: 'load-balancer', arn: LB }, reason: 'legacy' })));
    expect([res.candidates, res.paused, res.unpaused]).toEqual([3, [{ router: 'dmt-dev', workloadId: 'demo-asg' }], ['other: no registered router manages it']]);
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

  it('refuses a reason the router could not take once prefixed with "excluded: "', async () => {
    const { api, store } = setup();
    const at = (reason: string) => api(event('POST', '/api/exclusions', 'dmt-operator', { target: { kind: 'target-group', arn: TG }, reason }));
    expect((await at('x'.repeat(247))).statusCode).toBe(400);
    expect((await at('x'.repeat(246))).statusCode).toBe(201);
    expect(await store.listExclusions()).toHaveLength(1);
  });

  it('accepts the workload it was created from with a target group exclusion only', async () => {
    const { api } = setup();
    const res = await api(event('POST', '/api/exclusions', 'dmt-operator', { target: { kind: 'load-balancer', arn: LB }, reason: 'a', workload: { router: 'dmt-dev', id: 'demo-asg' } }));
    expect(res.statusCode).toBe(400);
  });

  it('pauses the right workload when routers share an account and region, and every workload of the same id elsewhere', async () => {
    const TG3 = TG.replace('eu-west-1', 'eu-west-3').replace('73e2d6bc24d8a067', '3333333333333333');
    const LB3 = LB.replace('eu-west-1', 'eu-west-3');
    // dmt-dev and dmt-dev2 both have a "web" in eu-west-1, only dmt-dev2's forwards to TG; dmt-paris has a "web" in eu-west-3.
    const answer: Answer = (router, p) => {
      const owns = (router === 'dmt-dev2' && p.targetGroupArn === TG) || (router === 'dmt-paris' && p.targetGroupArn === TG3);
      if (p.action === 'pause' && !owns) throw new RouterError(`workload not configured: ${p.workloadId} (its target group is not ${p.targetGroupArn})`);
      return { pause: {}, woken: [] };
    };
    const { api, calls, store } = setup([managed(TG, 'web', TG), managed(TG3, 'web', TG3, { region: 'eu-west-3', loadBalancerArn: LB3 })], answer);
    const res = json(await api(event('POST', '/api/exclusions', 'dmt-operator', { target: { kind: 'account', account: ACCOUNT }, reason: 'payments' })));
    expect(res.paused).toEqual([{ router: 'dmt-dev2', workloadId: 'web' }, { router: 'dmt-paris', workloadId: 'web' }]);
    expect(calls.filter(([, p]) => p.action === 'pause').map(([r]) => r)).toEqual(['dmt-dev', 'dmt-dev2', 'dmt-paris']);
    expect((await store.getExclusion('x1'))!.paused).toEqual(res.paused);
  });

  it('a workload whose pause fails is reported with its error; the pauses that succeeded are kept with the exclusion', async () => {
    const answer: Answer = (router, p) => {
      if (p.action === 'pause' && p.workloadId === 'other') throw new RouterError('Rate exceeded');
      return { pause: {}, woken: [] };
    };
    const { api, store } = setup(undefined, answer);
    const res = await api(event('POST', '/api/exclusions', 'dmt-operator', { target: { kind: 'load-balancer', arn: LB }, reason: 'legacy' }));
    expect(res.statusCode).toBe(201);
    expect(json(res).unpaused).toEqual(['other (dmt-dev): Rate exceeded']);
    expect((await store.getExclusion('x1'))!.paused).toEqual([{ router: 'dmt-dev', workloadId: 'demo-asg' }]);
  });

  it('a router too old to pause is reported, not fatal', async () => {
    const answer: Answer = (router, p) => {
      if (p.action === 'pause') throw new RouterError('unknown action: pause');
      return null;
    };
    const { api } = setup([managed(TG, 'demo-asg', TG)], answer);
    const res = json(await api(event('POST', '/api/exclusions', 'dmt-operator', { target: { kind: 'target-group', arn: TG }, reason: 'a' })));
    expect([res.paused, res.unpaused]).toEqual([[], ['demo-asg (dmt-dev): router too old to pause, upgrade it to 0.16.0 or later']]);
  });

  it('a lift that cannot resume a workload keeps the exclusion lifted, to retry; the next lift finishes it', async () => {
    let down = true;
    const answer: Answer = (router, p) => {
      if (p.action === 'resume' && down) throw new RouterError('Rate exceeded');
      return p.action === 'pause' ? { pause: {}, woken: [] } : { resumed: true };
    };
    const { api, store } = setup(undefined, answer);
    await api(event('POST', '/api/exclusions', 'dmt-operator', { target: { kind: 'target-group', arn: TG }, reason: 'migration' }));
    const first = json(await api(event('DELETE', '/api/exclusions/x1', 'dmt-operator')));
    expect(first).toEqual({ candidates: 1, resumed: [], errors: ['dmt-dev/demo-asg: Rate exceeded'] });
    const kept = await store.getExclusion('x1');
    expect([kept!.liftedAt, kept!.paused]).toEqual([new Date(NOW).toISOString(), [{ router: 'dmt-dev', workloadId: 'demo-asg' }]]);
    expect((await store.getCandidate(TG))!.status).toBe('managed');
    const { exclusions } = json(await api(event('GET', '/api/exclusions')));
    expect(exclusions[0].lifting).toBe(true);
    down = false;
    expect(json(await api(event('DELETE', '/api/exclusions/x1', 'dmt-operator'))).resumed).toEqual([{ router: 'dmt-dev', workloadId: 'demo-asg' }]);
    expect(await store.getExclusion('x1')).toBeNull();
  });

  it('an expired exclusion brings its candidates back without a run, once', async () => {
    const { api, store } = setup();
    let now = NOW;
    await api(event('POST', '/api/exclusions', 'dmt-operator', { target: { kind: 'target-group', arn: TG }, reason: 'migration', expiresAt: new Date(NOW + DAY).toISOString() }));
    expect((await store.getCandidate(TG))!.status).toBe('pending-offboarding');
    now = NOW + 2 * DAY;
    const later = createApi({
      routers: [{ name: 'dmt-dev', region: 'eu-west-1', controller: 'c', account: ACCOUNT }], invoke: async () => null,
      audit: { write: async () => {}, list: async () => [] }, now: () => now, version: '0.2.0', discovery: { store, run: async () => {} },
    });
    const { candidates } = json(await later(event('GET', '/api/discovery')));
    expect(candidates.find((c: Candidate) => c.id === TG).status).toBe('managed');
    expect((await store.getExclusion('x1'))!.lapsedAt).toBe(new Date(NOW + 2 * DAY).toISOString());
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
