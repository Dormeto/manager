// Event-driven discovery refresh (packaging design §5): the connect and disconnect operations install and remove an
// account's forwarder (a role, a rule per region to the manager's bus) through the command role.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AccountScan, Connection, DiscoveryStore } from '@dormeto/discovery';
import published from './fixtures/blueprint.json' with { type: 'json' };
import type { Blueprint } from '../src/blueprint.js';
import { Conflict, createEngine } from '../src/engine.js';
import { createInstaller } from '../src/installer.js';
import { createRecords } from '../src/records.js';
import { fakeDynamo } from './dynamo-fake.js';
import { fakeInstallAccount } from './install-fake.js';
import { fakeEks } from './eks-fake.js';

const ACCOUNT = '222222222222';
const BUS = 'arn:aws:events:eu-west-1:121014831971:event-bus/dmt-dev-manager';
const ZIP = new Uint8Array([1]);

function setup({ commandMissing = false } = {}) {
  let now = Date.UTC(2026, 9, 6, 12, 0);
  let ids = 0;
  const records = createRecords({ dynamo: fakeDynamo(), table: 't', now: () => now });
  // One IAM for the account, EventBridge per region.
  const iam = fakeInstallAccount();
  const regions: Record<string, ReturnType<typeof fakeInstallAccount>> = { 'eu-west-1': fakeInstallAccount(), 'eu-west-3': fakeInstallAccount(), 'us-east-1': fakeInstallAccount() };
  const connections = new Map<string, Connection>();
  const scan = { account: ACCOUNT, access: { discovery: { ok: true }, command: commandMissing ? { ok: false, reason: 'access denied' } : { ok: true }, checkedAt: '2026-10-06T11:00:00.000Z' } } as unknown as AccountScan;
  const discovery = {
    getConnection: async (account: string) => connections.get(account) ?? null,
    putConnection: async (c: Connection) => { connections.set(c.account, c); },
    deleteConnection: async (account: string) => { connections.delete(account); },
    getAccountScan: async (account: string) => (account === ACCOUNT ? scan : null),
  } as unknown as DiscoveryStore;
  const engine = createEngine({
    records, discovery,
    routers: async () => [],
    target: async (_account, region) => ({
      eks: fakeEks([]),
      installer: (options) => createInstaller({ ...regions[region]!.ports, iam: iam.ports.iam }, options),
      invoke: async () => { throw new Error('no router call'); },
    }),
    bundle: async () => ({ blueprint: published as unknown as Blueprint, zip: ZIP, codeSha256: createHash('sha256').update(ZIP).digest('base64') }),
    settings: { env: 'dev', principals: [], routerSettings: { ipListsCatalog: 's3://dmt-dev-manager-ip-lists-121014831971/catalog.json', ipListsBucket: 'dmt-dev-manager-ip-lists-121014831971', checkSchedule: 'rate(5 minutes)', ipLists: '[]', noWakeRules: '[]', metrics: 'false', managerBus: BUS, commandRole: 'DmtCommandRole' } },
    start: async (op) => `arn:execution:${op.id}`,
    now: () => now, newId: () => `op${++ids}`, log: { info() {}, warn() {}, error() {} },
  });
  const drive = async (id: string) => {
    for (let i = 0; i < 50; i += 1) {
      const r = await engine.next(id);
      if (r.done) return r.status;
      now += (r.waitSeconds ?? 0) * 1000;
    }
    throw new Error('never done');
  };
  return { engine, records, iam, regions, connections, drive };
}

describe('connect and disconnect an account', () => {
  it('connect installs the forwarder role once and one rule per region to the manager\'s bus, records the connection; a rerun changes nothing', async () => {
    const s = setup();
    const op = await s.engine.create('connect-account', { account: ACCOUNT, regions: ['eu-west-1', 'eu-west-3'] }, 'discovery');
    expect(op.activeKey).toBe(`ACCT#${ACCOUNT}`);
    expect(await s.drive(op.id)).toBe('succeeded');
    const role = s.iam.state.roles.get('dmtr-dev-forwarder')!;
    expect(role.path).toBe('/dormeto/router/');
    expect(role.boundary).toBe(`arn:aws:iam::${ACCOUNT}:policy/DmtRouterBoundary`);
    expect(JSON.parse(role.trust).Statement[0].Principal).toEqual({ Service: 'events.amazonaws.com' });
    expect(JSON.parse(role.policies.get('forwarder')!).Statement[0].Resource).toEqual([BUS]);
    for (const region of ['eu-west-1', 'eu-west-3']) {
      const rule = s.regions[region]!.state.eventRules.get('dmtr-dev-discovery')!;
      expect(rule.state).toBe('ENABLED');
      expect(JSON.parse(rule.pattern).detail.userIdentity.arn[0]['anything-but'].prefix).toContain(`arn:aws:sts::${ACCOUNT}:assumed-role/DmtCommandRole/`);
      expect(rule.targets).toEqual([{ Id: 'manager', Arn: BUS, RoleArn: `arn:aws:iam::${ACCOUNT}:role/dormeto/router/dmtr-dev-forwarder` }]);
    }
    expect(s.regions['us-east-1']!.state.eventRules.size).toBe(0);
    expect(s.connections.get(ACCOUNT)).toEqual({ account: ACCOUNT, regions: ['eu-west-1', 'eu-west-3'], status: 'connected', connectedAt: expect.any(String) });
    // Again: every step finds what it wants.
    const writes = () => [s.iam, ...Object.values(s.regions)].flatMap((a) => a.state.calls).filter((c) => /^(create|put|update|delete|remove)/.test(c)).length;
    const before = writes();
    const again = await s.engine.create('connect-account', { account: ACCOUNT, regions: ['eu-west-1', 'eu-west-3'] }, 'discovery');
    expect(await s.drive(again.id)).toBe('succeeded');
    expect(writes()).toBe(before);
    expect((await s.records.getOperation(again.id))!.steps.slice(0, 2).map((st) => st.status)).toEqual(['skipped', 'skipped']);
  });

  it('disconnect deletes the rules of every connected region, then the role, and forgets the connection', async () => {
    const s = setup();
    await s.drive((await s.engine.create('connect-account', { account: ACCOUNT, regions: ['eu-west-1', 'eu-west-3'] }, 'discovery')).id);
    // The regions recorded by the connection, whatever the disconnect names.
    const op = await s.engine.create('disconnect-account', { account: ACCOUNT, regions: [] }, 'discovery');
    expect(await s.drive(op.id)).toBe('succeeded');
    for (const region of ['eu-west-1', 'eu-west-3']) expect(s.regions[region]!.state.eventRules.has('dmtr-dev-discovery')).toBe(false);
    expect(s.iam.state.roles.has('dmtr-dev-forwarder')).toBe(false);
    expect(s.connections.has(ACCOUNT)).toBe(false);
  });

  it('a disconnect of an account never connected is done at once, changing nothing', async () => {
    const s = setup();
    const op = await s.engine.create('disconnect-account', { account: ACCOUNT, regions: [] }, 'discovery');
    expect(await s.drive(op.id)).toBe('succeeded');
    expect((await s.records.getOperation(op.id))!.steps.map((st) => st.status)).toEqual(['skipped', 'skipped', 'skipped']);
  });

  it('the connections task creates the operations; an account with one running is skipped, and one without the command role refused', async () => {
    const s = setup();
    const first = await s.engine.connections({ connect: [{ account: ACCOUNT, regions: ['eu-west-1'] }], disconnect: [] }, 'discovery');
    expect(first.created).toHaveLength(1);
    // While it runs: one operation per account at a time.
    await expect(s.engine.create('disconnect-account', { account: ACCOUNT, regions: [] }, 'discovery')).rejects.toBeInstanceOf(Conflict);
    const second = await s.engine.connections({ connect: [], disconnect: [ACCOUNT] }, 'discovery');
    expect(second).toEqual({ created: [], skipped: [{ account: ACCOUNT, reason: 'another operation runs on this account' }] });
    const refused = setup({ commandMissing: true });
    const out = await refused.engine.connections({ connect: [{ account: ACCOUNT, regions: ['eu-west-1'] }], disconnect: [] }, 'discovery');
    expect(out).toEqual({ created: [], skipped: [{ account: ACCOUNT, reason: 'no command role: access denied' }] });
  });

  it('refuses a malformed account or region before anything starts', async () => {
    const s = setup();
    await expect(s.engine.create('connect-account', { account: '2222', regions: ['eu-west-1'] }, 'discovery')).rejects.toThrow(/account/);
    await expect(s.engine.create('connect-account', { account: ACCOUNT, regions: ['eu-west-1', 'x/y'] }, 'discovery')).rejects.toThrow(/region/);
  });
});

describe('the forwarder\'s calls', () => {
  it('are all allowed by the command role\'s policy, connecting and disconnecting', async () => {
    const { ACTIONS, allows, role, rule } = await import('./command-policy.js');
    const s = setup();
    await s.drive((await s.engine.create('connect-account', { account: ACCOUNT, regions: ['eu-west-1', 'eu-west-3'] }, 'discovery')).id);
    await s.drive((await s.engine.create('disconnect-account', { account: ACCOUNT, regions: [] }, 'discovery')).id);
    const calls = new Set([s.iam, ...Object.values(s.regions)].flatMap((a) => a.state.calls));
    expect(calls.size).toBeGreaterThan(8);
    for (const call of calls) {
      const actions = ACTIONS[call];
      expect(actions, `${call} has its IAM actions`).toBeDefined();
      for (const [action, context] of actions!) expect(allows(action, action.startsWith('iam:') ? role : rule, context), `${call}: ${action}`).toBe(true);
    }
  });
});

describe('a connect failing part-way (R5c review I4, I5)', () => {
  it('records the regions it attempted and its error; a disconnect then removes what it created', async () => {
    const s = setup();
    // The command role without PassRole to EventBridge (or another refusal) in the second region.
    s.regions['eu-west-3']!.ports.events.putTargets = async () => { throw Object.assign(new Error('not authorized to perform: iam:PassRole'), { name: 'AccessDeniedException' }); };
    const op = await s.engine.create('connect-account', { account: ACCOUNT, regions: ['eu-west-1', 'eu-west-3'] }, 'discovery');
    expect(await s.drive(op.id)).toBe('failed');
    expect(s.connections.get(ACCOUNT)).toEqual({ account: ACCOUNT, regions: ['eu-west-1', 'eu-west-3'], status: 'connecting', connectedAt: expect.any(String), lastError: expect.stringMatching(/iam:PassRole/), failedAt: expect.any(String) });
    expect(s.regions['eu-west-1']!.state.eventRules.has('dmtr-dev-discovery')).toBe(true);
    expect(await s.drive((await s.engine.create('disconnect-account', { account: ACCOUNT, regions: [] }, 'discovery')).id)).toBe('succeeded');
    for (const region of ['eu-west-1', 'eu-west-3']) expect(s.regions[region]!.state.eventRules.has('dmtr-dev-discovery')).toBe(false);
    expect(s.iam.state.roles.has('dmtr-dev-forwarder')).toBe(false);
    expect(s.connections.has(ACCOUNT)).toBe(false);
  });

  it('a successful connect clears an earlier failure', async () => {
    const s = setup();
    s.connections.set(ACCOUNT, { account: ACCOUNT, regions: ['eu-west-1'], status: 'connecting', connectedAt: '2026-10-05T12:00:00.000Z', lastError: 'x', failedAt: '2026-10-05T12:00:00.000Z' } as never);
    expect(await s.drive((await s.engine.create('connect-account', { account: ACCOUNT, regions: ['eu-west-1'] }, 'discovery')).id)).toBe('succeeded');
    expect(s.connections.get(ACCOUNT)).toEqual({ account: ACCOUNT, regions: ['eu-west-1'], status: 'connected', connectedAt: expect.any(String) });
  });
});
