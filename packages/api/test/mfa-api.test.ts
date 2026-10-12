import { describe, expect, it } from 'vitest';
import { createApi, type ApiEvent, type AuditEntry, type MfaMode, type UsersService } from '../src/api.js';

// The MFA policy (R6c): administrators and operators without MFA act as viewers under `operators`; nobody without MFA
// passes `required` but to read who they are.
function setup(mode: MfaMode, enrolled: Set<string> = new Set(), failing = false) {
  let now = 0;
  const reads: string[] = [];
  const audit: AuditEntry[] = [];
  const resets: string[] = [];
  const users = {
    async list() { return [{ email: 'a@example.com', role: 'admin', status: 'CONFIRMED', enabled: true, createdAt: null, mfa: true }]; },
    async invite() { return { invitation: 'sent' as const }; },
    async resend() { return { invitation: 'sent' as const }; },
    async setRole() {},
    async setEnabled() {},
    async resetMfa(email: string) { resets.push(email); return { tokenDeleted: true }; },
  } satisfies UsersService;
  const api = createApi({
    routers: [], invoke: async () => ({}), audit: { write: async (e) => { audit.push(e); }, list: async () => audit },
    now: () => now, newId: () => 'id', version: '0.4.0', users,
    mfa: { mode, async enabled(username) { reads.push(username); if (failing) throw new Error('TooManyRequestsException'); return enrolled.has(username); } },
  });
  return { api, reads, audit, resets, enrolled, advance: (ms: number) => { now += ms; } };
}

const event = (method: string, path: string, groups: string, query?: Record<string, string>): ApiEvent => ({
  rawPath: path, queryStringParameters: query,
  requestContext: { http: { method }, authorizer: { jwt: { claims: { sub: 's-1', 'cognito:username': 'u-1', email: 'admin@example.com', 'cognito:groups': `[${groups}]` } } } },
});
const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');

describe('MFA policy', () => {
  it('operators: an administrator without MFA acts as a viewer, and may read who they are', async () => {
    const s = setup('operators');
    expect(json(await s.api(event('GET', '/api/me', 'dmt-admin')))).toEqual({
      email: 'admin@example.com', groups: ['dmt-admin'], role: 'admin', effectiveRole: 'viewer', mfa: { mode: 'operators', enabled: false, required: true },
    });
    expect((await s.api(event('GET', '/api/users', 'dmt-admin'))).statusCode).toBe(403);
    expect((await s.api(event('GET', '/api/routers', 'dmt-admin'))).statusCode).toBe(200);
    s.enrolled.add('u-1');
    const me = json(await s.api(event('GET', '/api/me', 'dmt-admin', { fresh: '1' })));
    expect([me.effectiveRole, me.mfa.enabled]).toEqual(['admin', true]);
    expect((await s.api(event('GET', '/api/users', 'dmt-admin'))).statusCode).toBe(200);
  });

  it('operators: a viewer needs no MFA, and is never read for it on its routes', async () => {
    const s = setup('operators');
    expect((await s.api(event('GET', '/api/routers', 'dmt-viewer'))).statusCode).toBe(200);
    expect(s.reads).toEqual([]);
    const me = json(await s.api(event('GET', '/api/me', 'dmt-viewer')));
    expect([me.effectiveRole, me.mfa.required]).toEqual(['viewer', false]);
  });

  it('required: refuses everything without MFA but /api/me', async () => {
    const s = setup('required');
    const refused = await s.api(event('GET', '/api/routers', 'dmt-viewer'));
    expect(refused.statusCode).toBe(403);
    expect(json(refused)).toEqual({ error: 'mfa_required', message: 'two-step verification required: set it up from your Account page' });
    const me = json(await s.api(event('GET', '/api/me', 'dmt-viewer')));
    expect([me.effectiveRole, me.mfa]).toEqual([null, { mode: 'required', enabled: false, required: true }]);
  });

  it('optional: the role as given, MFA or not', async () => {
    const s = setup('optional');
    expect((await s.api(event('GET', '/api/users', 'dmt-admin'))).statusCode).toBe(200);
    expect(json(await s.api(event('GET', '/api/me', 'dmt-admin'))).mfa).toEqual({ mode: 'optional', enabled: false, required: false });
  });

  it('caches what Cognito says: 5 minutes when MFA is on, 30 seconds when off; fresh reads again', async () => {
    const s = setup('operators');
    await s.api(event('GET', '/api/routers', 'dmt-admin'));
    await s.api(event('GET', '/api/routers', 'dmt-admin'));
    expect(s.reads).toHaveLength(1);
    s.advance(31_000);
    await s.api(event('GET', '/api/routers', 'dmt-admin'));
    expect(s.reads).toHaveLength(2);
    s.enrolled.add('u-1');
    await s.api(event('GET', '/api/me', 'dmt-admin', { fresh: '1' }));
    expect(s.reads).toHaveLength(3);
    s.advance(4 * 60_000);
    await s.api(event('GET', '/api/routers', 'dmt-admin'));
    expect(s.reads).toHaveLength(3);
    s.advance(2 * 60_000);
    await s.api(event('GET', '/api/routers', 'dmt-admin'));
    expect(s.reads).toHaveLength(4);
  });

  it('an administrator resets the MFA of another user, audited; never their own', async () => {
    const s = setup('operators', new Set(['u-1']));
    expect((await s.api(event('POST', '/api/users/ops%40example.com/mfa/reset', 'dmt-admin'))).statusCode).toBe(200);
    expect(s.resets).toEqual(['ops@example.com']);
    expect(s.audit.map((e) => [e.action, e.target, e.result])).toEqual([['mfa-reset', 'ops@example.com', 'reset, authenticator deleted']]);
    expect((await s.api(event('POST', '/api/users/admin%40example.com/mfa/reset', 'dmt-admin'))).statusCode).toBe(409);
    expect((await s.api(event('POST', '/api/users/ops%40example.com/mfa/reset', 'dmt-operator'))).statusCode).toBe(403);
  });

  it('review M1: when Cognito cannot say, an administrator acts as a viewer and /me says the MFA is unknown; required still refuses', async () => {
    const s = setup('operators', new Set(), true);
    expect((await s.api(event('GET', '/api/routers', 'dmt-admin'))).statusCode).toBe(200);
    expect((await s.api(event('GET', '/api/users', 'dmt-admin'))).statusCode).toBe(403);
    const me = json(await s.api(event('GET', '/api/me', 'dmt-admin')));
    expect([me.effectiveRole, me.mfa]).toEqual(['viewer', { mode: 'operators', enabled: null, required: true }]);
    const optional = setup('optional', new Set(), true);
    expect(json(await optional.api(event('GET', '/api/me', 'dmt-admin'))).effectiveRole).toBe('admin');
    const required = setup('required', new Set(), true);
    expect((await required.api(event('GET', '/api/routers', 'dmt-viewer'))).statusCode).toBe(403);
  });

  it('review M6: an administrator without MFA is told why an admin route refuses them', async () => {
    const s = setup('operators');
    expect(json(await s.api(event('GET', '/api/users', 'dmt-admin')))).toEqual({ error: 'forbidden', message: 'two-step verification required to use your admin rights: set it up from your Account page' });
    expect(json(await s.api(event('GET', '/api/users', 'dmt-viewer'))).message).toBe('admin role required');
  });

  it('review M10: an operator without MFA is a viewer under operators; with MFA, required lets requests through', async () => {
    const s = setup('operators');
    expect(json(await s.api(event('GET', '/api/me', 'dmt-operator'))).effectiveRole).toBe('viewer');
    const required = setup('required', new Set(['u-1']));
    expect((await required.api(event('GET', '/api/routers', 'dmt-viewer'))).statusCode).toBe(200);
  });
});
