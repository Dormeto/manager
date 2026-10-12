// Organization access (packaging design §3): the panel's report, and what a missing command role refuses before an
// operation starts.
import { describe, expect, it } from 'vitest';
import type { AccessSummary, AccountScan } from '@dormeto/discovery';
import { createApi, type ApiEvent } from '../src/api.js';
import { NOW, candidate, memoryStore } from './memory-store.js';

const READY = '111111111111';
const NO_COMMAND = '222222222222';
const UNCHECKED = '333333333333';
const DENIED = 'access denied: the role is missing or does not trust the manager';
const tg = (account: string) => `arn:aws:elasticloadbalancing:eu-west-1:${account}:targetgroup/app/73e2d6bc24d8a067`;
const row = (account: string, command: boolean) => ({ account, name: `n${account}`, discovery: { ok: true as const }, command: command ? { ok: true as const } : { ok: false as const, reason: DENIED } });

function setup({ visible, discoveryOnly = false }: { visible?: (identity: unknown, item: { account?: string; region: string }) => boolean; discoveryOnly?: boolean } = {}) {
  const store = memoryStore([READY, NO_COMMAND, UNCHECKED].map((account) => candidate(tg(account), { account, region: 'eu-west-1', targetGroupArn: tg(account) })));
  const scans: Record<string, AccountScan> = {
    [READY]: { account: READY, scannedAt: '', regions: {}, access: { discovery: { ok: true }, command: { ok: true }, checkedAt: '' } },
    [NO_COMMAND]: { account: NO_COMMAND, scannedAt: '', regions: {}, access: { discovery: { ok: true }, command: discoveryOnly ? { ok: false, reason: 'discovery only: set up without the command role', discoveryOnly: true } : { ok: false, reason: DENIED }, checkedAt: '' } },
  };
  store.getAccountScan = async (account: string) => scans[account] ?? null;
  const summary: AccessSummary = {
    counts: { ready: 1, discoveryMissing: 0, commandMissing: 2, unchecked: 1 }, accounts: [row(NO_COMMAND, false), row('444444444444', false)], delegation: 'ok', checkedAt: new Date(NOW).toISOString(),
    forwarders: { connected: 1, connecting: 0, impossible: [{ account: NO_COMMAND, name: 'shop', reason: 'no command role' }], failed: [{ account: '444444444444', name: 'data', reason: 'AccessDenied' }] },
    discoveryOnly: [NO_COMMAND, '555555555555'],
  };
  const pages: { cursor?: string; limit: number }[] = [];
  store.accessReport = async (page) => {
    pages.push(page);
    const after = page.cursor ? summary.accounts.filter((a) => a.account > page.cursor!) : summary.accounts;
    return { ...summary, accounts: after.slice(0, page.limit), cursor: after.length > page.limit ? after[page.limit - 1]!.account : null };
  };
  const created: [string, Record<string, unknown>][] = [];
  const api = createApi({
    routers: [], now: () => NOW, version: '0.2.0', newId: () => 'x1',
    audit: { write: async () => {}, list: async () => [] },
    async invoke() { return null; },
    discovery: { store, run: async () => {} },
    operations: { async create(type: string, input: Record<string, unknown>) { created.push([type, input]); return { id: 'op1', type } as never; }, list: async () => [], get: async () => null, installedRouters: async () => [] } as never,
    accessRoles: { discoveryRole: 'DmtDiscoveryRole', commandRole: 'DmtCommandRole' },
    ...(visible ? { visible } : {}),
  });
  return { api, created, pages };
}
const event = (method: string, path: string, body?: unknown, query: Record<string, string> = {}): ApiEvent => ({
  rawPath: path, queryStringParameters: query, body: body === undefined ? undefined : JSON.stringify(body),
  requestContext: { http: { method }, authorizer: { jwt: { claims: { sub: 'u-1', email: 'ops@example.com', 'cognito:groups': '[dmt-admin]' } } } },
});
const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');

describe('organization access', () => {
  it('gives the counts and pages the accounts not ready; the caller sees only the accounts visible to them', async () => {
    const s = setup();
    const first = json(await s.api(event('GET', '/api/discovery/access', undefined, { limit: '1' })));
    expect([first.counts, first.delegation, first.accounts.map((a: { account: string }) => a.account), first.cursor]).toEqual([{ ready: 1, discoveryMissing: 0, commandMissing: 2, unchecked: 1 }, 'ok', [NO_COMMAND], NO_COMMAND]);
    const second = json(await s.api(event('GET', '/api/discovery/access', undefined, { limit: '1', cursor: first.cursor })));
    expect([second.accounts.map((a: { account: string }) => a.account), second.cursor]).toEqual([['444444444444'], null]);
    expect((await s.api(event('GET', '/api/discovery/access', undefined, { limit: '0' }))).statusCode).toBe(400);
    const hidden = setup({ visible: (_i, item) => item.account !== NO_COMMAND });
    expect(json(await hidden.api(event('GET', '/api/discovery/access'))).accounts.map((a: { account: string }) => a.account)).toEqual(['444444444444']);
    // The forwarders' accounts too (R5c review I6).
    const forwarders = json(await hidden.api(event('GET', '/api/discovery/access'))).forwarders;
    expect([forwarders.impossible, forwarders.failed.map((f: { account: string }) => f.account)]).toEqual([[], ['444444444444']]);
    expect(json(await hidden.api(event('GET', '/api/discovery/access'))).discoveryOnly).toEqual(['555555555555']);
    const none = setup({ visible: () => false });
    expect(json(await none.api(event('GET', '/api/discovery/access'))).forwarders).toMatchObject({ impossible: [], failed: [] });
  });

  it('refuses onboarding where the last check found no command role; an account never checked, or ready, is let through', async () => {
    const s = setup();
    const refused = await s.api(event('POST', '/api/operations', { type: 'onboard', candidateId: tg(NO_COMMAND) }));
    expect([refused.statusCode, json(refused)]).toEqual([409, { error: 'no_access', message: `account ${NO_COMMAND}: its command role DmtCommandRole cannot be assumed (${DENIED}); see the Organization access page` }]);
    expect((await s.api(event('POST', '/api/operations', { type: 'install-router', account: NO_COMMAND, region: 'eu-west-1' }))).statusCode).toBe(409);
    for (const account of [READY, UNCHECKED]) expect((await s.api(event('POST', '/api/operations', { type: 'onboard', candidateId: tg(account) }))).statusCode).toBe(202);
    expect(s.created.map(([type]) => type)).toEqual(['onboard', 'onboard']);
  });

  it('refuses onboarding and router installs in an account set up for discovery only, saying so', async () => {
    const only = setup({ discoveryOnly: true });
    const res = await only.api(event('POST', '/api/operations', { type: 'install-router', account: NO_COMMAND, region: 'eu-west-1' }));
    expect(res.statusCode).toBe(409);
    expect(json(res)).toEqual({ error: 'no_access', message: `account ${NO_COMMAND} is set up for discovery only (its access has no command role): onboarding and router installs are not possible there` });
  });

  it('the discovery answer names the roles, set in the manager\'s Terraform', async () => {
    const s = setup();
    expect(json(await s.api(event('GET', '/api/discovery'))).access).toEqual({ discoveryRole: 'DmtDiscoveryRole', commandRole: 'DmtCommandRole', source: 'terraform' });
  });
});
