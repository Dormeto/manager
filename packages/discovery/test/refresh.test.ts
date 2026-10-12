// Event-driven discovery refresh (packaging design §5): the trails of each ready account, the connections a run decides,
// and the rescan of the account-regions that forwarded events name.
import { describe, expect, it } from 'vitest';
import { trailCovers } from '../src/aws.js';
import { refreshAccounts, runDiscovery, runSummary } from '../src/run.js';
import { A, B, C, config, filter } from './fixtures.js';
import { setup } from './run-fakes.js';

const ON = config({ regions: ['eu-west-1', 'eu-west-3'], filters: [filter('all', [{}])], eventRefresh: { enabled: true } });

describe('CloudTrail trails', () => {
  const ARN = 'arn:aws:cloudtrail:us-east-1:111111111111:trail/all';
  const multi = { TrailARN: ARN, HomeRegion: 'us-east-1', IsMultiRegionTrail: true };
  const port = (trails: object[], { logging = true, selectors = undefined as object | undefined, denied = false } = {}) => ({
    describeTrails: async () => ({ trailList: trails }),
    getTrailStatus: async () => { if (denied) throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' }); return { IsLogging: logging }; },
    getEventSelectors: async () => selectors ?? { EventSelectors: [{ ReadWriteType: 'All', IncludeManagementEvents: true }] },
  });

  it('a trail logging the management writes covers its regions: multi-region, of the region, of the organization', async () => {
    expect(await trailCovers(port([multi]), 'eu-west-3')).toBe(true);
    expect(await trailCovers(port([{ TrailARN: ARN, HomeRegion: 'eu-west-3', IsMultiRegionTrail: false }]), 'eu-west-3')).toBe(true);
    expect(await trailCovers(port([multi], { selectors: { AdvancedEventSelectors: [{ FieldSelectors: [{ Field: 'eventCategory', Equals: ['Management'] }] }] } }), 'eu-west-3')).toBe(true);
    // The management account's organization trail: its status may not be readable from a member account.
    expect(await trailCovers(port([{ ...multi, IsOrganizationTrail: true }], { denied: true }), 'eu-west-3')).toBe(true);
  });

  it('none, another region\'s, a stopped one, read-only or data events only do not', async () => {
    expect(await trailCovers(port([]), 'eu-west-3')).toBe(false);
    expect(await trailCovers(port([{ TrailARN: ARN, HomeRegion: 'eu-west-1', IsMultiRegionTrail: false }]), 'eu-west-3')).toBe(false);
    expect(await trailCovers(port([multi], { logging: false }), 'eu-west-3')).toBe(false);
    expect(await trailCovers(port([multi], { selectors: { EventSelectors: [{ ReadWriteType: 'ReadOnly', IncludeManagementEvents: true }] } }), 'eu-west-3')).toBe(false);
    expect(await trailCovers(port([multi], { selectors: { EventSelectors: [{ ReadWriteType: 'All', IncludeManagementEvents: false }] } }), 'eu-west-3')).toBe(false);
    expect(await trailCovers(port([multi], { selectors: { AdvancedEventSelectors: [{ FieldSelectors: [{ Field: 'eventCategory', Equals: ['Management'] }, { Field: 'readOnly', Equals: ['true'] }] }] } }), 'eu-west-3')).toBe(false);
  });

  it('the account step records the trails of its regions when event refresh is on for it, and only then', async () => {
    const s = setup({ cfg: ON, regions: ['eu-west-1', 'eu-west-3'], trails: { [A.id]: ['eu-west-1', 'eu-west-3'], [B.id]: ['eu-west-3'], [C.id]: 'denied' } });
    await s.ready;
    await runDiscovery(s.deps, { source: 'manual' });
    expect((await s.store.getAccountScan(A.id))!.access?.trails).toEqual({ 'eu-west-1': true, 'eu-west-3': true });
    expect((await s.store.getAccountScan(B.id))!.access?.trails).toEqual({ 'eu-west-1': false, 'eu-west-3': true });
    expect((await s.store.getAccountScan(C.id))!.access).toMatchObject({ trails: { 'eu-west-1': false, 'eu-west-3': false }, trailsError: expect.stringMatching(/^cannot read CloudTrail: .*cloudtrail:DescribeTrails/) });
    // Off, or for other accounts: not one CloudTrail call.
    const off = setup({ cfg: { ...ON, eventRefresh: { enabled: true, accounts: [A.id] } }, regions: ['eu-west-1', 'eu-west-3'], trails: { [A.id]: ['eu-west-1'] } });
    await off.ready;
    await runDiscovery(off.deps, { source: 'manual' });
    expect(off.trailChecks.every((c) => c.startsWith(A.id))).toBe(true);
    expect((await off.store.getAccountScan(B.id))!.access?.trails).toBeUndefined();
  });
});

describe('the connections a run decides', () => {
  it('on: connects the ready accounts with a trail, in the regions with one; never one without the command role or a trail', async () => {
    const s = setup({ cfg: ON, regions: ['eu-west-1', 'eu-west-3'], denyCommand: [C.id], trails: { [A.id]: ['eu-west-1', 'eu-west-3'], [B.id]: ['eu-west-3'], [C.id]: ['eu-west-1'] } });
    await s.ready;
    const run = await runDiscovery(s.deps, { source: 'manual' });
    expect(run.connections).toEqual({ connect: [{ account: A.id, regions: ['eu-west-1', 'eu-west-3'] }, { account: B.id, regions: ['eu-west-3'] }], disconnect: [] });
    // The access summary says why the others cannot be connected.
    expect((await s.store.getAccess())!.forwarders).toEqual({
      connected: 0, connecting: 2,
      impossible: [{ account: C.id, name: C.name, reason: 'no command role' }],
    });
  });

  it('connected accounts: nothing to do again, a new trail region added; disconnected when the setting is off, the account unlisted or gone from the perimeter', async () => {
    const s = setup({ cfg: ON, regions: ['eu-west-1', 'eu-west-3'], trails: { [A.id]: ['eu-west-1', 'eu-west-3'], [B.id]: ['eu-west-3'] } });
    await s.ready;
    await s.store.putConnection({ account: A.id, regions: ['eu-west-1', 'eu-west-3'], connectedAt: '2026-10-06T10:00:00.000Z' });
    await s.store.putConnection({ account: B.id, regions: ['eu-west-1'], connectedAt: '2026-10-06T10:00:00.000Z' });
    await s.store.putConnection({ account: '444444444444', regions: ['eu-west-1'], connectedAt: '2026-10-06T10:00:00.000Z' });
    s.advance(60_000);
    const run = await runDiscovery(s.deps, { source: 'manual' });
    expect(run.connections).toEqual({ connect: [{ account: B.id, regions: ['eu-west-1', 'eu-west-3'] }], disconnect: ['444444444444'] });
    await s.store.putConfig({ ...ON, eventRefresh: { enabled: true, accounts: [A.id] } }, 'admin@example.com');
    s.advance(60_000);
    expect((await runDiscovery(s.deps, { source: 'manual' })).connections?.disconnect).toEqual([B.id, '444444444444']);
    await s.store.putConfig({ ...ON, eventRefresh: { enabled: false } }, 'admin@example.com');
    s.advance(60_000);
    expect((await runDiscovery(s.deps, { source: 'manual' })).connections).toEqual({ connect: [], disconnect: [A.id, B.id, '444444444444'] });
  });
});

describe('the refresh of forwarded events', () => {
  const event = (account: string, region: string, i = 0) => ({ account, region, detail: { eventName: 'CreateRule', requestParameters: { i } } });

  it('300 events of one account-region rescan it once, and only it; the account\'s last run and access are kept', async () => {
    const s = setup({ cfg: ON, regions: ['eu-west-1', 'eu-west-3'] });
    await s.ready;
    await runDiscovery(s.deps, { source: 'manual' });
    const before = await s.store.getAccountScan(A.id);
    s.scanned.length = 0;
    s.advance(60_000);
    const out = await refreshAccounts(s.deps, Array.from({ length: 300 }, (_, i) => event(A.id, 'eu-west-3', i)));
    expect(out).toEqual({ skipped: false, pairs: [`${A.id}/eu-west-3`] });
    expect(s.scanned).toEqual([`${A.id}/eu-west-3`]);
    const after = await s.store.getAccountScan(A.id);
    expect(after!.runId).toBe(before!.runId);
    expect(after!.result).toEqual(before!.result);
    expect(after!.access).toEqual(before!.access);
    expect(after!.regions['eu-west-3']!.scannedAt).not.toBe(before!.regions['eu-west-3']!.scannedAt);
    expect(after!.regions['eu-west-1']).toEqual(before!.regions['eu-west-1']);
  });

  it('a new rule in a forwarded region becomes a candidate, and the counts move with it', async () => {
    const s = setup({ cfg: ON, regions: ['eu-west-1', 'eu-west-3'] });
    await s.ready;
    await runDiscovery(s.deps, { source: 'manual' });
    const counted = (await s.store.getCounts())!.counts;
    const total = Object.values(counted).reduce((n, c) => n + (c ?? 0), 0);
    const scan = s.deps.scan;
    s.deps.scan = async (credentials, where) => [...(await scan(credentials, where)), ...(where.region === 'eu-west-3' ? [{ ...(await scan(credentials, where))[0]!, id: `new-${where.account}`, targetGroupArn: `new-${where.account}` }] : [])];
    s.advance(60_000);
    await refreshAccounts(s.deps, [event(B.id, 'eu-west-3')]);
    expect((await s.store.accountCandidates(B.id)).map((c) => c.id)).toContain(`new-${B.id}`);
    const now = (await s.store.getCounts())!.counts;
    expect(Object.values(now).reduce((n, c) => n + (c ?? 0), 0)).toBe(total + 1);
  });

  it('skipped while a full run holds the lock: the run covers those accounts', async () => {
    const s = setup({ cfg: ON, regions: ['eu-west-1', 'eu-west-3'] });
    await s.ready;
    await runDiscovery(s.deps, { source: 'manual' });
    expect(await s.store.acquireLock('2026-10-06T12:00:00.000Z')).toBe(true);
    s.scanned.length = 0;
    expect(await refreshAccounts(s.deps, [event(A.id, 'eu-west-3')])).toEqual({ skipped: true, pairs: [] });
    expect(s.scanned).toEqual([]);
  });

  it('ignores an event of an account or region outside the perimeter, or malformed', async () => {
    const s = setup({ cfg: ON, regions: ['eu-west-1', 'eu-west-3'] });
    await s.ready;
    await runDiscovery(s.deps, { source: 'manual' });
    s.scanned.length = 0;
    const out = await refreshAccounts(s.deps, [event('999999999999', 'eu-west-3'), event(A.id, 'ap-south-1'), { account: 'x', region: 'y' } as never, {} as never]);
    expect(out).toEqual({ skipped: false, pairs: [] });
    expect(s.scanned).toEqual([]);
  });
});

describe('what the state machine carries', () => {
  it('the run\'s summary counts its connections: 1,000 accounts in 17 regions stay far below Step Functions\' 256 KB (R5c review I3)', () => {
    const regions = Array.from({ length: 17 }, (_, i) => `xx-region-${i}`);
    const connect = Array.from({ length: 1000 }, (_, i) => ({ account: String(100000000000 + i), regions }));
    const run = { startedAt: '2026-10-06T12:00:00.000Z', finishedAt: '2026-10-06T12:10:00.000Z', trigger: 'schedule' as const, status: 'ok' as const, targets: [], counts: {}, lint: [], connections: { connect, disconnect: ['999999999999'] } };
    const summary = runSummary(run);
    expect(summary.connections).toEqual({ connect: 1000, disconnect: 1 });
    expect(JSON.stringify(summary).length).toBeLessThan(2000);
  });
});
