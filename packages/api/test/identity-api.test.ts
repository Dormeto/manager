// Identity and the MFA policy with groups (tags design §4 and §5): a member has no built-in group; the custom groups'
// grants join the built-in role's; without the multi-factor session where it is required, read only.
import { describe, expect, it } from 'vitest';
import { createApi, type ApiEvent, type MfaMode } from '../src/api.js';
import type { Grant } from '../src/access.js';

const READ_ALL: Grant = { tags: {}, permissions: ['read'] };
const ALL: Grant = { tags: {}, permissions: ['read', 'wake', 'nap'] };
const READ_PAYMENTS: Grant = { tags: { team: 'payments' }, permissions: ['read'] };
const WAKE_DATA: Grant = { tags: { team: 'data' }, permissions: ['read', 'wake'] };

function setup(mode: MfaMode | null = null, { enrolled = new Set<string>(), passkeys = false }: { enrolled?: Set<string>; passkeys?: boolean } = {}) {
  let clock = 0;
  let groups = [
    { name: 'payments', grants: [READ_PAYMENTS] },
    { name: 'data', grants: [WAKE_DATA] },
  ];
  const state = { groupReads: 0, authenticatorReads: [] as string[] };
  const api = createApi({
    routers: [], invoke: async () => ({}), audit: { write: async () => {}, list: async () => [] }, now: () => clock, newId: () => 'id', version: '0.14.0',
    fleet: {
      listRouters: async () => [], listWorkloads: async () => [], getWorkload: async () => null,
      listGroups: async () => { state.groupReads++; return groups.map((g) => ({ ...g, description: '', updatedAt: null, updatedBy: null })); },
    },
    ...(mode ? { mfa: { mode, passkeys, async enabled(username: string) { state.authenticatorReads.push(username); return enrolled.has(username); } } } : {}),
  });
  return { api, state, advance: (ms: number) => { clock += ms; }, setGroups: (next: typeof groups) => { groups = next; } };
}

const event = (path: string, groups: string | null, amr?: string): ApiEvent => ({
  rawPath: path,
  requestContext: { http: { method: 'GET' }, authorizer: { jwt: { claims: { sub: 's-1', 'cognito:username': 'u-1', email: 'user@example.com', ...(groups === null ? {} : { 'cognito:groups': `[${groups}]` }), ...(amr === undefined ? {} : { amr }) } } } },
});
const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');
const me = async (s: ReturnType<typeof setup>, groups: string | null, amr?: string) => json(await s.api(event('/api/me', groups, amr)));

describe('identity', () => {
  it('a token with a custom group only is a member, with the group\'s grants', async () => {
    const s = setup();
    const who = await me(s, 'payments');
    expect([who.role, who.groups, who.grants]).toEqual(['member', ['payments'], [READ_PAYMENTS]]);
  });

  it('a token without any group is a member with no grants', async () => {
    const s = setup();
    const who = await me(s, null);
    expect([who.role, who.groups, who.grants]).toEqual(['member', [], []]);
    expect(s.state.groupReads).toBe(0);
  });

  it('a built-in group gives its role and implicit grant, and the custom groups add theirs; groups lists the custom ones only', async () => {
    const s = setup();
    let who = await me(s, 'dmt-viewer payments');
    expect([who.role, who.groups, who.grants]).toEqual(['viewer', ['payments'], [READ_ALL, READ_PAYMENTS]]);
    who = await me(s, 'dmt-admin dmt-viewer data payments');
    expect([who.role, who.groups, who.grants]).toEqual(['admin', ['data', 'payments'], [ALL, WAKE_DATA, READ_PAYMENTS]]);
    who = await me(s, 'dmt-operator');
    expect([who.role, who.groups, who.grants]).toEqual(['operator', [], [ALL]]);
  });

  it('a group without grants (or deleted, or not yet listed) adds nothing', async () => {
    const s = setup();
    expect((await me(s, 'dmt-viewer ghost')).grants).toEqual([READ_ALL]);
  });

  it('reads the groups\' grants once a minute per instance', async () => {
    const s = setup();
    await me(s, 'payments');
    s.setGroups([{ name: 'payments', grants: [WAKE_DATA] }]);
    s.advance(59_000);
    expect((await me(s, 'payments')).grants).toEqual([READ_PAYMENTS]);
    s.advance(1_000);
    expect((await me(s, 'payments')).grants).toEqual([WAKE_DATA]);
    expect(s.state.groupReads).toBe(2);
  });

  it('a member has none of the fleet routes, but reads who they are and keeps their preferences', async () => {
    const s = setup();
    for (const path of ['/api/routers', '/api/workloads', '/api/workloads/states', '/api/savings', '/api/alerts', '/api/operations', '/api/audit']) {
      const res = await s.api(event(path, 'payments'));
      expect([path, res.statusCode]).toEqual([path, 403]);
    }
    expect((await s.api(event('/api/me', 'payments'))).statusCode).toBe(200);
    expect((await s.api(event('/api/routers', 'dmt-viewer payments'))).statusCode).toBe(200);
  });
});

describe('the MFA policy with grants', () => {
  it('operators: a member with a wake grant needs a multi-factor session, and without it reads only', async () => {
    const s = setup('operators');
    const who = await me(s, 'data');
    expect([who.role, who.effectiveRole, who.grants]).toEqual(['member', 'member', [{ tags: { team: 'data' }, permissions: ['read'] }]]);
    expect(who.mfa).toEqual({ mode: 'operators', enabled: false, required: true, method: null, passkeys: false });
  });

  it('operators: with the authenticator set up, the member keeps their wake grant', async () => {
    const s = setup('operators', { enrolled: new Set(['u-1']) });
    const who = await me(s, 'data');
    expect([who.effectiveRole, who.grants, who.mfa.required, who.mfa.enabled]).toEqual(['member', [WAKE_DATA], true, true]);
  });

  it('operators: a member with read grants only needs no MFA', async () => {
    const s = setup('operators');
    const who = await me(s, 'payments');
    expect([who.grants, who.mfa.required]).toEqual([[READ_PAYMENTS], false]);
  });

  it('operators: a viewer with a wake grant needs MFA, a plain viewer does not', async () => {
    const s = setup('operators');
    let who = await me(s, 'dmt-viewer data');
    expect([who.role, who.effectiveRole, who.mfa.required, who.grants]).toEqual(['viewer', 'viewer', true, [READ_ALL, { tags: { team: 'data' }, permissions: ['read'] }]]);
    who = await me(s, 'dmt-viewer');
    expect([who.mfa.required, who.grants]).toEqual([false, [READ_ALL]]);
  });

  it('operators: an operator without MFA acts as a viewer, with read grants only', async () => {
    const s = setup('operators');
    const who = await me(s, 'dmt-operator data');
    expect([who.role, who.effectiveRole, who.grants]).toEqual(['operator', 'viewer', [READ_ALL, { tags: { team: 'data' }, permissions: ['read'] }]]);
    const routers = await s.api(event('/api/routers', 'dmt-operator'));
    expect(routers.statusCode).toBe(200);
  });

  it('optional: grants are never reduced', async () => {
    const s = setup('optional');
    expect((await me(s, 'data')).grants).toEqual([WAKE_DATA]);
  });

  it('required: a member without MFA reads who they are and nothing else', async () => {
    const s = setup('required');
    const who = await me(s, 'payments');
    expect([who.effectiveRole, who.grants]).toEqual([null, [{ tags: { team: 'payments' }, permissions: ['read'] }]]);
    const res = await s.api(event('/api/workloads', 'payments'));
    expect([res.statusCode, json(res).error]).toEqual([403, 'mfa_required']);
  });

  it('with passkeys, a multi-factor session (amr) gives the wake grant', async () => {
    const s = setup('operators', { passkeys: true });
    expect((await me(s, 'data', '[swk]')).grants).toEqual([WAKE_DATA]);
    expect((await me(s, 'data', '[pwd]')).grants).toEqual([{ tags: { team: 'data' }, permissions: ['read'] }]);
  });
});
