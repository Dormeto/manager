// An exclusion of a standalone candidate's resource (vision standalone workloads design §6): by its ARN, its account and
// region from the ARN, its name the resource's id.
import { describe, expect, it } from 'vitest';
import type { StandaloneCandidate } from '@dormeto/discovery';
import { createApi, type ApiEvent, type AuditEntry } from '../src/api.js';
import { NOW, memoryStore } from './memory-store.js';

const ACCOUNT = '121014831971';
const DB = `arn:aws:rds:eu-west-1:${ACCOUNT}:db:shop-db`;
const db: StandaloneCandidate = {
  kind: 'standalone', id: DB, account: ACCOUNT, region: 'eu-west-1', resourceArn: DB, name: 'shop-db', backend: { kind: 'rds-instance', id: 'shop-db', arn: DB },
  tags: {}, eligibility: 'eligible', idleHours7d: null, accountName: 'dev', ouPath: [], scope: 'in', scopeReason: 'in scope: filter "a", include 1',
  status: 'pending-onboarding', statusReason: 'eligible', firstSeenAt: new Date(NOW).toISOString(), lastSeenAt: new Date(NOW).toISOString(), history: [],
};

function setup() {
  const audit: AuditEntry[] = [];
  const store = memoryStore([db as never]);
  store.config = { config: { version: 1, mode: 'organization', regions: ['eu-west-1'], refreshHours: 24, globalExcludes: [], filters: [{ name: 'a', include: [{ accountIds: [ACCOUNT] }], exclude: [] }], standalone: 'on' }, updatedAt: '', updatedBy: '' };
  let ids = 0;
  const created: [string, Record<string, unknown>][] = [];
  const api = createApi({
    routers: [{ name: 'dmt-dev', region: 'eu-west-1', controller: 'dmt-dev-controller', account: ACCOUNT }],
    async invoke() { return null; },
    audit: { write: async (e) => { audit.push(e); }, list: async () => audit },
    now: () => NOW, newId: () => `x${++ids}`, version: '0.2.0',
    discovery: { store, run: async () => {} },
    operations: {
      async create(type: string, input: Record<string, unknown>) { created.push([type, input]); return { id: `op${created.length}`, type, input, target: { account: ACCOUNT, region: 'eu-west-1' } }; },
      list: async () => [], get: async () => null, installedRouters: async () => [],
    } as never,
  });
  return { api, audit, store, created };
}
const event = (method: string, path: string, body?: unknown): ApiEvent => ({
  rawPath: path,
  requestContext: { http: { method }, authorizer: { jwt: { claims: { sub: 'u-1', email: 'ops@example.com', 'cognito:groups': '[dmt-operator]' } } } },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');

describe('an exclusion of a resource', () => {
  it('is stored with the resource\'s account, region and id, excludes its candidate, starts the pause and is audited', async () => {
    const { api, store, audit, created } = setup();
    const res = await api(event('POST', '/api/exclusions', { target: { kind: 'resource', arn: DB }, reason: 'kept on' }));
    expect(res.statusCode).toBe(202);
    expect((await store.getExclusion('x1'))!.target).toEqual({ kind: 'resource', arn: DB, account: ACCOUNT, region: 'eu-west-1', name: 'shop-db' });
    expect(json(res)).toMatchObject({ candidates: 1, operation: { id: 'op1' } });
    const stored = await store.getCandidate(DB);
    expect([stored!.status, stored!.statusReason]).toEqual(['excluded', 'excluded: manual exclusion by ops@example.com: kept on']);
    expect(created).toEqual([['exclude', { exclusionId: 'x1' }]]);
    expect(audit[0]).toMatchObject({ action: 'exclude', target: 'resource shop-db' });
  });

  it('names each kind of resource by the router\'s id', async () => {
    const arns: Record<string, string> = {
      [`arn:aws:ec2:eu-west-1:${ACCOUNT}:instance/i-0abc`]: 'i-0abc',
      [`arn:aws:autoscaling:eu-west-1:${ACCOUNT}:autoScalingGroup:6d4f2c1e-0000-4000-8000-000000000001:autoScalingGroupName/workers`]: 'workers',
      [`arn:aws:ecs:eu-west-1:${ACCOUNT}:service/main/worker`]: 'main/worker',
      [`arn:aws:rds:eu-west-1:${ACCOUNT}:cluster:aurora`]: 'aurora',
    };
    for (const [arn, name] of Object.entries(arns)) {
      const { api } = setup();
      expect(json(await api(event('POST', '/api/exclusions', { target: { kind: 'resource', arn }, reason: 'r' }))).exclusion.target, arn).toMatchObject({ kind: 'resource', arn, account: ACCOUNT, region: 'eu-west-1', name });
    }
  });

  it('refuses what is not the ARN of a resource Dormeto naps alone, and a workload hint', async () => {
    const { api } = setup();
    for (const arn of ['arn:aws:s3:::bucket', `arn:aws:elasticloadbalancing:eu-west-1:${ACCOUNT}:targetgroup/a/1111111111111111`, 'i-0abc']) {
      const res = await api(event('POST', '/api/exclusions', { target: { kind: 'resource', arn }, reason: 'r' }));
      expect([res.statusCode, json(res).message], arn).toEqual([400, 'target.arn must be the ARN of an EC2 instance, an Auto Scaling group, an ECS service, an RDS instance or an Aurora cluster']);
    }
    const hinted = await api(event('POST', '/api/exclusions', { target: { kind: 'resource', arn: DB }, reason: 'r', workload: { router: 'dmt-dev', id: 'abc' } }));
    expect(hinted.statusCode).toBe(400);
  });
});
