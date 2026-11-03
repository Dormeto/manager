// The hibernation setting at its three levels (EC2 hibernation design §3 and §5): the manager's global settings.json,
// the router's and the workload's settings through the router, who may, their audit, and the router before 0.32.0.
import { describe, expect, it, vi } from 'vitest';
import { createApi, RouterError, type ApiEvent, type AuditEntry, type Invoke } from '../src/api.js';

const NOW = Date.UTC(2026, 9, 24, 12, 0);
const MANAGER = '121014831971';
const ROUTERS = [{ name: 'dmt-dev', region: 'eu-west-1', controller: 'dmt-dev-controller', account: MANAGER }];
const TF = 'workload tf was written by Terraform: set hibernate in its workload module';
const ROUTER_SETTINGS = { hibernate: false, by: 'a@example.com', at: '2026-10-24T11:00:00.000Z' };
const MANAGER_SETTINGS = { url: 's3://dmt-prd-manager-ip-lists-121014831971/settings.json', hibernate: true, readAt: '2026-10-24T11:57:00.000Z', error: null };

function setup(opts: { invoke?: Invoke; doc?: Record<string, unknown> | null; noStore?: boolean; read?: () => Promise<unknown> } = {}) {
  const audit: AuditEntry[] = [];
  const calls: Record<string, unknown>[] = [];
  const store = { doc: opts.doc ?? null, writes: [] as Record<string, unknown>[] };
  const api = createApi({
    routers: ROUTERS, now: () => NOW, newId: () => 'id-1', version: '0.19.0', managerAccount: MANAGER,
    audit: { write: async (e) => { audit.push(e); }, list: async () => audit },
    async invoke(router, payload, options) {
      calls.push(payload);
      if (opts.invoke) return opts.invoke(router, payload, options);
      if (payload.action === 'settings') return { level: payload.workloadId ? 'workload' : 'router', settings: payload.settings };
      // As router 0.32.0 answers: its settings and what it read of the manager's beside `router`, with ISO times.
      if (payload.action === 'router') {
        return {
          router: { name: 'dmt-dev', version: '0.32.0', build: 'b1' }, settings: ROUTER_SETTINGS, managerSettings: MANAGER_SETTINGS,
          pauses: [], workloads: { total: 0, byState: {}, paused: 0, lastActivityAt: null }, health: { status: 'ok', problems: [], checkSchedule: null, lastScheduledCheckAt: null },
        };
      }
      if (payload.action === 'status') return { workloadId: payload.workloadId, state: 'AWAKE', hibernation: { hibernate: true, from: 'router' } };
      return null;
    },
    ...(opts.noStore ? {} : { globalSettings: { read: (opts.read ?? (async () => store.doc)) as () => Promise<Record<string, unknown> | null>, write: async (d: Record<string, unknown>) => { store.writes.push(d); store.doc = d; } } }),
  });
  return { api, audit, calls, store };
}
const event = (method: string, path: string, groups: string, body?: unknown): ApiEvent => ({
  rawPath: path, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  requestContext: { http: { method }, authorizer: { jwt: { claims: { email: `${groups || 'none'}@example.com`, sub: 'u-1', 'cognito:groups': `[${groups}]` } } } },
});
const iam = (method: string, path: string, body?: unknown): ApiEvent => ({
  rawPath: path, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  requestContext: { http: { method }, authorizer: { iam: { userArn: `arn:aws:iam::${MANAGER}:user/cli`, userId: 'AIDAX', accountId: MANAGER } } },
});
const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');
const NOTE = 'routers apply it at their next check, within 5 minutes';

describe('GET /api/settings/workloads', () => {
  it('answers true and nulls while settings.json does not exist, to every signed-in role', async () => {
    const s = setup();
    for (const groups of ['dmt-viewer', 'dmt-operator', 'dmt-admin', 'payments']) {
      const res = await s.api(event('GET', '/api/settings/workloads', groups));
      expect([res.statusCode, json(res)], groups).toEqual([200, { hibernate: true, joinMinutes: null, endedWindowDays: null, defaults: {}, updatedAt: null, updatedBy: null }]);
    }
  });

  it('answers what the object holds, and true when it holds no hibernate', async () => {
    const doc = { workloads: { hibernate: false }, updatedAt: '2026-10-20T10:00:00.000Z', updatedBy: 'a@example.com', other: 1 };
    expect(json(await setup({ doc }).api(event('GET', '/api/settings/workloads', 'dmt-viewer')))).toEqual({ hibernate: false, joinMinutes: null, endedWindowDays: null, defaults: {}, updatedAt: doc.updatedAt, updatedBy: 'a@example.com' });
    expect(json(await setup({ doc: { other: 1 } }).api(event('GET', '/api/settings/workloads', 'dmt-viewer'))).hibernate).toBe(true);
  });

  it('answers the defaults in a manager without a lists bucket', async () => {
    const res = await setup({ noStore: true }).api(event('GET', '/api/settings/workloads', 'dmt-viewer'));
    expect([res.statusCode, json(res)]).toEqual([200, { hibernate: true, joinMinutes: null, endedWindowDays: null, defaults: {}, updatedAt: null, updatedBy: null }]);
  });

  it('is reached through /iam/ too', async () => {
    expect((await setup().api(iam('GET', '/iam/settings/workloads'))).statusCode).toBe(200);
  });
});

describe('PUT /api/settings/workloads', () => {
  it('writes the whole document keeping the keys it does not know, audited, and says when routers apply it', async () => {
    const s = setup({ doc: { other: 1 } });
    const res = await s.api(event('PUT', '/api/settings/workloads', 'dmt-admin', { hibernate: false }));
    const at = new Date(NOW).toISOString();
    expect([res.statusCode, json(res)]).toEqual([200, { hibernate: false, joinMinutes: null, endedWindowDays: null, defaults: {}, updatedAt: at, updatedBy: 'dmt-admin@example.com', note: NOTE }]);
    expect(s.store.writes).toEqual([{ workloads: { hibernate: false }, updatedAt: at, updatedBy: 'dmt-admin@example.com', other: 1 }]);
    expect(s.audit.at(-1)).toMatchObject({ action: 'settings', target: 'workloads', result: 'hibernate off', who: 'dmt-admin@example.com' });
  });

  it('keeps the other keys of workloads, and starts a document when there is none', async () => {
    const s = setup({ doc: { workloads: { hibernate: true, later: 2 } } });
    await s.api(event('PUT', '/api/settings/workloads', 'dmt-admin', { hibernate: true }));
    expect(s.store.writes[0]).toMatchObject({ workloads: { hibernate: true, later: 2 } });
    const t = setup();
    await t.api(event('PUT', '/api/settings/workloads', 'dmt-admin', { hibernate: true }));
    expect(t.store.writes[0]).toEqual({ workloads: { hibernate: true }, updatedAt: new Date(NOW).toISOString(), updatedBy: 'dmt-admin@example.com' });
    expect(t.audit.at(-1)!.result).toBe('hibernate on');
  });

  it('refuses everyone but administrators, with an audited refusal and nothing written', async () => {
    const s = setup();
    for (const groups of ['dmt-viewer', 'dmt-operator', 'payments', '']) expect((await s.api(event('PUT', '/api/settings/workloads', groups, { hibernate: false }))).statusCode, groups).toBe(403);
    expect(s.store.writes).toEqual([]);
    // A viewer and an operator are refused and audited; a member never reaches the route.
    expect(s.audit.map((e) => [e.action, e.target, e.result, e.reason])).toEqual([
      ['settings', 'workloads', 'refused', 'admin role required'], ['settings', 'workloads', 'refused', 'admin role required'],
    ]);
  });

  it('refuses a body that is not {hibernate: boolean} with 400', async () => {
    const s = setup();
    for (const body of [{ hibernate: 'no' }, { hibernate: null }, {}, { hibernate: 1 }]) {
      const res = await s.api(event('PUT', '/api/settings/workloads', 'dmt-admin', body));
      expect([res.statusCode, json(res).error], JSON.stringify(body)).toEqual([400, 'bad_request']);
    }
    expect(s.store.writes).toEqual([]);
  });

  it('answers 404 in a manager without a lists bucket', async () => {
    const res = await setup({ noStore: true }).api(event('PUT', '/api/settings/workloads', 'dmt-admin', { hibernate: true }));
    expect([res.statusCode, json(res)]).toEqual([404, { error: 'not_found', message: 'no settings in this manager' }]);
  });

  it('is reached through /iam/, by the ARN', async () => {
    const s = setup();
    const res = await s.api(iam('PUT', '/iam/settings/workloads', { hibernate: false }));
    expect(res.statusCode).toBe(200);
    expect(json(res).updatedBy).toBe(`arn:aws:iam::${MANAGER}:user/cli`);
  });
});

const UNREADABLE = 'settings.json is unreadable: this write would replace it, losing what it holds. Repair the file, or set hibernate, which replaces it.';
const JOIN_PROBLEM = 'joinMinutes: a whole number from 0 to 120, a multiple of 5';
const BAD_JOINS = [-5, 7, 2.5, 125, '15', true, {}, []];

describe('the organization\'s joinMinutes in /api/settings/workloads', () => {
  const read = async (doc: Record<string, unknown>) => json(await setup({ doc }).api(event('GET', '/api/settings/workloads', 'dmt-viewer')));

  it('reads what the object holds, 0 included, and null when it is unset or not a value', async () => {
    expect((await read({ workloads: { joinMinutes: 30 } })).joinMinutes).toBe(30);
    expect((await read({ workloads: { joinMinutes: 0 } })).joinMinutes).toBe(0);
    for (const joinMinutes of [...BAD_JOINS, null]) expect((await read({ workloads: { joinMinutes } })).joinMinutes, JSON.stringify(joinMinutes)).toBeNull();
    const none = await read({ workloads: { hibernate: false } });
    expect(Object.keys(none)).toContain('joinMinutes');
    expect(none.joinMinutes).toBeNull();
  });

  it('writing it alone keeps hibernate, the other keys of workloads and of the file, and never adds a hibernate', async () => {
    const s = setup({ doc: { workloads: { hibernate: false, later: 2 }, waitingPage: { mode: 'template' }, other: 1 } });
    const res = await s.api(event('PUT', '/api/settings/workloads', 'dmt-admin', { joinMinutes: 30 }));
    const at = new Date(NOW).toISOString();
    expect([res.statusCode, json(res)]).toEqual([200, { hibernate: false, joinMinutes: 30, endedWindowDays: null, defaults: {}, updatedAt: at, updatedBy: 'dmt-admin@example.com', note: NOTE }]);
    expect(s.store.writes).toEqual([{ workloads: { hibernate: false, later: 2, joinMinutes: 30 }, waitingPage: { mode: 'template' }, other: 1, updatedAt: at, updatedBy: 'dmt-admin@example.com' }]);
    expect(s.audit.at(-1)).toMatchObject({ action: 'settings', target: 'workloads', result: 'joinMinutes 30' });
    const fresh = setup();
    const answer = await fresh.api(event('PUT', '/api/settings/workloads', 'dmt-admin', { joinMinutes: 0 }));
    expect(fresh.store.writes[0]!.workloads).toEqual({ joinMinutes: 0 });
    expect(json(answer)).toMatchObject({ hibernate: true, joinMinutes: 0 });
  });

  it('writing hibernate alone keeps it, and both can be written at once', async () => {
    const s = setup({ doc: { workloads: { hibernate: true, joinMinutes: 45 } } });
    const res = await s.api(event('PUT', '/api/settings/workloads', 'dmt-admin', { hibernate: false }));
    expect(s.store.writes[0]!.workloads).toEqual({ hibernate: false, joinMinutes: 45 });
    expect(json(res)).toMatchObject({ hibernate: false, joinMinutes: 45 });
    expect(s.audit.at(-1)!.result).toBe('hibernate off');
    await s.api(event('PUT', '/api/settings/workloads', 'dmt-admin', { hibernate: true, joinMinutes: 60 }));
    expect(s.store.writes[1]!.workloads).toEqual({ hibernate: true, joinMinutes: 60 });
    expect(s.audit.at(-1)!.result).toBe('hibernate on, joinMinutes 60');
  });

  it('null unsets it, removing the key, and answers null', async () => {
    const s = setup({ doc: { workloads: { hibernate: false, joinMinutes: 45, later: 2 } } });
    const res = await s.api(event('PUT', '/api/settings/workloads', 'dmt-admin', { joinMinutes: null }));
    expect(s.store.writes[0]!.workloads).toEqual({ hibernate: false, later: 2 });
    expect(json(res)).toMatchObject({ hibernate: false, joinMinutes: null });
    expect(Object.keys(json(res))).toContain('joinMinutes');
    expect(s.audit.at(-1)!.result).toBe('joinMinutes default');
  });

  it('refuses another value in the router\'s words, nothing written, and only administrators may', async () => {
    const s = setup({ doc: { workloads: { hibernate: true } } });
    for (const joinMinutes of BAD_JOINS) {
      const res = await s.api(event('PUT', '/api/settings/workloads', 'dmt-admin', { joinMinutes }));
      expect([res.statusCode, json(res).message], JSON.stringify(joinMinutes)).toEqual([400, JOIN_PROBLEM]);
    }
    for (const groups of ['dmt-viewer', 'dmt-operator']) expect((await s.api(event('PUT', '/api/settings/workloads', groups, { joinMinutes: 15 }))).statusCode, groups).toBe(403);
    expect(s.store.writes).toEqual([]);
    expect((await s.api(iam('PUT', '/iam/settings/workloads', { joinMinutes: 15 }))).statusCode).toBe(200);
  });

  it('a corrupt file reads null', async () => {
    expect(json(await setup({ read: async () => [1] }).api(event('GET', '/api/settings/workloads', 'dmt-viewer'))).joinMinutes).toBeNull();
  });
});

const ENDED_PROBLEM = 'endedWindowDays: 0 to keep ended windows, or a whole number of days from 30 to 3650';
const BAD_ENDED = [-1, 1, 29, 3651, 2.5, '365', true, {}, []];

describe('the organization\'s endedWindowDays in /api/settings/workloads (the user, 2026-11-02)', () => {
  const read = async (doc: Record<string, unknown>) => json(await setup({ doc }).api(event('GET', '/api/settings/workloads', 'dmt-viewer')));

  it('reads what the object holds, 0 included, and null (a year) when it is unset or not a value', async () => {
    expect((await read({ workloads: { endedWindowDays: 90 } })).endedWindowDays).toBe(90);
    expect((await read({ workloads: { endedWindowDays: 0 } })).endedWindowDays).toBe(0);
    for (const endedWindowDays of [...BAD_ENDED, null]) expect((await read({ workloads: { endedWindowDays } })).endedWindowDays, JSON.stringify(endedWindowDays)).toBeNull();
  });

  it('writing it alone keeps the rest; null unsets it; another value is refused, nothing written', async () => {
    const s = setup({ doc: { workloads: { hibernate: false, joinMinutes: 30, later: 2 }, other: 1 } });
    const res = await s.api(event('PUT', '/api/settings/workloads', 'dmt-admin', { endedWindowDays: 90 }));
    expect(json(res)).toMatchObject({ hibernate: false, joinMinutes: 30, endedWindowDays: 90 });
    expect(s.store.writes[0]!.workloads).toEqual({ hibernate: false, joinMinutes: 30, later: 2, endedWindowDays: 90 });
    expect(s.audit.at(-1)!.result).toBe('endedWindowDays 90');
    await s.api(event('PUT', '/api/settings/workloads', 'dmt-admin', { joinMinutes: 15 }));
    expect(s.store.writes[1]!.workloads).toMatchObject({ endedWindowDays: 90, joinMinutes: 15 });
    await s.api(event('PUT', '/api/settings/workloads', 'dmt-admin', { endedWindowDays: null }));
    expect(s.store.writes[2]!.workloads).not.toHaveProperty('endedWindowDays');
    expect(s.audit.at(-1)!.result).toBe('endedWindowDays default');
    for (const endedWindowDays of BAD_ENDED) {
      const bad = await s.api(event('PUT', '/api/settings/workloads', 'dmt-admin', { endedWindowDays }));
      expect([bad.statusCode, json(bad).message], JSON.stringify(endedWindowDays)).toEqual([400, ENDED_PROBLEM]);
    }
    expect(s.store.writes).toHaveLength(3);
    expect((await s.api(event('PUT', '/api/settings/workloads', 'dmt-operator', { endedWindowDays: 90 }))).statusCode).toBe(403);
  });

  it('an unreadable settings.json is not replaced by it alone', async () => {
    const s = setup({ read: async () => [1] });
    const res = await s.api(event('PUT', '/api/settings/workloads', 'dmt-admin', { endedWindowDays: 90 }));
    expect([res.statusCode, json(res).message]).toEqual([409, UNREADABLE]);
    expect(s.store.writes).toEqual([]);
  });
});

describe('a corrupt settings.json (not JSON, or not an object)', () => {
  const corrupt = [
    async () => { throw new SyntaxError('Unexpected token \'<\', "<html>" is not valid JSON'); },
    async () => [1, 2], async () => 'on', async () => 7,
  ];

  it('GET answers the defaults and says it is unreadable', async () => {
    for (const read of corrupt) {
      const res = await setup({ read }).api(event('GET', '/api/settings/workloads', 'dmt-viewer'));
      expect([res.statusCode, json(res)]).toEqual([200, { hibernate: true, joinMinutes: null, endedWindowDays: null, defaults: {}, updatedAt: null, updatedBy: null, error: 'settings.json is unreadable' }]);
    }
  });

  it('PUT starts from an empty document, logged, so that an administrator can repair it', async () => {
    const logged = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const read of corrupt) {
        const s = setup({ read });
        const res = await s.api(event('PUT', '/api/settings/workloads', 'dmt-admin', { hibernate: false }));
        expect([res.statusCode, s.store.writes]).toEqual([200, [{ workloads: { hibernate: false }, updatedAt: new Date(NOW).toISOString(), updatedBy: 'dmt-admin@example.com' }]]);
      }
      expect(logged.mock.calls.map(([line]) => JSON.parse(String(line)).event)).toEqual(Array(corrupt.length).fill('GlobalSettingsReplaced'));
    } finally {
      logged.mockRestore();
    }
  });

  it('a write that does not name hibernate does not replace it: a 409 with why, audited, nothing written', async () => {
    for (const read of corrupt) {
      const s = setup({ read });
      for (const joinMinutes of [30, null]) {
        const res = await s.api(event('PUT', '/api/settings/workloads', 'dmt-admin', { joinMinutes }));
        expect([res.statusCode, json(res).error, json(res).message]).toEqual([409, 'conflict', UNREADABLE]);
      }
      expect(s.store.writes).toEqual([]);
      expect(s.audit.at(-1)).toMatchObject({ action: 'settings', target: 'workloads', result: `error: ${UNREADABLE}` });
    }
  });

  it('a write naming hibernate replaces it with joinMinutes too', async () => {
    const logged = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const s = setup({ read: corrupt[0]! });
      const res = await s.api(event('PUT', '/api/settings/workloads', 'dmt-admin', { hibernate: false, joinMinutes: 30 }));
      expect(res.statusCode).toBe(200);
      expect(s.store.writes[0]!.workloads).toEqual({ hibernate: false, joinMinutes: 30 });
    } finally {
      logged.mockRestore();
    }
  });

  it('another read error still fails the answer', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const read = async () => { throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied' }); };
      expect((await setup({ read }).api(event('GET', '/api/settings/workloads', 'dmt-viewer'))).statusCode).toBe(500);
      const s = setup({ read });
      expect((await s.api(event('PUT', '/api/settings/workloads', 'dmt-admin', { hibernate: false }))).statusCode).toBe(500);
      expect(s.store.writes).toEqual([]);
    } finally {
      quiet.mockRestore();
    }
  });
});

describe('PUT /api/routers/:router/settings', () => {
  it('sets the router level through the controller, administrators only, audited', async () => {
    const s = setup();
    for (const groups of ['dmt-viewer', 'dmt-operator', 'payments']) expect((await s.api(event('PUT', '/api/routers/dmt-dev/settings', groups, { hibernate: null }))).statusCode, groups).toBe(403);
    expect(s.calls).toEqual([]);
    const res = await s.api(event('PUT', '/api/routers/dmt-dev/settings', 'dmt-admin', { hibernate: null }));
    expect([res.statusCode, json(res)]).toEqual([200, { level: 'router', settings: { hibernate: null } }]);
    expect(s.calls).toEqual([{ action: 'settings', settings: { hibernate: null }, by: 'dmt-admin@example.com' }]);
    expect(s.audit.at(-1)).toMatchObject({ action: 'router-settings', target: 'dmt-dev', result: 'hibernate inherit' });
    await s.api(event('PUT', '/api/routers/dmt-dev/settings', 'dmt-admin', { hibernate: false }));
    expect(s.audit.at(-1)!.result).toBe('hibernate off');
  });

  it('refuses a bad body with 400 before calling, relays the router\'s problems as 400, and says an old router is too old', async () => {
    const s = setup({ invoke: async (_r, payload) => { if ((payload.settings as { hibernate: unknown }).hibernate === true) throw new RouterError('unknown action: settings'); return { problems: ['settings: hibernate must be true, false or null'] }; } });
    expect((await s.api(event('PUT', '/api/routers/dmt-dev/settings', 'dmt-admin', { hibernate: 'x' }))).statusCode).toBe(400);
    expect(s.calls).toEqual([]);
    const problems = await s.api(event('PUT', '/api/routers/dmt-dev/settings', 'dmt-admin', { hibernate: false }));
    expect([problems.statusCode, json(problems).message]).toEqual([400, 'settings: hibernate must be true, false or null']);
    const old = await s.api(event('PUT', '/api/routers/dmt-dev/settings', 'dmt-admin', { hibernate: true }));
    expect([old.statusCode, json(old).message]).toEqual([409, 'upgrade the router to 0.32.0']);
  });

  it('is reached through /iam/', async () => {
    expect((await setup().api(iam('PUT', '/iam/routers/dmt-dev/settings', { hibernate: true }))).statusCode).toBe(200);
  });

  it('relays the router\'s settings and managerSettings in its details', async () => {
    const res = json(await setup().api(event('GET', '/api/routers/dmt-dev', 'dmt-admin')));
    expect(res.settings).toEqual(ROUTER_SETTINGS);
    expect(res.managerSettings).toEqual(MANAGER_SETTINGS);
  });
});

describe('a router\'s joinMinutes in PUT /api/routers/:router/settings', () => {
  const PUT = '/api/routers/dmt-dev/settings';

  it('passes on only the keys it received, as the same right, audited', async () => {
    const s = setup();
    for (const groups of ['dmt-viewer', 'dmt-operator', 'payments']) expect((await s.api(event('PUT', PUT, groups, { joinMinutes: 30 }))).statusCode, groups).toBe(403);
    expect(s.calls).toEqual([]);
    const by = 'dmt-admin@example.com';
    await s.api(event('PUT', PUT, 'dmt-admin', { joinMinutes: 30 }));
    expect(s.calls.at(-1)).toEqual({ action: 'settings', settings: { joinMinutes: 30 }, by });
    expect(s.audit.at(-1)).toMatchObject({ action: 'router-settings', target: 'dmt-dev', result: 'joinMinutes 30' });
    await s.api(event('PUT', PUT, 'dmt-admin', { joinMinutes: 0 }));
    expect(s.calls.at(-1)).toEqual({ action: 'settings', settings: { joinMinutes: 0 }, by });
    await s.api(event('PUT', PUT, 'dmt-admin', { joinMinutes: null }));
    expect(s.calls.at(-1)).toEqual({ action: 'settings', settings: { joinMinutes: null }, by });
    expect(s.audit.at(-1)!.result).toBe('joinMinutes inherit');
    await s.api(event('PUT', PUT, 'dmt-admin', { hibernate: false }));
    expect(s.calls.at(-1)).toEqual({ action: 'settings', settings: { hibernate: false }, by });
    await s.api(event('PUT', PUT, 'dmt-admin', { hibernate: null, joinMinutes: 45 }));
    expect(s.calls.at(-1)).toEqual({ action: 'settings', settings: { hibernate: null, joinMinutes: 45 }, by });
    expect(s.audit.at(-1)!.result).toBe('hibernate inherit, joinMinutes 45');
    expect((await s.api(iam('PUT', '/iam/routers/dmt-dev/settings', { joinMinutes: 15 }))).statusCode).toBe(200);
  });

  it('never sends the router an empty settings, which would change nothing: a body with neither is a 400', async () => {
    const s = setup();
    for (const body of [{}, { other: 1 }]) expect((await s.api(event('PUT', PUT, 'dmt-admin', body))).statusCode, JSON.stringify(body)).toBe(400);
    expect(s.calls).toEqual([]);
  });

  it('refuses another value in the router\'s words before calling', async () => {
    const s = setup();
    for (const joinMinutes of BAD_JOINS) {
      const res = await s.api(event('PUT', PUT, 'dmt-admin', { joinMinutes }));
      expect([res.statusCode, json(res).message], JSON.stringify(joinMinutes)).toEqual([400, JOIN_PROBLEM]);
    }
    expect(s.calls).toEqual([]);
  });

  it('relays an older router\'s refusal as a 400', async () => {
    const s = setup({ invoke: async () => ({ problems: ['settings: unknown setting joinMinutes'] }) });
    const res = await s.api(event('PUT', PUT, 'dmt-admin', { joinMinutes: 30 }));
    expect([res.statusCode, json(res).message]).toEqual([400, 'settings: unknown setting joinMinutes']);
  });

  it('relays the settings and the managerSettings with joinMinutes in its details', async () => {
    const managerSettings = { ...MANAGER_SETTINGS, joinMinutes: 20 };
    const settings = { ...ROUTER_SETTINGS, joinMinutes: 30 };
    const s = setup({ invoke: async () => ({ router: { name: 'dmt-dev', version: '0.36.0', build: 'b1' }, settings, managerSettings, pauses: [], workloads: { total: 0, byState: {}, paused: 0, lastActivityAt: null }, health: { status: 'ok', problems: [], checkSchedule: null, lastScheduledCheckAt: null } }) });
    const res = json(await s.api(event('GET', '/api/routers/dmt-dev', 'dmt-admin')));
    expect(res.settings).toEqual(settings);
    expect(res.managerSettings).toEqual(managerSettings);
  });
});

describe('PUT /api/workloads/:router/:id/settings', () => {
  const PUT = '/api/workloads/dmt-dev/pay/settings';
  it('sets the workload level through the controller, operators and administrators, audited', async () => {
    const s = setup();
    for (const groups of ['dmt-viewer', 'payments', '']) expect((await s.api(event('PUT', PUT, groups, { hibernate: true }))).statusCode, groups).toBe(403);
    expect(s.calls).toEqual([]);
    const res = await s.api(event('PUT', PUT, 'dmt-operator', { hibernate: false }));
    expect([res.statusCode, json(res)]).toEqual([200, { level: 'workload', settings: { hibernate: false } }]);
    expect(s.calls).toEqual([{ action: 'settings', workloadId: 'pay', settings: { hibernate: false }, by: 'dmt-operator@example.com' }]);
    expect(s.audit.at(-1)).toMatchObject({ action: 'workload-settings', target: 'dmt-dev/pay', result: 'hibernate off' });
    expect((await s.api(event('PUT', PUT, 'dmt-admin', { hibernate: null }))).statusCode).toBe(200);
    expect(s.audit.at(-1)!.result).toBe('hibernate inherit');
  });

  it('answers 409 with the router\'s words for a Terraform workload, 404 for an unknown one, 400 for problems, and says an old router is too old', async () => {
    const s = setup({ invoke: async (_r, payload) => {
      if (payload.workloadId === 'tf') throw new RouterError(TF);
      if (payload.workloadId === 'gone') throw new RouterError('workload not configured: gone');
      if (payload.workloadId === 'bad') return { problems: ['settings: unknown setting x'] };
      throw new RouterError('unknown action: settings');
    } });
    const put = (id: string) => s.api(event('PUT', `/api/workloads/dmt-dev/${id}/settings`, 'dmt-admin', { hibernate: true }));
    const tf = await put('tf');
    expect([tf.statusCode, json(tf)]).toEqual([409, { error: 'conflict', message: TF }]);
    expect((await put('gone')).statusCode).toBe(404);
    const bad = await put('bad');
    expect([bad.statusCode, json(bad).message]).toEqual([400, 'settings: unknown setting x']);
    const old = await put('old');
    expect([old.statusCode, json(old).message]).toEqual([409, 'upgrade the router to 0.32.0']);
    expect(s.audit.map((e) => e.result)).toEqual([`error: ${TF}`, 'error: workload not configured: gone', 'error: settings: unknown setting x', 'error: upgrade the router to 0.32.0']);
  });

  it('refuses a bad body with 400 before calling, and /iam/ is the same route', async () => {
    const s = setup();
    expect((await s.api(event('PUT', PUT, 'dmt-admin', { hibernate: 'yes' }))).statusCode).toBe(400);
    expect((await s.api(event('PUT', PUT, 'dmt-admin', {}))).statusCode).toBe(400);
    expect(s.calls).toEqual([]);
    expect((await s.api(iam('PUT', '/iam/workloads/dmt-dev/pay/settings', { hibernate: true }))).statusCode).toBe(200);
  });

  it('refuses joinMinutes in the router\'s words: a workload\'s is on its schedule', async () => {
    const s = setup();
    for (const body of [{ joinMinutes: 30 }, { hibernate: true, joinMinutes: 30 }, { joinMinutes: null }]) {
      const res = await s.api(event('PUT', PUT, 'dmt-admin', body));
      expect([res.statusCode, json(res).message], JSON.stringify(body)).toEqual([400, 'settings: a workload\'s joinMinutes is on its schedule']);
    }
    expect(s.calls).toEqual([]);
  });

  it('relays the value in force, its level and what is inherited in the workload\'s view', async () => {
    const answer = { joinMinutes: 30, joinFrom: 'workload', joinInherited: { joinMinutes: 15, joinFrom: 'default' }, schedule: { timeZone: 'UTC', joinMinutes: 30 }, next: [] };
    const s = setup({ invoke: async (_r, payload) => (payload.action === 'status' ? { workloadId: 'pay', state: 'AWAKE', ...answer } : null) });
    expect(json(await s.api(event('GET', PUT.replace('/settings', ''), 'dmt-admin')))).toMatchObject(answer);
  });

  it('relays hibernation in the workload\'s view', async () => {
    const res = json(await setup().api(event('GET', '/api/workloads/dmt-dev/pay', 'dmt-admin')));
    expect(res.hibernation).toEqual({ hibernate: true, from: 'router' });
  });
});
