// Groups and memberships (tags design §4 and §5): the custom groups' routes, their grants kept in the fleet store and their
// Cognito groups kept by the users service, and a user's membership; administrators only, audited.
import { describe, expect, it } from 'vitest';
import { createApi, type ApiEvent, type AuditEntry, type UsersService } from '../src/api.js';

const NOW = Date.UTC(2026, 9, 18, 12, 0);
const READ = [{ tags: { team: 'payments' }, permissions: ['read'] }];

interface Stored { name: string; description: string; grants: unknown[]; updatedAt: string | null; updatedBy: string | null }

function setup({ groups = [] as Stored[], cognitoOnly = [] as string[] } = {}) {
  const calls: unknown[][] = [];
  const audit: AuditEntry[] = [];
  const store = new Map(groups.map((g) => [g.name, g]));
  const users: UsersService = {
    async list() { calls.push(['list']); return [{ email: 'a@example.com', role: 'member', groups: ['payments'], status: 'CONFIRMED', enabled: true, createdAt: null }]; },
    async invite(email, role, groups) { calls.push(['invite', email, role, groups]); return { invitation: 'sent' }; },
    async resend() { return { invitation: 'sent' }; },
    async setRole(email, role) { calls.push(['role', email, role]); },
    async setGroups(email, names) { calls.push(['set-groups', email, names]); },
    async createGroup(name, description) { calls.push(['cognito-create', name, description]); },
    async updateGroup(name, description) { calls.push(['cognito-update', name, description]); },
    async deleteGroup(name) { calls.push(['cognito-delete', name]); },
    async groupNames() { return [...new Set([...store.keys(), ...cognitoOnly])]; },
    async setEnabled() {},
    async resetMfa() { return { tokenDeleted: true }; },
  };
  const fleet = {
    listRouters: async () => [], listWorkloads: async () => [], getWorkload: async () => null,
    listGroups: async () => [...store.values()].sort((a, b) => (a.name < b.name ? -1 : 1)) as never,
    getGroup: async (name: string) => (store.get(name) ?? null) as never,
    putGroup: async (g: { name: string; description: string; grants: unknown[]; updatedBy: string }) => { calls.push(['put', g.name]); store.set(g.name, { ...g, updatedAt: new Date(NOW).toISOString() }); },
    deleteGroup: async (name: string) => { calls.push(['delete', name]); store.delete(name); },
  };
  const api = createApi({
    routers: [], invoke: async () => ({}), audit: { write: async (e) => { audit.push(e); }, list: async () => audit },
    now: () => NOW, newId: () => 'id', version: '0.14.0', users, fleet: fleet as never,
  });
  return { api, calls, audit, store };
}
const event = (method: string, path: string, groups: string, body?: unknown): ApiEvent => ({
  rawPath: path, requestContext: { http: { method }, authorizer: { jwt: { claims: { sub: 'u', email: 'admin@example.com', 'cognito:groups': `[${groups}]` } } } },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');
const PAYMENTS: Stored = { name: 'payments', description: 'The payments team', grants: READ, updatedAt: null, updatedBy: null };

describe('groups: who may', () => {
  it('administrators only, members and the other roles refused', async () => {
    const s = setup({ groups: [PAYMENTS] });
    for (const groups of ['dmt-operator', 'dmt-viewer', 'payments', '']) {
      for (const [method, path] of [['GET', '/api/groups'], ['POST', '/api/groups'], ['PUT', '/api/groups/payments'], ['DELETE', '/api/groups/payments'], ['PUT', '/api/users/a%40example.com/groups']] as const) {
        expect((await s.api(event(method, path, groups, { name: 'x', groups: [] }))).statusCode, `${groups} ${method} ${path}`).toBe(403);
      }
    }
    expect(s.calls).toEqual([]);
    expect(s.audit).toEqual([]);
  });
});

describe('groups: list and create', () => {
  it('lists the groups with their description and grants', async () => {
    const s = setup({ groups: [PAYMENTS] });
    const res = await s.api(event('GET', '/api/groups', 'dmt-admin'));
    expect([res.statusCode, json(res)]).toEqual([200, { groups: [PAYMENTS] }]);
  });

  it('creates a group: its Cognito group, then its grants, audited', async () => {
    const s = setup();
    const res = await s.api(event('POST', '/api/groups', 'dmt-admin', { name: 'payments', description: 'The payments team', grants: READ }));
    expect(res.statusCode).toBe(201);
    expect(json(res).group).toEqual({ name: 'payments', description: 'The payments team', grants: READ, updatedAt: new Date(NOW).toISOString(), updatedBy: 'admin@example.com' });
    expect(s.calls).toEqual([['cognito-create', 'payments', 'The payments team'], ['put', 'payments']]);
    expect(s.audit.at(-1)).toMatchObject({ action: 'group-create', target: 'payments', result: '1 grant', who: 'admin@example.com' });
  });

  it('a group without grants or description is created empty', async () => {
    const s = setup();
    expect((await s.api(event('POST', '/api/groups', 'dmt-admin', { name: 'empty' }))).statusCode).toBe(201);
    expect(s.store.get('empty')).toMatchObject({ description: '', grants: [] });
  });

  it('refuses a name, description or grants that are not valid, with 400 and the checker\'s message, changing nothing', async () => {
    const s = setup();
    const cases: [Record<string, unknown>, string][] = [
      [{ name: 'Payments' }, 'group name: 1 to 48 lower-case letters, digits and hyphens, starting with a letter or digit'],
      [{ name: '' }, 'group name: 1 to 48 lower-case letters, digits and hyphens, starting with a letter or digit'],
      [{ name: 'dmt-admin' }, 'group name: the dmt- prefix is reserved for the built-in roles'],
      [{ name: 'dmt-x' }, 'group name: the dmt- prefix is reserved for the built-in roles'],
      [{ name: 'a'.repeat(49) }, 'group name: 1 to 48 lower-case letters, digits and hyphens, starting with a letter or digit'],
      [{ name: 'ok', description: 'x'.repeat(201) }, 'description: at most 200 characters'],
      [{ name: 'ok', description: 7 }, 'description: at most 200 characters'],
      [{ name: 'ok', grants: Array.from({ length: 21 }, () => ({ tags: {}, permissions: ['read'] })) }, 'grants: at most 20'],
      [{ name: 'ok', grants: [{ tags: {}, permissions: ['fly'] }] }, 'grant 1: permissions: at least one of read, wake, nap'],
      [{ name: 'ok', grants: [{ tags: { 'dormeto:x': '1' }, permissions: ['read'] }] }, 'grant 1: tag "dormeto:x": the dormeto: prefix is reserved'],
      [{ name: 'ok', grants: 'all' }, 'grants: an array'],
    ];
    for (const [body, message] of cases) {
      const res = await s.api(event('POST', '/api/groups', 'dmt-admin', body));
      expect([res.statusCode, json(res).message], JSON.stringify(body).slice(0, 80)).toEqual([400, message]);
    }
    expect(s.calls).toEqual([]);
    expect(s.audit).toEqual([]);
  });

  it('a group that exists is a 409; a 101st group is refused', async () => {
    const s = setup({ groups: [PAYMENTS] });
    const dup = await s.api(event('POST', '/api/groups', 'dmt-admin', { name: 'payments' }));
    expect([dup.statusCode, json(dup).error]).toEqual([409, 'conflict']);
    const hundred = setup({ groups: Array.from({ length: 100 }, (_, i) => ({ ...PAYMENTS, name: `g${i}` })) });
    const over = await hundred.api(event('POST', '/api/groups', 'dmt-admin', { name: 'one-more' }));
    expect([over.statusCode, json(over).message]).toEqual([400, 'at most 100 groups']);
    // Groups of the pool that were not made here count too.
    const adopted = setup({ groups: Array.from({ length: 99 }, (_, i) => ({ ...PAYMENTS, name: `g${i}` })), cognitoOnly: ['hand-made'] });
    expect((await adopted.api(event('POST', '/api/groups', 'dmt-admin', { name: 'one-more' }))).statusCode).toBe(400);
    expect(s.calls).toEqual([]);
    expect(hundred.calls).toEqual([]);
  });
});

describe('groups: update and delete', () => {
  it('changes the description and the grants; either alone', async () => {
    const s = setup({ groups: [PAYMENTS] });
    const wake = [{ tags: { team: 'payments' }, permissions: ['read', 'wake'] }];
    const res = await s.api(event('PUT', '/api/groups/payments', 'dmt-admin', { grants: wake }));
    expect([res.statusCode, json(res).group]).toEqual([200, { name: 'payments', description: 'The payments team', grants: wake, updatedAt: new Date(NOW).toISOString(), updatedBy: 'admin@example.com' }]);
    expect(s.calls).toEqual([['put', 'payments']]);
    s.calls.length = 0;
    await s.api(event('PUT', '/api/groups/payments', 'dmt-admin', { description: 'Payments' }));
    expect(s.calls).toEqual([['cognito-update', 'payments', 'Payments'], ['put', 'payments']]);
    expect(s.store.get('payments')).toMatchObject({ description: 'Payments', grants: wake });
    expect(s.audit.map((e) => [e.action, e.target])).toEqual([['group-update', 'payments'], ['group-update', 'payments']]);
  });

  it('refuses invalid grants or an empty change with 400, an unknown group with 404', async () => {
    const s = setup({ groups: [PAYMENTS] });
    expect((await s.api(event('PUT', '/api/groups/payments', 'dmt-admin', { grants: [{ tags: {}, permissions: [] }] }))).statusCode).toBe(400);
    expect((await s.api(event('PUT', '/api/groups/payments', 'dmt-admin', {}))).statusCode).toBe(400);
    expect((await s.api(event('PUT', '/api/groups/nobody', 'dmt-admin', { description: 'x' }))).statusCode).toBe(404);
    expect((await s.api(event('PUT', '/api/groups/dmt-admin', 'dmt-admin', { description: 'x' }))).statusCode).toBe(404);
    expect(s.calls).toEqual([]);
  });

  it('deletes the Cognito group and the grants, audited; an unknown or built-in group is a 404', async () => {
    const s = setup({ groups: [PAYMENTS] });
    const res = await s.api(event('DELETE', '/api/groups/payments', 'dmt-admin'));
    expect([res.statusCode, json(res)]).toEqual([200, { name: 'payments' }]);
    expect(s.calls).toEqual([['cognito-delete', 'payments'], ['delete', 'payments']]);
    expect(s.audit.at(-1)).toMatchObject({ action: 'group-delete', target: 'payments', result: 'deleted' });
    expect((await s.api(event('DELETE', '/api/groups/payments', 'dmt-admin'))).statusCode).toBe(404);
    expect((await s.api(event('DELETE', '/api/groups/dmt-admin', 'dmt-admin'))).statusCode).toBe(404);
    expect(s.calls).toHaveLength(2);
  });
});

describe('groups: write seen at once', () => {
  it('a deleted group\'s grants stop applying on this instance without waiting for the cache', async () => {
    const s = setup({ groups: [PAYMENTS] });
    const member = (path: string): ApiEvent => event('GET', path, 'payments');
    expect(json(await s.api(member('/api/me'))).grants).toEqual(READ);
    await s.api(event('DELETE', '/api/groups/payments', 'dmt-admin'));
    expect(json(await s.api(member('/api/me'))).grants).toEqual([]);
    await s.api(event('POST', '/api/groups', 'dmt-admin', { name: 'payments', grants: [{ tags: {}, permissions: ['read'] }] }));
    expect(json(await s.api(member('/api/me'))).grants).toEqual([{ tags: {}, permissions: ['read'] }]);
    await s.api(event('PUT', '/api/groups/payments', 'dmt-admin', { grants: READ }));
    expect(json(await s.api(member('/api/me'))).grants).toEqual(READ);
  });
});

describe('users: members and groups', () => {
  it('lists each user\'s role and groups', async () => {
    const s = setup({ groups: [PAYMENTS] });
    expect(json(await s.api(event('GET', '/api/users', 'dmt-admin'))).users).toEqual([{ email: 'a@example.com', role: 'member', groups: ['payments'], status: 'CONFIRMED', enabled: true, createdAt: null }]);
  });

  it('invites a member with groups, which must exist', async () => {
    const s = setup({ groups: [PAYMENTS] });
    const res = await s.api(event('POST', '/api/users', 'dmt-admin', { email: 'Bob@Example.com', role: 'member', groups: ['payments', 'payments'] }));
    expect([res.statusCode, json(res)]).toEqual([201, { email: 'bob@example.com', role: 'member', groups: ['payments'], invitation: 'sent' }]);
    expect(s.calls).toEqual([['invite', 'bob@example.com', 'member', ['payments']]]);
    expect(s.audit.at(-1)).toMatchObject({ action: 'invite', target: 'bob@example.com', result: 'member, sent, groups payments' });
    const unknown = await s.api(event('POST', '/api/users', 'dmt-admin', { email: 'c@example.com', role: 'member', groups: ['nobody'] }));
    expect([unknown.statusCode, json(unknown).message]).toEqual([400, 'unknown group: nobody']);
    expect((await s.api(event('POST', '/api/users', 'dmt-admin', { email: 'c@example.com', role: 'member', groups: 'payments' }))).statusCode).toBe(400);
    expect((await s.api(event('POST', '/api/users', 'dmt-admin', { email: 'c@example.com', role: 'viewer' }))).statusCode).toBe(201);
    expect(s.calls.at(-1)).toEqual(['invite', 'c@example.com', 'viewer', []]);
  });

  it('makes a user a member', async () => {
    const s = setup();
    expect((await s.api(event('PUT', '/api/users/a%40example.com/role', 'dmt-admin', { role: 'member' }))).statusCode).toBe(200);
    expect(s.calls).toEqual([['role', 'a@example.com', 'member']]);
    expect((await s.api(event('PUT', '/api/users/a%40example.com/role', 'dmt-admin', { role: 'root' }))).statusCode).toBe(400);
  });

  it('sets a user\'s groups, audited; unknown, built-in or malformed groups are refused', async () => {
    const s = setup({ groups: [PAYMENTS, { ...PAYMENTS, name: 'search' }] });
    const res = await s.api(event('PUT', '/api/users/A%40example.com/groups', 'dmt-admin', { groups: ['search', 'payments'] }));
    expect([res.statusCode, json(res)]).toEqual([200, { email: 'a@example.com', groups: ['search', 'payments'] }]);
    expect(s.calls).toEqual([['set-groups', 'a@example.com', ['search', 'payments']]]);
    expect(s.audit.at(-1)).toMatchObject({ action: 'user-groups', target: 'a@example.com', result: 'search, payments' });
    await s.api(event('PUT', '/api/users/a%40example.com/groups', 'dmt-admin', { groups: [] }));
    expect(s.audit.at(-1)).toMatchObject({ result: 'no groups' });
    for (const groups of [['nobody'], ['dmt-admin'], 'payments', [7], undefined]) {
      expect((await s.api(event('PUT', '/api/users/a%40example.com/groups', 'dmt-admin', { groups }))).statusCode, JSON.stringify(groups)).toBe(400);
    }
    expect((await s.api(event('PUT', '/api/users/nope/groups', 'dmt-admin', { groups: [] }))).statusCode).toBe(400);
    expect(s.calls).toHaveLength(2);
  });
});
