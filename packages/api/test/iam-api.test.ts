// The /iam/* routes (CLI fleet design §3): the same routes as /api/*, for an AWS_IAM caller mapped to an administrator.
import { describe, expect, it } from 'vitest';
import type { InstalledRouter, Operation } from '@dormeto/operations';
import { createApi, iamIdentityOf, type ApiEvent, type AuditEntry } from '../src/api.js';

const NOW = Date.UTC(2026, 9, 5, 12, 0);
const MANAGER = '121014831971';
const ARN = `arn:aws:iam::${MANAGER}:user/cli`;
const installed: InstalledRouter = {
  name: 'dmt-dev', account: MANAGER, region: 'eu-west-3', controller: `arn:aws:lambda:eu-west-3:${MANAGER}:function:dmt-dev-controller`, onboarder: `arn:aws:lambda:eu-west-3:${MANAGER}:function:dmt-dev-onboarder`,
  version: '0.18.0', build: 'b', installedBy: 'admin@example.com', installedAt: '2026-10-05T11:00:00.000Z',
};

function setup(mfa: 'required' | null = null) {
  const audit: AuditEntry[] = [];
  const created: [string, Record<string, unknown>, string][] = [];
  const state = { mfaReads: 0 };
  const api = createApi({
    routers: [{ name: 'dmt-dev', region: 'eu-west-1', controller: 'dmt-dev-controller', account: MANAGER }],
    managerAccount: MANAGER, invoke: async () => ({}),
    audit: { write: async (e) => { audit.push(e); }, list: async () => audit },
    now: () => NOW, newId: () => 'id-1', version: '0.15.0', routerVersion: '0.18.0',
    operations: {
      async create(type, input, by) { created.push([type, input, by]); return { id: 'op1', type, input, by } as unknown as Operation; },
      list: async () => [], get: async () => null, installedRouters: async () => [installed],
    },
    ...(mfa ? { mfa: { mode: mfa, async enabled() { state.mfaReads++; return false; } } } : {}),
  });
  return { api, audit, created, state };
}

const iam = (method: string, path: string, body?: unknown, userArn: string | undefined = ARN): ApiEvent => ({
  rawPath: path, requestContext: { http: { method }, authorizer: { iam: { ...(userArn ? { userArn } : {}), userId: 'AIDAX', accountId: MANAGER } } },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const jwt = (method: string, path: string, groups = 'dmt-admin'): ApiEvent => ({
  rawPath: path, requestContext: { http: { method }, authorizer: { jwt: { claims: { sub: 'u-1', email: 'a@example.com', 'cognito:groups': `[${groups}]` } } } },
});
const both = (method: string, path: string): ApiEvent => ({
  rawPath: path, requestContext: { http: { method }, authorizer: { iam: { userArn: ARN, userId: 'AIDAX' }, jwt: { claims: { sub: 'u-1', email: 'a@example.com', 'cognito:groups': '[dmt-admin]' } } } },
});

describe('iamIdentityOf', () => {
  it('maps the caller to an administrator named by its ARN', () => {
    const id = iamIdentityOf(iam('GET', '/iam/routers'))!;
    expect([id.role, id.email, id.username, id.sub, id.groups, id.amr, id.via]).toEqual(['admin', ARN, ARN, 'AIDAX', [], null, 'iam']);
    expect(id.grants).toEqual([{ tags: {}, permissions: ['read', 'wake', 'nap'] }]);
  });
  it('is null without an ARN or with JWT claims only', () => {
    expect(iamIdentityOf(iam('GET', '/iam/routers', undefined, ''))).toBeNull();
    expect(iamIdentityOf(jwt('GET', '/iam/routers'))).toBeNull();
  });
});

describe('/iam routes', () => {
  it('serves an admin route as an administrator', async () => {
    const { api } = setup();
    expect((await api(iam('GET', '/iam/audit'))).statusCode).toBe(200);
    expect((await api(iam('GET', '/iam/routers'))).statusCode).toBe(200);
  });

  it('answers /iam/health without an identity', async () => {
    const { api } = setup();
    expect((await api({ rawPath: '/iam/health', requestContext: { http: { method: 'GET' } } })).statusCode).toBe(200);
  });

  it('refuses /iam with JWT claims and no iam, and /api with iam and no claims', async () => {
    const { api } = setup();
    expect((await api(jwt('GET', '/iam/audit'))).statusCode).toBe(401);
    expect((await api(iam('GET', '/api/audit'))).statusCode).toBe(401);
  });

  it('takes the identity from its own authorizer only when both are present', async () => {
    const { api } = setup();
    // /api: the JWT (admin, a@example.com); /iam: the ARN
    expect((await api(both('GET', '/api/audit'))).statusCode).toBe(200);
    expect(JSON.parse((await api(both('GET', '/api/me'))).body!).email).toBe('a@example.com');
    expect(JSON.parse((await api(both('GET', '/iam/me'))).body!).email).toBe(ARN);
  });

  it('skips the MFA policy: an admin route passes under required and Cognito is never read', async () => {
    const { api, state } = setup('required');
    expect((await api(iam('GET', '/iam/audit'))).statusCode).toBe(200);
    expect(state.mfaReads).toBe(0);
    expect((await api(jwt('GET', '/api/audit'))).statusCode).toBe(403); // the same policy still binds /api
  });

  it('starts an upgrade-router operation by the ARN, audited with it', async () => {
    const { api, created, audit } = setup();
    const res = await api(iam('POST', '/iam/operations', { type: 'upgrade-router', router: 'dmt-dev-eu-west-3' }));
    expect(res.statusCode).toBe(202);
    expect(created).toEqual([['upgrade-router', { account: MANAGER, region: 'eu-west-3' }, ARN]]);
    expect(audit.at(-1)).toMatchObject({ who: ARN, role: 'admin' });
  });
});
