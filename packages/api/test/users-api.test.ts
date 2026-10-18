import { describe, expect, it } from 'vitest';
import { createApi, HttpError, type ApiEvent, type AuditEntry, type UsersService } from '../src/api.js';

function setup() {
  const calls: unknown[] = [];
  const audit: AuditEntry[] = [];
  const users: UsersService = {
    async list() { calls.push(['list']); return [{ email: 'a@example.com', role: 'viewer', groups: [], status: 'CONFIRMED', enabled: true, createdAt: null }]; },
    async invite(email, role, groups) { calls.push(['invite', email, role, groups]); return { invitation: email.endsWith('@new.example') ? 'pending-verification' : 'sent' }; },
    async resend(email) { calls.push(['resend', email]); if (email === 'unverified@example.com') throw new HttpError(409, 'conflict', 'address not verified yet'); return { invitation: 'sent' }; },
    async setRole(email, role) { calls.push(['role', email, role]); },
    async setGroups() {}, async createGroup() { return { adopted: false }; }, async updateGroup() {}, async deleteGroup() {}, async groupNames() { return []; },
    async setEnabled(email, enabled) { calls.push([enabled ? 'enable' : 'disable', email]); },
    async resetMfa(email) { calls.push(['mfa-reset', email]); return { tokenDeleted: true }; },
  };
  const api = createApi({
    routers: [], invoke: async () => ({}), audit: { write: async (e) => { audit.push(e); }, list: async () => audit },
    now: () => 0, newId: () => 'id', version: '0.1.0', users,
  });
  return { api, calls, audit };
}

const event = (method: string, path: string, groups: string, body?: unknown): ApiEvent => ({
  rawPath: path,
  requestContext: { http: { method }, authorizer: { jwt: { claims: { sub: 'u', email: 'admin@example.com', 'cognito:groups': `[${groups}]` } } } },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');

describe('users', () => {
  it('are managed by admins only', async () => {
    const { api, calls } = setup();
    for (const [method, path] of [['GET', '/api/users'], ['POST', '/api/users'], ['PUT', '/api/users/a%40example.com/role'], ['POST', '/api/users/a%40example.com/disable']]) {
      expect((await api(event(method!, path!, 'dmt-operator', { email: 'x@example.com', role: 'viewer' }))).statusCode).toBe(403);
    }
    expect(calls).toEqual([]);
  });

  it('lists the users', async () => {
    const { api } = setup();
    expect(json(await api(event('GET', '/api/users', 'dmt-admin'))).users).toHaveLength(1);
  });

  it('invites a user with a role, audited with the invitation outcome', async () => {
    const { api, calls, audit } = setup();
    const res = await api(event('POST', '/api/users', 'dmt-admin', { email: 'Bob@New.Example', role: 'operator' }));
    expect(res.statusCode).toBe(201);
    expect(json(res)).toEqual({ email: 'bob@new.example', role: 'operator', invitation: 'pending-verification' });
    expect(calls).toEqual([['invite', 'bob@new.example', 'operator', []]]);
    expect(audit[0]).toMatchObject({ action: 'invite', target: 'bob@new.example', result: 'operator, pending-verification' });
  });

  it('rejects an invalid email or role', async () => {
    const { api } = setup();
    expect((await api(event('POST', '/api/users', 'dmt-admin', { email: 'nope', role: 'viewer' }))).statusCode).toBe(400);
    expect((await api(event('POST', '/api/users', 'dmt-admin', { email: 'a@example.com', role: 'root' }))).statusCode).toBe(400);
    expect((await api(event('POST', '/api/users', 'dmt-admin', 'not json'))).statusCode).toBe(400);
  });

  it('resends an invitation, 409 while the address is not verified', async () => {
    const { api } = setup();
    expect((await api(event('POST', '/api/users/a%40example.com/resend', 'dmt-admin'))).statusCode).toBe(200);
    const res = await api(event('POST', '/api/users/unverified%40example.com/resend', 'dmt-admin'));
    expect(res.statusCode).toBe(409);
    expect(json(res).message).toBe('address not verified yet');
  });

  it('changes the role and disables or enables a user, never the caller', async () => {
    const { api, calls } = setup();
    expect((await api(event('PUT', '/api/users/a%40example.com/role', 'dmt-admin', { role: 'admin' }))).statusCode).toBe(200);
    expect((await api(event('POST', '/api/users/a%40example.com/disable', 'dmt-admin'))).statusCode).toBe(200);
    expect((await api(event('POST', '/api/users/a%40example.com/enable', 'dmt-admin'))).statusCode).toBe(200);
    expect(calls).toEqual([['role', 'a@example.com', 'admin'], ['disable', 'a@example.com'], ['enable', 'a@example.com']]);
    expect((await api(event('PUT', '/api/users/admin%40example.com/role', 'dmt-admin', { role: 'viewer' }))).statusCode).toBe(409);
    expect((await api(event('POST', '/api/users/admin%40example.com/disable', 'dmt-admin'))).statusCode).toBe(409);
  });
});
