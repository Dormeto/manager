// Onboarding a standalone candidate through POST /operations (vision standalone workloads design §6): its settings checked by
// its kind before the operation starts (a waker's key refused with the router's text), its databases as an HTTP one's, the
// rest sent to the router's preview, which has the last word.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StandaloneCandidate } from '@dormeto/discovery';
import { createApi, type ApiEvent, type AuditEntry } from '../src/api.js';
import { NOW, memoryStore } from './memory-store.js';

const ACCOUNT = '121014831971';
const ARN = `arn:aws:ec2:eu-west-1:${ACCOUNT}:instance/i-0abc`;
const instance: StandaloneCandidate = {
  kind: 'standalone', id: ARN, account: ACCOUNT, region: 'eu-west-1', resourceArn: ARN, name: 'build-agent', backend: { kind: 'instance', id: 'i-0abc', arn: ARN },
  tags: {}, eligibility: 'eligible', idleHours7d: null, accountName: 'dev', ouPath: [], scope: 'in', scopeReason: 'in scope: filter "a", include 1',
  status: 'pending-onboarding', statusReason: 'eligible', firstSeenAt: new Date(NOW).toISOString(), lastSeenAt: new Date(NOW).toISOString(), history: [],
};
const WAKER_KEYS = ['waitSeconds', 'drainSeconds', 'maxHolders', 'failedRetrySeconds', 'wakeMode', 'noWakeRules', 'wakeRules'];

function setup() {
  const audit: AuditEntry[] = [];
  const created: [string, Record<string, unknown>][] = [];
  const api = createApi({
    routers: [{ name: 'dmt-dev', region: 'eu-west-1', controller: 'dmt-dev-controller', account: ACCOUNT }],
    async invoke() { return null; },
    audit: { write: async (e) => { audit.push(e); }, list: async () => audit },
    now: () => NOW, newId: () => 'x1', version: '0.2.0',
    discovery: { store: memoryStore([instance as never]), run: async () => {} },
    operations: {
      async create(type: string, input: Record<string, unknown>) { created.push([type, input]); return { id: 'op1', type, input, target: { account: ACCOUNT, region: 'eu-west-1', resourceArn: ARN } }; },
      list: async () => [], get: async () => null, installedRouters: async () => [],
    } as never,
  });
  return { api, created };
}
const event = (body: unknown): ApiEvent => ({
  rawPath: '/api/operations',
  requestContext: { http: { method: 'POST' }, authorizer: { jwt: { claims: { sub: 'u-1', email: 'ops@example.com', 'cognito:groups': '[dmt-admin]' } } } },
  body: JSON.stringify(body),
});
const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');
const waker = (key: string) => (key === 'wakeMode' ? 'any' : key.endsWith('Rules') ? [] : 60);

describe('onboarding a standalone candidate', () => {
  it('starts the operation with its settings, databases and tags as given', async () => {
    const { api, created } = setup();
    const body = { type: 'onboard', candidateId: ARN, name: 'Build agent', settings: { idleCpuPercent: 3, idleMinutes: 240, hibernate: true }, databases: [{ kind: 'rds-instance', id: 'ci-db' }], tags: { team: 'ci' } };
    const res = await api(event(body));
    expect(res.statusCode).toBe(202);
    expect(created).toEqual([['onboard', { candidateId: ARN, name: 'Build agent', settings: body.settings, databases: body.databases, tags: { team: 'ci' } }]]);
    expect(json(res).operation.target).toMatchObject({ resourceArn: ARN });
  });

  it('refuses a waker\'s setting with the router\'s text, before any operation', async () => {
    for (const key of WAKER_KEYS) {
      const { api, created } = setup();
      const res = await api(event({ type: 'onboard', candidateId: ARN, settings: { [key]: waker(key) } }));
      expect([res.statusCode, json(res).message], key).toEqual([400, `settings: ${key}: a standalone workload has no waker: ${key} is for an HTTP workload`]);
      expect(created).toEqual([]);
    }
  });

  it('refuses a database that is no RDS instance or cluster, as for an HTTP candidate', async () => {
    const { api } = setup();
    const res = await api(event({ type: 'onboard', candidateId: ARN, databases: [{ kind: 'dynamodb', id: 't' }] }));
    expect([res.statusCode, json(res).message]).toEqual([400, 'databases: {"kind":"dynamodb","id":"t"} is not an RDS instance or cluster: give {"kind": "rds-instance" or "rds-cluster", "id": "<identifier>"}']);
  });
});

// The router's words for a waker's key on a standalone workload (lambda/src/lib/settings-levels.mjs), prefixed as its
// preview prefixes them. Skipped without the router's checkout beside the manager's.
const LEVELS = resolve(import.meta.dirname, '../../../../router/lambda/src/lib/settings-levels.mjs');
const levels = (existsSync(LEVELS) ? await import(/* @vite-ignore */ LEVELS) : null) as {
  WAKER_KEYS: string[]; defaultsProblems(d: Record<string, unknown>, o: { workload: boolean; kind: string }): string[];
} | null;
describe.skipIf(!levels)('the waker\'s keys against the router\'s', () => {
  it('are the router\'s, refused in its words', async () => {
    expect(WAKER_KEYS).toEqual(levels!.WAKER_KEYS);
    for (const key of WAKER_KEYS) {
      const { api } = setup();
      const res = await api(event({ type: 'onboard', candidateId: ARN, settings: { [key]: waker(key) } }));
      expect(json(res).message, key).toBe(`settings: ${levels!.defaultsProblems({ [key]: waker(key) }, { workload: true, kind: 'standalone' })[0]}`);
    }
  });
});
