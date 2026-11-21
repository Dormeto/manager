// The kind of workloads and of candidates as a filter of their lists (vision standalone workloads design §6): `kind=http` or
// `kind=standalone`; a row without kind is HTTP.
import { describe, expect, it } from 'vitest';
import { createApi, type ApiEvent } from '../src/api.js';
import { NOW, candidate, memoryStore } from './memory-store.js';

const MANAGER = '121014831971';
const ARN = `arn:aws:ec2:eu-west-1:${MANAGER}:instance/i-0abc`;
const ROWS = [
  { account: MANAGER, region: 'eu-west-1', router: 'dmt-dev', workloadId: 'web', name: 'web', state: 'AWAKE' },
  { account: MANAGER, region: 'eu-west-1', router: 'dmt-dev', workloadId: 'sa', name: 'sa', state: 'AWAKE', kind: 'standalone', resourceArn: ARN },
];
const STANDALONE = {
  kind: 'standalone', id: ARN, account: MANAGER, region: 'eu-west-1', resourceArn: ARN, name: 'build-agent', backend: { kind: 'instance', id: 'i-0abc', arn: ARN }, tags: {},
  eligibility: 'eligible', idleHours7d: null, accountName: 'dev', ouPath: [], scope: 'in', scopeReason: 'in', status: 'pending-onboarding', statusReason: 'eligible', firstSeenAt: 'x', lastSeenAt: 'x', history: [],
};
function setup() {
  return createApi({
    routers: [{ name: 'dmt-dev', region: 'eu-west-1', controller: 'c', account: MANAGER }], now: () => NOW, newId: () => 'x', version: '0.25.0', managerAccount: MANAGER,
    audit: { write: async () => {}, list: async () => [] }, async invoke() { return null; },
    fleet: { listRouters: async () => [{ account: MANAGER, region: 'eu-west-1', router: 'dmt-dev', version: '0.42.0', checkedAt: new Date(NOW).toISOString() }] as never, listWorkloads: async () => ROWS as never, getWorkload: async () => null },
    discovery: { store: memoryStore([candidate('arn:tg', { account: MANAGER, region: 'eu-west-1' }), STANDALONE as never]), run: async () => {} },
  });
}
const get = (path: string, query: Record<string, string>): ApiEvent => ({
  rawPath: path, queryStringParameters: query,
  requestContext: { http: { method: 'GET' }, authorizer: { jwt: { claims: { sub: 'u', email: 'v@example.com', 'cognito:groups': '[dmt-viewer]' } } } },
});
const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');

describe('the kind as a filter', () => {
  it('of the workloads', async () => {
    const api = setup();
    expect(json(await api(get('/api/workloads', { limit: '10', kind: 'standalone' }))).workloads.map((w: { workloadId: string }) => w.workloadId)).toEqual(['sa']);
    expect(json(await api(get('/api/workloads', { limit: '10', kind: 'http' }))).workloads.map((w: { workloadId: string }) => w.workloadId)).toEqual(['web']);
    expect(json(await api(get('/api/workloads', { limit: '10' }))).total).toBe(2);
    expect((await api(get('/api/workloads', { kind: 'batch' }))).statusCode).toBe(400);
  });

  it('of the candidates', async () => {
    const api = setup();
    const ids = async (kind?: string) => json(await api(get('/api/discovery/candidates', { status: 'pending-onboarding', ...(kind ? { kind } : {}) }))).candidates.map((c: { id: string }) => c.id);
    expect([await ids('standalone'), await ids('http'), (await ids()).length]).toEqual([[ARN], ['arn:tg'], 2]);
    expect((await api(get('/api/discovery/candidates', { status: 'pending-onboarding', kind: 'batch' }))).statusCode).toBe(400);
  });
});
