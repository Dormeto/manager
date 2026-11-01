// The waiting page at its three levels (branded waiting page design §11 and §12): the organization's in settings.json, the
// router's and the workload's through the router's waiting-page action; who may touch a custom page (administrators, at every
// level, whatever the path), their audit, which holds no page, and the router before 0.35.0.
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createApi, RouterError, type ApiEvent, type AuditEntry, type Invoke } from '../src/api.js';
import { cleanPage } from '../src/page-settings.js';

const NOW = Date.UTC(2026, 10, 1, 12, 0);
const AT = new Date(NOW).toISOString();
const MANAGER = '121014831971';
const ROUTERS = [{ name: 'dmt-dev', region: 'eu-west-1', controller: 'dmt-dev-controller', account: MANAGER }];
const GROUPS = [{ name: 'pausers', description: '', grants: [{ tags: { team: 'payments' }, permissions: ['read', 'wake', 'nap'] }], updatedAt: null, updatedBy: null }];
const TEMPLATE = { mode: 'template', icon: 'none', title: 'Acme portal', description: 'Our test environment sleeps at night.' };
const SECRET_HTML = '<!doctype html><p data-dormeto="status"></p><!-- SECRET-MARKER -->';
const CUSTOM = { mode: 'custom', html: SECRET_HTML };
const ICON = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64')}`;
const TF = 'workload tf was written by Terraform: set waiting_page in its workload module';
// The audit's hash is of the HTML alone, so that `shasum page.html` matches it.
const sha = (html: string) => createHash('sha256').update(html).digest('hex');
const removed = (html: string) => ` (removed custom page: ${Buffer.byteLength(html)} bytes, sha256 ${sha(html)})`;

// A router at 0.35.0, as far as these routes can tell: one stored page per level, the view it answers.
function setup(opts: { invoke?: Invoke; doc?: Record<string, unknown> | null; noStore?: boolean; read?: () => Promise<unknown>; stored?: Record<string, unknown>; mfa?: boolean } = {}) {
  const audit: AuditEntry[] = [];
  const calls: Record<string, unknown>[] = [];
  const store = { doc: opts.doc ?? null, writes: [] as Record<string, unknown>[] };
  const levels: Record<string, unknown> = { ...opts.stored };
  const api = createApi({
    routers: ROUTERS, now: () => NOW, newId: () => 'id-1', version: '0.20.0', managerAccount: MANAGER,
    audit: { write: async (e) => { audit.push(e); }, list: async () => audit },
    async invoke(router, payload, options) {
      calls.push(payload);
      if (opts.invoke) return opts.invoke(router, payload, options);
      if (payload.action === 'waiting-page') {
        const level = String(payload.workloadId ?? 'router');
        if (payload.op === 'put') levels[level] = payload.page;
        if (payload.op === 'delete') delete levels[level];
        return { own: cleanPage(levels[level]), inherited: { mode: 'template', icon: 'auto' }, effective: cleanPage(levels[level]), from: {}, favicon: null, warnings: [], terraform: false, by: null, at: null };
      }
      if (payload.action === 'status') return { workloadId: payload.workloadId, state: 'AWAKE', tags: { team: payload.workloadId === 'other' ? 'billing' : 'payments' } };
      return null;
    },
    fleet: { listRouters: async () => [], listGroups: async () => GROUPS, getWorkload: async () => null } as never,
    ...(opts.mfa ? { mfa: { mode: 'operators' as const, passkeys: false, enabled: async () => false } } : {}),
    ...(opts.noStore ? {} : { globalSettings: { read: (opts.read ?? (async () => store.doc)) as () => Promise<Record<string, unknown> | null>, write: async (d: Record<string, unknown>) => { store.writes.push(d); store.doc = d; } } }),
  });
  const pageCalls = () => calls.filter((c) => c.action === 'waiting-page');
  return { api, audit, calls, store, levels, pageCalls };
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
const ORG = '/api/settings/waiting-page';
const ROUTER = '/api/routers/dmt-dev/waiting-page';
const WL = (id = 'pay') => `/api/workloads/dmt-dev/${id}/waiting-page`;
const refusals = (s: { audit: AuditEntry[] }) => s.audit.filter((e) => e.result === 'refused');

describe('the organization level', () => {
  it('GET answers the page, its warnings and its own author and date to every signed-in role, a member included', async () => {
    const doc = { waitingPage: { ...CUSTOM, by: 'a@example.com', at: '2026-10-20T10:00:00.000Z' }, updatedAt: '2026-10-21T10:00:00.000Z', updatedBy: 'hibernate@example.com' };
    for (const groups of ['dmt-viewer', 'dmt-operator', 'dmt-admin', 'payments']) {
      const res = await setup({ doc }).api(event('GET', ORG, groups));
      expect([res.statusCode, json(res)], groups).toEqual([200, { page: CUSTOM, warnings: [], by: 'a@example.com', at: '2026-10-20T10:00:00.000Z' }]);
    }
  });

  it('GET reads through the same rules as the routers: an invalid stored page reads as none, and a missing store or file as none', async () => {
    const none = { page: null, warnings: [], by: null, at: null };
    for (const doc of [null, {}, { waitingPage: { mode: 'custom', html: ' ' } }, { waitingPage: 'x' }]) {
      expect(json(await setup({ doc }).api(event('GET', ORG, 'dmt-viewer'))), JSON.stringify(doc)).toEqual(none);
    }
    expect(json(await setup({ noStore: true }).api(event('GET', ORG, 'dmt-viewer')))).toEqual(none);
    const unreadable = await setup({ read: async () => { throw new SyntaxError('not json'); } }).api(event('GET', ORG, 'dmt-viewer'));
    expect([unreadable.statusCode, json(unreadable)]).toEqual([200, { ...none, error: 'settings.json is unreadable' }]);
    expect(json(await setup({ doc: { waitingPage: { mode: 'template', title: 'x' }, other: 1 } }).api(event('GET', ORG, 'dmt-viewer'))).page).toEqual({ mode: 'template', title: 'x' });
  });

  it('PUT writes waitingPage with its own author and date into the whole document, keeping every other key, hibernation\'s author and date included', async () => {
    const s = setup({ doc: { workloads: { hibernate: false }, other: 1, updatedAt: 'T0', updatedBy: 'hib@example.com' } });
    const res = await s.api(event('PUT', ORG, 'dmt-admin', { page: TEMPLATE }));
    expect([res.statusCode, json(res)]).toEqual([200, { page: TEMPLATE, warnings: [], by: 'dmt-admin@example.com', at: AT, note: 'routers apply it within about a minute' }]);
    expect(s.store.writes).toEqual([{ workloads: { hibernate: false }, other: 1, updatedAt: 'T0', updatedBy: 'hib@example.com', waitingPage: { ...TEMPLATE, by: 'dmt-admin@example.com', at: AT } }]);
    expect(s.audit.at(-1)).toMatchObject({ action: 'waiting-page', target: 'organization', result: 'organization template', who: 'dmt-admin@example.com' });
  });

  it('PUT of a custom page answers its warnings and audits its size and SHA-256, never the page', async () => {
    const s = setup();
    const html = '<p>é</p>';
    const res = await s.api(event('PUT', ORG, 'dmt-admin', { page: { mode: 'custom', html } }));
    expect(json(res).warnings).toHaveLength(1);
    expect(s.audit.at(-1)!.result).toBe(`organization custom, ${Buffer.byteLength(html)} bytes, sha256 ${sha(html)}`);
  });

  it('PUT refuses everyone but administrators, a template included, with audited refusals and nothing written', async () => {
    const s = setup();
    for (const groups of ['dmt-viewer', 'dmt-operator', 'payments']) {
      for (const page of [TEMPLATE, CUSTOM]) expect((await s.api(event('PUT', ORG, groups, { page }))).statusCode, groups).toBe(403);
      expect((await s.api(event('DELETE', ORG, groups))).statusCode, groups).toBe(403);
    }
    expect(s.store.writes).toEqual([]);
    expect(refusals(s).map((e) => [e.who, e.action, e.target])).toEqual([
      ['dmt-viewer@example.com', 'waiting-page', 'organization'], ['dmt-viewer@example.com', 'waiting-page-clear', 'organization'],
      ['dmt-operator@example.com', 'waiting-page', 'organization'], ['dmt-operator@example.com', 'waiting-page-clear', 'organization'],
      ['payments@example.com', 'waiting-page', 'organization'], ['payments@example.com', 'waiting-page-clear', 'organization'],
    ]);
  });

  it('PUT answers 400 with the sentences, from the router\'s rules, and writes nothing', async () => {
    const s = setup();
    const bad = await s.api(event('PUT', ORG, 'dmt-admin', { page: { mode: 'template', title: 'a'.repeat(81), html: 'x' } }));
    expect([bad.statusCode, json(bad).message]).toEqual([400, 'html is not a field of a template page; title must be at most 80 characters']);
    for (const body of [{}, { page: null }, { page: 'x' }, { page: [] }]) expect((await s.api(event('PUT', ORG, 'dmt-admin', body))).statusCode, JSON.stringify(body)).toBe(400);
    expect(s.store.writes).toEqual([]);
    expect(s.audit).toEqual([]);
  });

  it('PUT replaces an unreadable settings.json, logged, as the hibernation default does', async () => {
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const s = setup({ read: async () => { throw new SyntaxError('not json'); } });
      expect((await s.api(event('PUT', ORG, 'dmt-admin', { page: TEMPLATE }))).statusCode).toBe(200);
      expect(s.store.writes).toEqual([{ waitingPage: { ...TEMPLATE, by: 'dmt-admin@example.com', at: AT } }]);
      expect(quiet).toHaveBeenCalledWith(expect.stringContaining('GlobalSettingsReplaced'));
    } finally {
      quiet.mockRestore();
    }
  });

  it('PUT and DELETE answer 404 in a manager without a lists bucket', async () => {
    const s = setup({ noStore: true });
    expect((await s.api(event('PUT', ORG, 'dmt-admin', { page: TEMPLATE }))).statusCode).toBe(404);
    expect((await s.api(event('DELETE', ORG, 'dmt-admin'))).statusCode).toBe(404);
  });

  it('DELETE removes the key and keeps the rest, audited with the custom page it removes, also when there is none', async () => {
    const s = setup({ doc: { workloads: { hibernate: false }, waitingPage: { ...CUSTOM, by: 'a@example.com', at: 'T0' }, other: 1, updatedAt: 'T1', updatedBy: 'hib@example.com' } });
    const res = await s.api(event('DELETE', ORG, 'dmt-admin'));
    expect([res.statusCode, json(res).page]).toEqual([200, null]);
    expect(s.store.writes).toEqual([{ workloads: { hibernate: false }, other: 1, updatedAt: 'T1', updatedBy: 'hib@example.com' }]);
    expect(s.audit.at(-1)).toMatchObject({ action: 'waiting-page-clear', target: 'organization', result: `organization cleared${removed(SECRET_HTML)}` });
    expect((await setup().api(event('DELETE', ORG, 'dmt-admin'))).statusCode).toBe(200);
  });

  it('PUT over a custom page audits the page it replaces', async () => {
    const s = setup({ doc: { waitingPage: CUSTOM } });
    await s.api(event('PUT', ORG, 'dmt-admin', { page: TEMPLATE }));
    expect(s.audit.at(-1)!.result).toBe(`organization template${removed(SECRET_HTML)}`);
  });

  it('each setting\'s write keeps the other, and its author and date', async () => {
    const s = setup({ doc: { workloads: { hibernate: true } } });
    await s.api(event('PUT', ORG, 'dmt-admin', { page: TEMPLATE }));
    const cli = `arn:aws:iam::${MANAGER}:user/cli`;
    await s.api(iam('PUT', '/iam/settings/workloads', { hibernate: false }));
    expect(s.store.doc).toMatchObject({ workloads: { hibernate: false }, waitingPage: { ...TEMPLATE, by: 'dmt-admin@example.com', at: AT }, updatedBy: cli });
    expect(json(await s.api(event('GET', ORG, 'dmt-viewer'))).by).toBe('dmt-admin@example.com');
    await s.api(event('PUT', ORG, 'dmt-admin', { page: { mode: 'template', title: 'New' } }));
    expect(s.store.doc).toMatchObject({ workloads: { hibernate: false }, updatedBy: cli, waitingPage: { mode: 'template', title: 'New', by: 'dmt-admin@example.com' } });
    expect(json(await s.api(event('GET', '/api/settings/workloads', 'dmt-viewer'))).updatedBy).toBe(cli);
  });

  it('is reached through /iam/ as an administrator, custom pages included', async () => {
    const s = setup();
    expect((await s.api(iam('PUT', `/iam${ORG.slice(4)}`, { page: CUSTOM }))).statusCode).toBe(200);
    expect(s.audit.at(-1)).toMatchObject({ who: `arn:aws:iam::${MANAGER}:user/cli`, result: expect.stringContaining('organization custom') });
    expect((await s.api(iam('GET', `/iam${ORG.slice(4)}`))).statusCode).toBe(200);
    expect((await s.api(iam('DELETE', `/iam${ORG.slice(4)}`))).statusCode).toBe(200);
  });
});

describe('the router level', () => {
  it('GET relays the router\'s view to the built-in roles, and a member is refused', async () => {
    const s = setup({ stored: { router: TEMPLATE } });
    for (const groups of ['dmt-viewer', 'dmt-operator', 'dmt-admin']) expect(json(await s.api(event('GET', ROUTER, groups))).own, groups).toEqual(TEMPLATE);
    expect(s.pageCalls()[0]).toEqual({ action: 'waiting-page', op: 'get', by: 'dmt-viewer@example.com' });
    expect((await s.api(event('GET', ROUTER, 'payments'))).statusCode).toBe(403);
  });

  it('PUT and DELETE are for administrators only, a template too, audited when refused; nothing is called', async () => {
    const s = setup();
    for (const groups of ['dmt-viewer', 'dmt-operator', 'payments']) {
      for (const page of [TEMPLATE, CUSTOM]) expect((await s.api(event('PUT', ROUTER, groups, { page }))).statusCode, groups).toBe(403);
      expect((await s.api(event('DELETE', ROUTER, groups))).statusCode, groups).toBe(403);
    }
    expect(s.pageCalls()).toEqual([]);
    expect(refusals(s).map((e) => [e.who, e.action, e.target])).toEqual([
      ['dmt-viewer@example.com', 'waiting-page', 'dmt-dev'], ['dmt-viewer@example.com', 'waiting-page-clear', 'dmt-dev'],
      ['dmt-operator@example.com', 'waiting-page', 'dmt-dev'], ['dmt-operator@example.com', 'waiting-page-clear', 'dmt-dev'],
      ['payments@example.com', 'waiting-page', 'dmt-dev'], ['payments@example.com', 'waiting-page-clear', 'dmt-dev'],
    ]);
  });

  it('PUT sends the page to the router and audits the level, mode, size and SHA-256 of the HTML of a custom one', async () => {
    const s = setup();
    const res = await s.api(event('PUT', ROUTER, 'dmt-admin', { page: CUSTOM }));
    expect([res.statusCode, json(res).own]).toEqual([200, CUSTOM]);
    expect(s.pageCalls().map((c) => c.op)).toEqual(['get', 'put']);
    expect(s.pageCalls()[1]).toEqual({ action: 'waiting-page', op: 'put', page: CUSTOM, by: 'dmt-admin@example.com' });
    expect(s.audit.at(-1)).toMatchObject({ action: 'waiting-page', target: 'dmt-dev', result: `router custom, ${Buffer.byteLength(SECRET_HTML)} bytes, sha256 ${sha(SECRET_HTML)}` });
    await s.api(event('PUT', ROUTER, 'dmt-admin', { page: TEMPLATE }));
    expect(s.audit.at(-1)!.result).toBe(`router template${removed(SECRET_HTML)}`);
    await s.api(event('PUT', ROUTER, 'dmt-admin', { page: CUSTOM }));
    const cleared = await s.api(event('DELETE', ROUTER, 'dmt-admin'));
    expect([cleared.statusCode, json(cleared).own]).toEqual([200, null]);
    expect(s.pageCalls().at(-1)).toEqual({ action: 'waiting-page', op: 'delete', by: 'dmt-admin@example.com' });
    expect(s.audit.at(-1)).toMatchObject({ action: 'waiting-page-clear', target: 'dmt-dev', result: `router cleared${removed(SECRET_HTML)}` });
  });

  it('relays the router\'s problems as 400, and says an old router is too old', async () => {
    const bad = setup({ invoke: async () => ({ problems: ['title must be at most 80 characters'] }) });
    const res = await bad.api(event('PUT', ROUTER, 'dmt-admin', { page: TEMPLATE }));
    expect([res.statusCode, json(res).message]).toEqual([400, 'title must be at most 80 characters']);
    const old = setup({ invoke: async () => { throw new RouterError('unknown action: waiting-page'); } });
    for (const [method, body] of [['GET', undefined], ['PUT', { page: TEMPLATE }], ['DELETE', undefined]] as const) {
      const answer = await old.api(event(method, ROUTER, 'dmt-admin', body));
      expect([answer.statusCode, json(answer).message], method).toEqual([409, 'upgrade the router to 0.35.0']);
    }
    expect((await old.api(event('PUT', ROUTER, 'dmt-admin', { page: 'x' }))).statusCode).toBe(400);
  });

  it('is reached through /iam/', async () => {
    const s = setup();
    expect((await s.api(iam('PUT', '/iam/routers/dmt-dev/waiting-page', { page: CUSTOM }))).statusCode).toBe(200);
    expect(s.pageCalls()[1]).toMatchObject({ op: 'put', by: `arn:aws:iam::${MANAGER}:user/cli` });
  });
});

describe('the workload level', () => {
  it('GET relays the router\'s view to the built-in roles', async () => {
    const s = setup({ stored: { pay: CUSTOM } });
    for (const groups of ['dmt-viewer', 'dmt-operator', 'dmt-admin']) expect(json(await s.api(event('GET', WL(), groups))).own, groups).toEqual(CUSTOM);
    expect(s.pageCalls()[0]).toEqual({ action: 'waiting-page', op: 'get', workloadId: 'pay', by: 'dmt-viewer@example.com' });
  });

  it('GET lets a member read the page of a workload their grants read, and no other\'s', async () => {
    const s = setup({ stored: { pay: CUSTOM, other: TEMPLATE } });
    expect(json(await s.api(event('GET', WL(), 'pausers'))).own).toEqual(CUSTOM);
    // Tagged team=billing: the grant does not cover it, and it answers as an unknown workload, the router unasked.
    const calls = s.pageCalls().length;
    const other = await s.api(event('GET', WL('other'), 'pausers'));
    expect([other.statusCode, json(other).error]).toEqual([404, 'not_found']);
    expect((await s.api(event('GET', WL(), 'payments'))).statusCode).toBe(404);
    expect(s.pageCalls()).toHaveLength(calls);
  });

  it('PUT of a template is for operators and administrators, each reading what is stored first', async () => {
    const s = setup();
    for (const groups of ['dmt-operator', 'dmt-admin']) {
      const res = await s.api(event('PUT', WL(), groups, { page: TEMPLATE }));
      expect([res.statusCode, json(res).own], groups).toEqual([200, TEMPLATE]);
    }
    expect(s.pageCalls().map((c) => c.op)).toEqual(['get', 'put', 'get', 'put']);
    expect(s.audit.at(-1)).toMatchObject({ action: 'waiting-page', target: 'dmt-dev/pay', result: 'workload template' });
  });

  it('refuses a viewer and a group grant to write, a grant of wake and nap included: audited, and the router is not called', async () => {
    const s = setup();
    for (const groups of ['dmt-viewer', 'pausers', 'payments']) {
      expect((await s.api(event('PUT', WL(), groups, { page: TEMPLATE }))).statusCode, groups).toBe(403);
      expect((await s.api(event('DELETE', WL(), groups))).statusCode, groups).toBe(403);
    }
    expect(s.pageCalls()).toEqual([]);
    expect(refusals(s).map((e) => [e.who, e.action, e.target])).toEqual([
      ['dmt-viewer@example.com', 'waiting-page', 'dmt-dev/pay'], ['dmt-viewer@example.com', 'waiting-page-clear', 'dmt-dev/pay'],
      ['pausers@example.com', 'waiting-page', 'dmt-dev/pay'], ['pausers@example.com', 'waiting-page-clear', 'dmt-dev/pay'],
      ['payments@example.com', 'waiting-page', 'dmt-dev/pay'], ['payments@example.com', 'waiting-page-clear', 'dmt-dev/pay'],
    ]);
  });

  it('refuses an operator\'s PUT of a custom page: 403, audited, and the router is not called', async () => {
    const s = setup();
    const res = await s.api(event('PUT', WL(), 'dmt-operator', { page: CUSTOM }));
    expect([res.statusCode, json(res).error]).toEqual([403, 'forbidden']);
    expect(json(res).message).toContain('admin role required');
    expect(s.pageCalls()).toEqual([]);
    expect(s.audit).toHaveLength(1);
    expect(s.audit[0]).toMatchObject({ action: 'waiting-page', target: 'dmt-dev/pay', result: 'refused', who: 'dmt-operator@example.com', role: 'operator' });
  });

  it('refuses an operator\'s PUT of whatever is not exactly a template, before anything else', async () => {
    const s = setup();
    for (const page of [{ mode: 'Custom', html: 'x' }, { mode: 'both' }, { html: SECRET_HTML }, { mode: ['template'] }]) {
      expect((await s.api(event('PUT', WL(), 'dmt-operator', { page }))).statusCode, JSON.stringify(page)).toBe(403);
    }
    expect(s.pageCalls()).toEqual([]);
  });

  it('refuses an operator\'s PUT of a template over a custom page: it reads the router first, then 403, audited, nothing written', async () => {
    const s = setup({ stored: { pay: CUSTOM } });
    const res = await s.api(event('PUT', WL(), 'dmt-operator', { page: TEMPLATE }));
    expect(res.statusCode).toBe(403);
    expect(s.pageCalls().map((c) => c.op)).toEqual(['get']);
    expect(s.levels.pay).toEqual(CUSTOM);
    expect(s.audit[0]).toMatchObject({ action: 'waiting-page', target: 'dmt-dev/pay', result: 'refused' });
  });

  it('refuses an operator\'s DELETE of a custom page the same way, and lets it clear a template or nothing', async () => {
    const s = setup({ stored: { pay: CUSTOM, tpl: TEMPLATE } });
    expect((await s.api(event('DELETE', WL(), 'dmt-operator'))).statusCode).toBe(403);
    expect(s.pageCalls().map((c) => c.op)).toEqual(['get']);
    expect(s.levels.pay).toEqual(CUSTOM);
    expect(s.audit[0]).toMatchObject({ action: 'waiting-page-clear', target: 'dmt-dev/pay', result: 'refused' });
    expect((await s.api(event('DELETE', WL('tpl'), 'dmt-operator'))).statusCode).toBe(200);
    expect(s.levels.tpl).toBeUndefined();
    expect((await s.api(event('DELETE', WL('none'), 'dmt-operator'))).statusCode).toBe(200);
    expect(s.audit.at(-1)).toMatchObject({ action: 'waiting-page-clear', target: 'dmt-dev/none', result: 'workload cleared' });
  });

  it('treats what it cannot read as custom: an answer without a clear own page is the administrators\'', async () => {
    for (const answer of [null, {}, { own: undefined }, { own: { mode: 'custom' } }, { own: 'x' }]) {
      const s = setup({ invoke: async () => answer });
      expect((await s.api(event('PUT', WL(), 'dmt-operator', { page: TEMPLATE }))).statusCode, JSON.stringify(answer)).toBe(403);
      expect((await s.api(event('DELETE', WL(), 'dmt-operator'))).statusCode, JSON.stringify(answer)).toBe(403);
      expect(s.pageCalls().map((c) => c.op)).toEqual(['get', 'get']);
    }
  });

  it('lets an administrator set, replace and clear a custom page, auditing the size and hash of the HTML, and of the page removed', async () => {
    const s = setup();
    const first = { mode: 'custom', html: '<!doctype html><p>One</p>' };
    const next = { mode: 'custom', html: '<!doctype html><p>New</p>' };
    expect((await s.api(event('PUT', WL(), 'dmt-admin', { page: first }))).statusCode).toBe(200);
    expect(s.audit.at(-1)!.result).toBe(`workload custom, ${Buffer.byteLength(first.html)} bytes, sha256 ${sha(first.html)}`);
    expect((await s.api(event('PUT', WL(), 'dmt-admin', { page: next }))).statusCode).toBe(200);
    expect(s.audit.at(-1)!.result).toBe(`workload custom, ${Buffer.byteLength(next.html)} bytes, sha256 ${sha(next.html)}${removed(first.html)}`);
    expect((await s.api(event('DELETE', WL(), 'dmt-admin'))).statusCode).toBe(200);
    expect(s.audit.at(-1)!.result).toBe(`workload cleared${removed(next.html)}`);
    expect(s.pageCalls().map((c) => c.op)).toEqual(['get', 'put', 'get', 'put', 'get', 'delete']);
  });

  it('answers 409 for a Terraform workload, 404 for an unknown one, 400 for problems and 409 for an old router, also on the operator\'s read', async () => {
    const s = setup({ invoke: async (_r, payload) => {
      if (payload.workloadId === 'tf') throw new RouterError(TF);
      if (payload.workloadId === 'gone') throw new RouterError('workload not configured: gone');
      if (payload.workloadId === 'bad') return { problems: ['title must be one line of text'] };
      throw new RouterError('unknown action: waiting-page');
    } });
    const put = (id: string, groups = 'dmt-admin') => s.api(event('PUT', WL(id), groups, { page: TEMPLATE }));
    const tf = await put('tf');
    expect([tf.statusCode, json(tf)]).toEqual([409, { error: 'conflict', message: TF }]);
    expect((await put('gone')).statusCode).toBe(404);
    expect(json(await put('bad')).message).toBe('title must be one line of text');
    expect(json(await put('old')).message).toBe('upgrade the router to 0.35.0');
    const operator = await put('old', 'dmt-operator');
    expect([operator.statusCode, json(operator).message]).toEqual([409, 'upgrade the router to 0.35.0']);
  });

  it('is reached through /iam/ as an administrator, custom pages included', async () => {
    const s = setup({ stored: { pay: CUSTOM } });
    expect((await s.api(iam('PUT', '/iam/workloads/dmt-dev/pay/waiting-page', { page: { mode: 'custom', html: '<p>x</p>' } }))).statusCode).toBe(200);
    expect((await s.api(iam('DELETE', '/iam/workloads/dmt-dev/pay/waiting-page'))).statusCode).toBe(200);
    expect((await s.api(iam('GET', '/iam/workloads/dmt-dev/pay/waiting-page'))).statusCode).toBe(200);
    expect(s.pageCalls().map((c) => c.op)).toEqual(['get', 'put', 'get', 'delete', 'get']);
  });
});

describe('what is never in an audit entry, a log line or an error', () => {
  it('holds no HTML and no icon in any entry, in the logs or in a refusal', async () => {
    const logs: string[] = [];
    const spies = (['log', 'info', 'warn', 'error'] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); }));
    try {
      const s = setup({ stored: { pay: CUSTOM } });
      const withIcon = { mode: 'template', icon: ICON, title: 'ICON-TITLE' };
      for (const [method, path, groups, page] of [
        ['PUT', ORG, 'dmt-admin', CUSTOM], ['PUT', ORG, 'dmt-operator', CUSTOM], ['PUT', ROUTER, 'dmt-admin', CUSTOM], ['PUT', WL(), 'dmt-admin', withIcon],
        ['PUT', WL('a'), 'dmt-operator', CUSTOM], ['PUT', WL(), 'dmt-operator', withIcon], ['DELETE', WL(), 'dmt-operator', undefined],
        ['PUT', ORG, 'dmt-admin', { mode: 'custom', html: SECRET_HTML, icon: ICON }],
      ] as const) await s.api(event(method, path, groups, page === undefined ? undefined : { page }));
      const seen = JSON.stringify(s.audit) + logs.join('\n');
      expect(s.audit.length).toBeGreaterThan(5);
      for (const marker of ['SECRET-MARKER', ICON, ICON.slice(30), '<!doctype']) expect(seen, marker).not.toContain(marker);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});

describe('a request body', () => {
  const big = { mode: 'custom', html: `<!doctype html><p data-dormeto="status"></p>${'"quote" \\ \n é </'.repeat(14_000)}`.slice(0, 256 * 1024) };
  it('takes a page of 256 KiB, JSON-escaped, to the router unchanged, and refuses a byte more', async () => {
    expect(Buffer.byteLength(big.html)).toBeLessThanOrEqual(256 * 1024);
    const exact = { mode: 'custom', html: `<p data-dormeto="status"></p>${'"é\n'.repeat(60_000)}`.slice(0, 256 * 1024 - 1) + 'a' };
    const s = setup();
    for (const page of [big, exact]) expect((await s.api(event('PUT', WL(), 'dmt-admin', { page }))).statusCode).toBe(200);
    expect(s.pageCalls().filter((c) => c.op === 'put')[1]!.page).toEqual(exact);
    const over = await s.api(event('PUT', ORG, 'dmt-admin', { page: { mode: 'custom', html: 'a'.repeat(256 * 1024 + 1) } }));
    expect([over.statusCode, json(over).message]).toEqual([400, 'html must be at most 256 KiB']);
  });

  it('is decoded when the gateway hands it over as base64', async () => {
    const s = setup();
    const raw = event('PUT', ROUTER, 'dmt-admin', { page: big });
    const res = await s.api({ ...raw, body: Buffer.from(raw.body!).toString('base64'), isBase64Encoded: true });
    expect(res.statusCode).toBe(200);
    expect(s.pageCalls().find((c) => c.op === 'put')!.page).toEqual(big);
  });
});

describe('a member\'s refused write', () => {
  it('is audited, whatever the level', async () => {
    const s = setup();
    for (const path of [ORG, ROUTER, WL()]) expect((await s.api(event('PUT', path, 'pausers', { page: TEMPLATE }))).statusCode, path).toBe(403);
    expect(refusals(s).map((e) => [e.who, e.action, e.target])).toEqual([
      ['pausers@example.com', 'waiting-page', 'organization'], ['pausers@example.com', 'waiting-page', 'dmt-dev'], ['pausers@example.com', 'waiting-page', 'dmt-dev/pay'],
    ]);
    expect(s.pageCalls()).toEqual([]);
  });
});

describe('the two-step verification policy', () => {
  it('lets an administrator or operator not yet enrolled read, and refuses every write as a viewer would, audited', async () => {
    const s = setup({ mfa: true, stored: { pay: CUSTOM } });
    for (const groups of ['dmt-admin', 'dmt-operator']) {
      expect((await s.api(event('GET', WL(), groups))).statusCode, groups).toBe(200);
      const res = await s.api(event('PUT', ORG, groups, { page: CUSTOM }));
      expect(res.statusCode, groups).toBe(403);
      if (groups === 'dmt-admin') expect(json(res).message).toContain('two-step verification required');
      expect((await s.api(event('PUT', ROUTER, groups, { page: TEMPLATE }))).statusCode, groups).toBe(403);
      expect((await s.api(event('PUT', WL(), groups, { page: CUSTOM }))).statusCode, groups).toBe(403);
      expect((await s.api(event('PUT', WL(), groups, { page: TEMPLATE }))).statusCode, groups).toBe(403);
      expect((await s.api(event('DELETE', WL(), groups))).statusCode, groups).toBe(403);
    }
    expect(s.pageCalls().map((c) => c.op)).toEqual(['get', 'get']);
    expect(s.store.writes).toEqual([]);
    expect(s.levels.pay).toEqual(CUSTOM);
    expect(refusals(s).every((e) => e.role === 'viewer')).toBe(true);
    expect(refusals(s).length).toBeGreaterThan(4);
  });
});

describe('the sentences a write answers', () => {
  const KEY = `<!doctype html><script>SECRET-KEY</script>${'k'.repeat(600_000)}`;
  const bounded = (text: string, max = 400) => {
    expect(text).not.toContain('<');
    expect(text).not.toContain('SECRET-KEY</script>');
    expect(text.length).toBeLessThan(max);
  };

  it('never echoes a key of the body without bound or HTML, at the organization', async () => {
    const s = setup();
    const res = await s.api(event('PUT', ORG, 'dmt-admin', { page: { mode: 'template', [KEY]: 1 } }));
    expect(res.statusCode).toBe(400);
    bounded(json(res).message);
    expect(json(res).message).toMatch(/ is not a field of a template page$/);
  });

  it('strips and bounds what the router says, in the answer and in the audit entry', async () => {
    const s = setup({ invoke: async () => ({ problems: [`${KEY} is not a field of a template page`, ...Array.from({ length: 50 }, (_, i) => `problem ${i} <b>${'x'.repeat(5000)}`)] }) });
    for (const [path, groups] of [[ROUTER, 'dmt-admin'], [WL(), 'dmt-operator']] as const) {
      const res = await s.api(event('PUT', path, groups, { page: TEMPLATE }));
      expect(res.statusCode).toBe(400);
      bounded(json(res).message, 1100);
    }
    expect(s.audit.length).toBeGreaterThan(0);
    for (const entry of s.audit) bounded(entry.result, 1200);
  });

  it('keeps a short key, so that the author sees which one', async () => {
    const res = await setup().api(event('PUT', ORG, 'dmt-admin', { page: { mode: 'template', colour: 'red' } }));
    expect(json(res).message).toBe('colour is not a field of a template page');
  });
});
