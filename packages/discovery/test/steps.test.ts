// A run in steps (scale design §5): plan, one step per account (the Distributed Map), finalize.
import { describe, expect, it } from 'vitest';
import { lint, lintCounters, sumCounters } from '../src/lint.js';
import { GOOGLE_DISCONNECTED, restatus } from '../src/lifecycle.js';
import { abandonRun, finalizeRun, planRun, runDiscovery, scanAccount } from '../src/run.js';
import { A, B, C, INVENTORY, config, filter, rule } from './fixtures.js';
import { GoogleError } from '@dormeto/google';
import type { WorkloadSummary } from '@dormeto/fleet';
import type { InstalledRouter } from '@dormeto/fleet/registry';
import type { GooglePort } from '../src/google.js';
import { devProject, workloadRow, type ComputeWorld } from './gcp-fakes.js';
import { HOUR, T0, setup } from './run-fakes.js';

const AB = config({ filters: [filter('ab', [{ accountIds: [A.id, B.id] }])] });
const writes = (calls: string[]) => calls.filter((c) => c === 'BatchWriteItemCommand').length;

describe('a run in steps', () => {
  it('plans the accounts to scan without assuming any role, stores the inventory and records the run as running', async () => {
    const s = setup({ cfg: AB });
    await s.ready;
    const plan = await planRun(s.deps, { source: 'manual', by: 'ops@example.com' });
    expect([plan.status, plan.accounts, s.assumed]).toEqual(['planned', [A.id, B.id], []]);
    expect(await s.store.lastRun()).toMatchObject({ startedAt: plan.runId, status: 'running', by: 'ops@example.com', skipped: [{ reason: 'no filter includes this account', accounts: 1, pairs: 2 }] });
    expect((await s.store.getInventory())!.accounts).toHaveLength(3);
    // The lock is held until the run is finalized.
    expect(await s.store.acquireLock('other')).toBe(false);
  });

  it('an account step writes only the candidates that changed: the same scan again writes none', async () => {
    const s = setup({ cfg: AB });
    await s.ready;
    const first = await planRun(s.deps, { source: 'manual' });
    expect(await scanAccount(s.deps, { runId: first.runId, account: A.id })).toEqual({ account: A.id, ok: true, written: 2 });
    await finalizeRun(s.deps, first);
    s.advance(HOUR);
    const second = await planRun(s.deps, { source: 'manual' });
    const before = writes(s.dynamo.calls);
    expect(await scanAccount(s.deps, { runId: second.runId, account: A.id })).toEqual({ account: A.id, ok: true, written: 0 });
    expect(writes(s.dynamo.calls)).toBe(before);
    // Its scan state says when each region was last seen.
    expect((await s.store.getAccountScan(A.id))!.regions['eu-west-1']!.scannedAt).toBe(new Date(Date.parse(first.runId) + HOUR).toISOString());
  });

  it('an account step keeps dismissals, and marks gone only what a pair it scanned no longer has', async () => {
    const s = setup({ cfg: config({ filters: [filter('a', [{ accountIds: [A.id] }])] }) });
    await s.ready;
    const scanned = (over: Record<string, ReturnType<typeof rule>[]>) => { s.deps.scan = async (_c, where) => { if (!over[where.region]) throw new Error('Rate exceeded'); return over[where.region]!; }; };
    const keep = rule({ id: 'keep', region: 'eu-west-1' });
    const drop = rule({ id: 'drop', region: 'eu-west-1' });
    const paris = rule({ id: 'paris', region: 'eu-west-3' });
    scanned({ 'eu-west-1': [keep, drop], 'eu-west-3': [paris] });
    await runDiscovery(s.deps, { source: 'manual' });
    const stored = (await s.store.accountCandidates(A.id)).find((c) => c.id === 'keep')!;
    await s.store.putCandidates([restatus({ ...stored, dismissed: { by: 'ops@example.com', at: 'x' } }, 'x')]);
    // eu-west-1 scanned without "drop"; eu-west-3 fails.
    scanned({ 'eu-west-1': [keep] });
    s.advance(HOUR);
    await runDiscovery(s.deps, { source: 'manual' });
    const status = async (id: string) => (await s.store.accountCandidates(A.id)).find((c) => c.id === id)!.status;
    expect([await status('keep'), await status('drop'), await status('paris')]).toEqual(['dismissed', 'gone', 'pending-onboarding']);
  });

  it('a failed account changes none of its candidates and records why', async () => {
    const s = setup({ cfg: AB });
    await s.ready;
    await runDiscovery(s.deps, { source: 'manual' });
    const before = (await s.store.accountCandidates(B.id)).map((c) => JSON.stringify(c)).sort();
    s.deps.assumeRole = async () => { throw Object.assign(new Error('not authorized to perform: sts:AssumeRole'), { name: 'AccessDenied' }); };
    s.advance(HOUR);
    const plan = await planRun(s.deps, { source: 'manual' });
    expect(await scanAccount(s.deps, { runId: plan.runId, account: B.id })).toEqual({ account: B.id, ok: false, written: 0 });
    expect((await s.store.accountCandidates(B.id)).map((c) => JSON.stringify(c)).sort()).toEqual(before);
    expect((await s.store.getAccountScan(B.id))!.result!.error).toMatch(/^no access: deploy DmtDiscoveryRole/);
  });

  it('scans a region found empty in three successive runs every seventh run only', async () => {
    const s = setup({ cfg: config({ regions: ['eu-west-1'], filters: [filter('a', [{ accountIds: [A.id] }])] }) });
    await s.ready;
    s.deps.scan = async (_c, where) => { s.scanned.push(`${where.account}/${where.region}`); return []; };
    const perRun: number[] = [];
    const runs = [];
    for (let run = 0; run < 10; run += 1) {
      const before = s.scanned.length;
      runs.push(await runDiscovery(s.deps, { source: 'manual' }));
      perRun.push(s.scanned.length - before);
      s.advance(HOUR);
    }
    expect(perRun).toEqual([1, 1, 1, 0, 0, 0, 0, 0, 0, 1]);
    expect(runs[3]!.skipped).toContainEqual({ reason: 'no load balancer in 3 runs: scanned every 7th run', accounts: 1, pairs: 1 });
    expect([runs[3]!.status, runs[9]!.skipped!.some((x) => x.reason.startsWith('no load balancer'))]).toEqual(['ok', false]);
  });

  it('finalize builds the run record from the account results; an account whose step never finished is an error; the lock is released', async () => {
    const s = setup({ cfg: AB });
    await s.ready;
    const plan = await planRun(s.deps, { source: 'manual' });
    await scanAccount(s.deps, { runId: plan.runId, account: A.id });
    const run = await finalizeRun(s.deps, plan);
    expect([run.status, run.counts]).toEqual(['partial', { 'pending-onboarding': 2 }]);
    expect(run.targets.map((t) => `${t.account}/${t.region} ${t.status}${t.error ? `: ${t.error}` : ''}`)).toEqual([
      `${A.id}/eu-west-1 ok`, `${A.id}/eu-west-3 ok`, `${B.id}/* error: the account step did not finish (timed out or failed)`,
    ]);
    expect((await s.store.lastRun())).toMatchObject({ startedAt: plan.runId, status: 'partial' });
    // The counts the Discovery view starts from, moved by the changes until the next run.
    expect((await s.store.getCounts())!.counts).toEqual({ 'pending-onboarding': 2 });
    expect(await s.store.acquireLock('next')).toBe(true);
  });

  it('finalize finds the result of every account even when the index has not caught up with their last writes', async () => {
    const s = setup({ cfg: AB, laggingIndex: true });
    await s.ready;
    const plan = await planRun(s.deps, { source: 'manual' });
    for (const account of plan.accounts) await scanAccount(s.deps, { runId: plan.runId, account });
    const run = await finalizeRun(s.deps, plan);
    expect([run.status, run.targets.filter((t) => t.status === 'error')]).toEqual(['ok', []]);
  });

  it('a run that never finished is abandoned after 3 hours: recorded as failed, and the next scheduled run starts', async () => {
    const s = setup({ cfg: AB });
    await s.ready;
    // Planned, then nothing more (the state machine timed out or was stopped).
    const lost = await planRun(s.deps, { source: 'manual' });
    s.advance(2 * HOUR);
    expect((await planRun(s.deps, { source: 'schedule' })).status).toBe('skipped');
    s.advance(2 * HOUR);
    const next = await planRun(s.deps, { source: 'schedule' });
    expect(next.status).toBe('planned');
    await finalizeRun(s.deps, next);
    expect((await s.store.lastRun({ completed: true }))!.startedAt).toBe(next.runId);
    // The lost run is recorded as failed.
    expect(await s.store.getRun(lost.runId)).toMatchObject({ status: 'failed', error: 'the run did not finish within 3 hours' });
  });

  it('abandoning a run whose finalize failed records it as failed with the error and releases the lock', async () => {
    const s = setup({ cfg: AB });
    await s.ready;
    const plan = await planRun(s.deps, { source: 'manual' });
    const run = await abandonRun(s.deps, plan, 'States.Timeout: finalize timed out');
    expect([run.status, run.error]).toEqual(['failed', 'finalize failed: States.Timeout: finalize timed out']);
    expect(await s.store.getRun(plan.runId)).toMatchObject({ status: 'failed' });
    expect(await s.store.acquireLock('next')).toBe(true);
  });

  it('finalize decides again, once, the candidates of an account that left the perimeter', async () => {
    const s = setup({ cfg: AB });
    await s.ready;
    await runDiscovery(s.deps, { source: 'manual' });
    await s.store.putConfig(config({ filters: [filter('a', [{ accountIds: [A.id] }])] }), 'admin@example.com');
    s.advance(HOUR);
    await runDiscovery(s.deps, { source: 'manual' });
    expect((await s.store.accountCandidates(B.id)).map((c) => [c.status, c.statusReason])).toEqual([
      ['out-of-scope', 'out of scope: no filter includes it'], ['out-of-scope', 'out of scope: no filter includes it'],
    ]);
    expect((await s.store.getAccountScan(B.id))!.retiredAt).toBe(new Date(Date.parse((await s.store.lastRun())!.startedAt)).toISOString());
    s.advance(HOUR);
    const run = await runDiscovery(s.deps, { source: 'manual' });
    expect(run.counts).toEqual({ 'pending-onboarding': 2, 'out-of-scope': 2 });
  });
});

describe('lint from the accounts of a run', () => {
  it('summed counters of each account give the lint of every rule', () => {
    const cfg = config({
      globalExcludes: [{ hosts: ['*.internal'] }],
      filters: [filter('f', [{ accountIds: [A.id] }, { accountIds: [C.id] }, { hosts: ['nothing.example.com'] }])],
    });
    const rules = [rule({ account: A.id }), rule({ id: 'r2', account: C.id, hosts: ['api.internal'] })];
    const perAccount = [A.id, C.id].map((id) => lintCounters(cfg, INVENTORY, rules.filter((r) => r.account === id)));
    expect(lint(cfg, INVENTORY, { counters: sumCounters(perAccount) })).toEqual(lint(cfg, INVENTORY, { rules }));
    expect(lint(cfg, INVENTORY, { rules }).map((f) => [f.code, f.include])).toEqual([['include-only-globally-excluded', 2], ['include-matches-nothing', 3]]);
  });

  describe('Google Cloud projects', () => {
    const connection = { project: 'host-project', projectNumber: '1', pool: 'p', provider: 'aws', scopes: ['projects/dev-project'], serviceAccounts: { discovery: 'd@x', command: 'c@x' }, routers: [], googleAdded: [], connectedAt: '2026-11-09T10:00:00.000Z', connectedBy: 'ops', cli: '0.14.0' };
    // compute: the project's Compute Engine; routers: the registry; rows: the routers' workloads; fail: Compute Engine's refusal.
    const google = (search: () => unknown, { compute, routers = [], rows = [], reads = [], fail }: { compute?: ComputeWorld; routers?: InstalledRouter[]; rows?: WorkloadSummary[]; reads?: string[]; fail?: () => Error | null } = {}): GooglePort => ({
      connection: async () => connection,
      call: (async (method: string, url: string, body?: unknown) => {
        if (url.startsWith('https://compute.googleapis.com/')) {
          const refused = fail?.();
          if (refused) throw refused;
          return compute!.call(method, url, body);
        }
        return url.includes(':getAncestry') ? { ancestor: [] } : url.includes('projects:search') ? search() : { services: [] };
      }) as GooglePort['call'],
      registry: { list: async () => routers, put: async () => {}, delete: async () => {} },
      routerWorkloads: async (account, region) => {
        reads.push(`${account}#${region}`);
        return rows.filter((r) => r.account === account && r.region === region);
      },
    });
    const gcpRouter = (account: string, region: string): InstalledRouter => ({
      name: `dmtr-${region}`, account, region, controller: `https://dmtr-${region}-controller-abc-nw.a.run.app`, onboarder: '', version: '0.40.0', build: '', installedBy: 'cli', cloud: 'gcp', installedAt: '2026-11-09T10:00:00.000Z',
    });
    // dev-project: dormeto-dev's demo, an internal load balancer of europe-west2 besides; dmt-demo-app onboarded on the router of europe-west2.
    const devWithInternal = () => {
      const w = devProject('dev-project');
      w.vm('dmt-demo-internal', 'europe-west2-b', { env: 'dev' });
      w.backendService('dmt-demo-internal-app', [w.group('dmt-demo-internal', 'europe-west2-b', ['dmt-demo-internal'])], { region: 'europe-west2', scheme: 'INTERNAL_MANAGED' });
      w.urlMap('dmt-dev-internal-regional', { defaultService: w.service('dmt-demo-internal-app', 'europe-west2') }, { region: 'europe-west2' });
      w.front('dmt-dev-internal-regional', { region: 'europe-west2', scheme: 'INTERNAL_MANAGED', proxy: 'http' });
      return w;
    };
    const onboarded = [workloadRow('dmt-demo-app', { account: 'dev-project' })];
    const statuses = async (store: ReturnType<typeof setup>['store']) => Object.fromEntries((await store.accountCandidates('dev-project')).map((c) => [c.id, c.status]));
    const both = config({ regions: ['eu-west-1', 'global'], filters: [filter('all', [{ accountIds: [A.id, 'dev-project'] }])] });

    it('plans the AWS accounts and the previous projects again when projects.search fails, and records the error', async () => {
      const s = setup({ cfg: both });
      await s.ready;
      let fail = false;
      s.deps.google = google(() => { if (fail) throw new Error('quota exceeded'); return { projects: [{ projectId: 'dev-project', displayName: 'Dev', labels: { env: 'dev' } }] }; });
      const first = await planRun(s.deps, { source: 'manual' });
      expect(first.accounts).toEqual([A.id, 'dev-project']);
      await finalizeRun(s.deps, first);
      fail = true;
      s.advance(HOUR);
      const plan = await planRun(s.deps, { source: 'manual' });
      expect(plan.accounts).toEqual([A.id, 'dev-project']);
      expect(plan.googleErrors).toEqual([{ project: '*', error: 'quota exceeded' }]);
      expect((await s.store.getInventory())!.accounts.find((a) => a.id === 'dev-project')).toMatchObject({ name: 'Dev', tags: { env: 'dev' } });
      expect((await finalizeRun(s.deps, plan)).google!.errors).toEqual([{ project: '*', error: 'quota exceeded' }]);
    });

    it('records in the inventory whether it read a connection, and keeps the last word when the connection can\'t be read', async () => {
      const s = setup({ cfg: both });
      await s.ready;
      const g = google(() => ({ projects: [{ projectId: 'dev-project' }] }));
      const once = async () => {
        s.advance(HOUR);
        await finalizeRun(s.deps, await planRun(s.deps, { source: 'manual' }));
        return (await s.store.getInventory())!.google;
      };
      s.deps.google = g;
      expect(await once()).toEqual({ connected: true });
      // Its projects unlisted: the connection was read all the same.
      s.deps.google = google(() => { throw new Error('quota exceeded'); });
      expect(await once()).toEqual({ connected: true });
      s.deps.google = { ...g, connection: async () => null };
      expect(await once()).toEqual({ connected: false });
      s.deps.google = { ...g, connection: async () => { throw new Error('dynamo throttled'); } };
      expect(await once()).toEqual({ connected: false });
      // Without a Google Cloud port, the run says nothing of a connection.
      delete s.deps.google;
      expect(await once()).toBeUndefined();
    });

    // A managed project's candidate in the three cases the review names (§6.4): the connection removed, the project out of
    // the scopes, the projects' listing failed.
    describe('a managed project\'s candidate', () => {
      const APP = 'projects/dev-project/global/backendServices/dmt-demo-app';
      const MIG = 'projects/dev-project/global/backendServices/dmt-demo-mig-app';
      async function scanned() {
        const s = setup({ cfg: both });
        await s.ready;
        const g = google(() => ({ projects: [{ projectId: 'dev-project' }] }), { compute: devWithInternal(), routers: [gcpRouter('dev-project', 'europe-west2')], rows: onboarded });
        s.deps.google = g;
        const again = async () => {
          const plan = await planRun(s.deps, { source: 'manual' });
          for (const account of plan.accounts) await scanAccount(s.deps, { runId: plan.runId, account });
          await finalizeRun(s.deps, plan);
          s.advance(HOUR);
          return plan;
        };
        await again();
        expect(await statuses(s.store)).toEqual({ [APP]: 'managed', [MIG]: 'pending-onboarding' });
        return { s, g, again };
      }
      const reasons = async (store: ReturnType<typeof setup>['store']) => Object.fromEntries((await store.accountCandidates('dev-project')).map((c) => [c.id, [c.status, c.statusReason]]));

      it('after a disconnect: out of scope with the connection\'s removal, a managed one too, no offboarding proposed', async () => {
        const { s, g, again } = await scanned();
        s.deps.google = { ...g, connection: async () => null };
        expect((await again()).accounts).toEqual([A.id]);
        expect(await reasons(s.store)).toEqual({ [APP]: ['out-of-scope', GOOGLE_DISCONNECTED], [MIG]: ['out-of-scope', GOOGLE_DISCONNECTED] });
        expect((await s.store.accountCandidates('dev-project')).find((c) => c.id === APP)).toMatchObject({ eligibility: 'managed', workloadId: expect.any(String) });
      });

      it('out of the scopes of a connection still there: a managed one waits for its offboarding', async () => {
        const { s, again } = await scanned();
        s.deps.google = google(() => ({ projects: [] }), { compute: devWithInternal(), routers: [gcpRouter('dev-project', 'europe-west2')], rows: onboarded });
        expect((await again()).accounts).toEqual([A.id]);
        const reason = 'out of scope: project no longer at the connection\'s scopes';
        expect(await reasons(s.store)).toEqual({ [APP]: ['pending-offboarding', reason], [MIG]: ['out-of-scope', reason] });
      });

      it('when the projects can\'t be listed: the project scanned again, its candidates unchanged', async () => {
        const { s, again } = await scanned();
        const before = await reasons(s.store);
        s.deps.google = google(() => { throw new Error('quota exceeded'); }, { compute: devWithInternal(), routers: [gcpRouter('dev-project', 'europe-west2')], rows: onboarded });
        expect((await again()).accounts).toEqual([A.id, 'dev-project']);
        expect(await reasons(s.store)).toEqual(before);
      });
    });

    it('selects a project by its labels as account tags', async () => {
      const s = setup({ cfg: config({ regions: ['eu-west-1', 'global'], filters: [filter('dev', [{ accountTags: { env: ['dev'] } }])] }) });
      await s.ready;
      s.deps.google = google(() => ({ projects: [{ projectId: 'dev-project', labels: { env: 'dev' } }] }));
      const plan = await planRun(s.deps, { source: 'manual' });
      // B carries env=dev too: the AWS accounts follow the same criterion.
      expect(plan.accounts).toEqual([B.id, 'dev-project']);
    });

    it('gives a project no event forwarder: neither connected nor listed as impossible', async () => {
      const s = setup({ cfg: { ...both, eventRefresh: { enabled: true } } });
      await s.ready;
      s.deps.google = google(() => ({ projects: [{ projectId: 'dev-project' }] }));
      const plan = await planRun(s.deps, { source: 'manual' });
      for (const account of plan.accounts) await scanAccount(s.deps, { runId: plan.runId, account });
      const record = await finalizeRun(s.deps, plan);
      const forwarders = (await s.store.getAccess())!.forwarders!;
      expect(forwarders.impossible.map((x) => x.account)).toEqual([A.id]);
      expect(record.connections!.connect.map((x) => x.account)).not.toContain('dev-project');
    });

    it('a project\'s account step scans it as the discovery account, without any AWS role, and writes its candidates and its scan', async () => {
      const s = setup({ cfg: config({ regions: ['*'], filters: [filter('all', [{ accountIds: [A.id, 'dev-project'] }])] }) });
      await s.ready;
      const reads: string[] = [];
      // Its router's rows only: not an AWS router's, nor another project's.
      const routers = [gcpRouter('dev-project', 'europe-west2'), gcpRouter('other-project', 'europe-west1'), { ...gcpRouter(A.id, 'eu-west-1'), cloud: undefined }];
      s.deps.google = google(() => ({ projects: [{ projectId: 'dev-project' }] }), { compute: devWithInternal(), routers, rows: onboarded, reads });
      const plan = await planRun(s.deps, { source: 'manual' });
      expect(await scanAccount(s.deps, { runId: plan.runId, account: 'dev-project' })).toEqual({ account: 'dev-project', ok: true, written: 3 });
      expect([s.assumed, reads]).toEqual([[], ['dev-project#europe-west2']]);
      expect(await statuses(s.store)).toEqual({
        'projects/dev-project/global/backendServices/dmt-demo-app': 'managed',
        'projects/dev-project/global/backendServices/dmt-demo-mig-app': 'pending-onboarding',
        'projects/dev-project/regions/europe-west2/backendServices/dmt-demo-internal-app': 'pending-onboarding',
      });
      const scan = (await s.store.getAccountScan('dev-project'))!;
      // Keyed by the regions the scan saw: the VMs of europe-west1, the internal load balancer of europe-west2, the global one.
      expect(Object.keys(scan.regions).sort()).toEqual(['europe-west1', 'europe-west2', 'global']);
      expect(scan.result).toEqual({
        pairs: [{ region: 'europe-west1', ok: true, rules: 0, ms: 0 }, { region: 'europe-west2', ok: true, rules: 1, ms: 0 }, { region: 'global', ok: true, rules: 2, ms: 0 }],
        skipped: [], lint: expect.any(Object), written: 3,
      });
      expect(scan.runId).toBe(plan.runId);
    });

    it('a project\'s account step keeps to an explicit perimeter: its Google Cloud regions and global', async () => {
      const s = setup({ cfg: both });
      await s.ready;
      s.deps.google = google(() => ({ projects: [{ projectId: 'dev-project' }] }), { compute: devWithInternal(), routers: [gcpRouter('dev-project', 'europe-west2')], rows: onboarded });
      const plan = await planRun(s.deps, { source: 'manual' });
      expect(await scanAccount(s.deps, { runId: plan.runId, account: 'dev-project' })).toEqual({ account: 'dev-project', ok: true, written: 2 });
      expect(Object.keys(await statuses(s.store)).sort()).toEqual(['projects/dev-project/global/backendServices/dmt-demo-app', 'projects/dev-project/global/backendServices/dmt-demo-mig-app']);
      expect((await s.store.getAccountScan('dev-project'))!.result!.pairs.map((p) => p.region)).toEqual(['global']);
    });

    it('a project whose scan fails changes none of its candidates and records why, each of their regions failed', async () => {
      const s = setup({ cfg: config({ regions: ['*'], filters: [filter('all', [{ accountIds: ['dev-project'] }])] }) });
      await s.ready;
      let refused: Error | null = null;
      s.deps.google = google(() => ({ projects: [{ projectId: 'dev-project' }] }), { compute: devWithInternal(), routers: [gcpRouter('dev-project', 'europe-west2')], rows: onboarded, fail: () => refused });
      const plan = await planRun(s.deps, { source: 'manual' });
      await scanAccount(s.deps, { runId: plan.runId, account: 'dev-project' });
      const before = (await s.store.accountCandidates('dev-project')).map((c) => JSON.stringify(c)).sort();
      refused = new GoogleError({ status: 403, reason: 'IAM_PERMISSION_DENIED', message: "Required 'compute.urlMaps.list' permission for 'projects/dev-project'", host: 'compute.googleapis.com' });
      s.advance(HOUR);
      expect(await scanAccount(s.deps, { runId: plan.runId, account: 'dev-project' })).toEqual({ account: 'dev-project', ok: false, written: 0 });
      expect((await s.store.accountCandidates('dev-project')).map((c) => JSON.stringify(c)).sort()).toEqual(before);
      const error = "GoogleError: Required 'compute.urlMaps.list' permission for 'projects/dev-project'";
      expect((await s.store.getAccountScan('dev-project'))!.result).toMatchObject({
        error, pairs: [{ region: 'europe-west2', ok: false, error }, { region: 'global', ok: false, error }],
      });
    });

    describe('access', () => {
      const CONNECT = 'dormeto gcp connect --project host-project --profile <profile> --env dev';
      const both = config({ regions: ['*'], filters: [filter('all', [{ accountIds: [A.id, 'dev-project'] }])] });
      // The project's step, then its access as the panel reads it.
      async function stepOf(s: ReturnType<typeof setup>, g: GooglePort) {
        s.deps.google = { ...g, env: 'dev' };
        const plan = await planRun(s.deps, { source: 'manual' });
        await scanAccount(s.deps, { runId: plan.runId, account: 'dev-project' });
        return plan;
      }
      const refusal = new GoogleError({ status: 403, reason: 'IAM_PERMISSION_DENIED', message: "Required 'compute.urlMaps.list' permission for 'projects/dev-project'", host: 'compute.googleapis.com' });

      it('a project with a router the command account cannot act on is missing its command, counted and listed with its words', async () => {
        const s = setup({ cfg: both });
        await s.ready;
        const asked: unknown[] = [];
        const reason = `the command account c@x is missing run.routes.invoke on projects/dev-project/locations/europe-west2/services/dmtr-europe-west2-controller: ${CONNECT}`;
        s.deps.assumeCommand = async (account, extra) => {
          asked.push([account, extra]);
          if (account === 'dev-project') throw Object.assign(new Error(reason), { name: 'AccessDenied' });
        };
        const plan = await stepOf(s, google(() => ({ projects: [{ projectId: 'dev-project' }] }), { compute: devWithInternal(), routers: [gcpRouter('dev-project', 'europe-west2')] }));
        expect(asked).toEqual([['dev-project', { controllers: ['projects/dev-project/locations/europe-west2/services/dmtr-europe-west2-controller'] }]]);
        expect((await s.store.getAccountScan('dev-project'))!.access).toEqual({ discovery: { ok: true }, command: { ok: false, reason }, checkedAt: new Date(T0).toISOString() });
        await scanAccount(s.deps, { runId: plan.runId, account: A.id });
        await finalizeRun(s.deps, plan);
        const report = await s.store.accessReport({ limit: 10 });
        expect(report.counts).toEqual({ ready: 1, discoveryMissing: 0, commandMissing: 1, unchecked: 0 });
        expect(report.accounts.map((a) => [a.account, a.discovery.ok, a.command])).toEqual([['dev-project', true, { ok: false, reason }]]);
      });

      it('a router installed since the last run is registered by the plan step and its controller checked by the same run\'s project step', async () => {
        const s = setup({ cfg: both });
        await s.ready;
        const registry: InstalledRouter[] = [];
        const g = google(() => ({ projects: [{ projectId: 'dev-project' }] }), { compute: devWithInternal() });
        const installed = { name: 'projects/dev-project/locations/europe-west2/services/dmtr-europe-west2-controller', uri: 'https://dmtr-europe-west2-controller-abc-nw.a.run.app', template: { containers: [{ env: [{ name: 'DMT_VERSION', value: '0.40.0' }] }] } };
        const call = g.call;
        g.call = (async (method: string, url: string, body?: unknown) => (url.startsWith('https://run.googleapis.com/') ? { services: [installed] } : call(method, url, body))) as GooglePort['call'];
        g.registry = { list: async () => registry, put: async (r) => { registry.push(r); }, delete: async () => {} };
        const asked: unknown[] = [];
        const reason = `the command account c@x is missing run.routes.invoke on ${installed.name}: ${CONNECT}`;
        s.deps.assumeCommand = async (account, extra) => {
          asked.push([account, extra]);
          if (account === 'dev-project') throw Object.assign(new Error(reason), { name: 'AccessDenied' });
        };
        const plan = await stepOf(s, g);
        expect(registry.map((r) => [r.account, r.region])).toEqual([['dev-project', 'europe-west2']]);
        expect(asked).toEqual([['dev-project', { controllers: [installed.name] }]]);
        expect((await s.store.getAccountScan('dev-project'))!.access).toMatchObject({ command: { ok: false, reason } });
        await scanAccount(s.deps, { runId: plan.runId, account: A.id });
        const record = await finalizeRun(s.deps, plan);
        expect(record.google).toMatchObject({ routers: 1, added: 1 });
        expect(registry).toHaveLength(1);
      });

      it('a project without a router is ready, its command not even asked', async () => {
        const s = setup({ cfg: both });
        await s.ready;
        const asked: string[] = [];
        s.deps.assumeCommand = async (account) => { asked.push(account); };
        const plan = await stepOf(s, google(() => ({ projects: [{ projectId: 'dev-project' }] }), { compute: devWithInternal() }));
        await scanAccount(s.deps, { runId: plan.runId, account: A.id });
        await finalizeRun(s.deps, plan);
        expect(asked).toEqual([A.id]);
        expect((await s.store.getAccountScan('dev-project'))!.access).toEqual({ discovery: { ok: true }, command: { ok: true }, checkedAt: new Date(T0).toISOString() });
        expect((await s.store.accessReport({ limit: 10 })).counts).toEqual({ ready: 2, discoveryMissing: 0, commandMissing: 0, unchecked: 0 });
      });

      it('a project whose lists Google refuses is missing its discovery with the connect command; Compute Engine turned off is nothing to find', async () => {
        const s = setup({ cfg: both });
        await s.ready;
        let fail: Error | null = refusal;
        const plan = await stepOf(s, google(() => ({ projects: [{ projectId: 'dev-project' }] }), { compute: devWithInternal(), fail: () => fail }));
        expect((await s.store.getAccountScan('dev-project'))!.access).toMatchObject({ discovery: { ok: false, reason: `GoogleError: Required 'compute.urlMaps.list' permission for 'projects/dev-project': ${CONNECT}` }, command: { ok: true } });
        fail = new GoogleError({ status: 403, reason: 'SERVICE_DISABLED', message: 'Compute Engine API has not been used', host: 'compute.googleapis.com' });
        s.advance(HOUR);
        await scanAccount(s.deps, { runId: plan.runId, account: 'dev-project' });
        expect((await s.store.getAccountScan('dev-project'))!.access).toMatchObject({ discovery: { ok: true } });
      });

      it('a read that fails without a refusal, and a check that does not answer, keep the last verdicts', async () => {
        const s = setup({ cfg: both });
        await s.ready;
        let down = false;
        s.deps.assumeCommand = async () => { if (down) throw Object.assign(new Error('timed out'), { unavailable: true }); };
        const plan = await stepOf(s, google(() => ({ projects: [{ projectId: 'dev-project' }] }), { compute: devWithInternal(), routers: [gcpRouter('dev-project', 'europe-west2')], fail: () => (down ? new GoogleError({ status: 503, reason: 'UNAVAILABLE', message: 'try later' }) : null) }));
        const first = (await s.store.getAccountScan('dev-project'))!.access;
        expect(first).toMatchObject({ discovery: { ok: true }, command: { ok: true } });
        down = true;
        s.advance(HOUR);
        await scanAccount(s.deps, { runId: plan.runId, account: 'dev-project' });
        expect((await s.store.getAccountScan('dev-project'))!.access).toEqual({ ...first, checkedAt: new Date(T0 + HOUR).toISOString() });
      });
      it('a SERVICE_DISABLED of another host (the token\'s IAM Credentials API) is no Compute Engine turned off: candidates stay, discovery is missing', async () => {
        const s = setup({ cfg: both });
        await s.ready;
        let fail: Error | null = null;
        const plan = await stepOf(s, google(() => ({ projects: [{ projectId: 'dev-project' }] }), { compute: devWithInternal(), fail: () => fail }));
        const before = (await s.store.accountCandidates('dev-project')).map((c) => JSON.stringify(c)).sort();
        expect(before.length).toBeGreaterThan(0);
        fail = new GoogleError({ status: 403, reason: 'SERVICE_DISABLED', message: 'IAM Service Account Credentials API has not been used', host: 'iamcredentials.googleapis.com' });
        s.advance(HOUR);
        expect(await scanAccount(s.deps, { runId: plan.runId, account: 'dev-project' })).toMatchObject({ ok: false, written: 0 });
        expect((await s.store.accountCandidates('dev-project')).map((c) => JSON.stringify(c)).sort()).toEqual(before);
        expect((await s.store.getAccountScan('dev-project'))!.access).toMatchObject({ discovery: { ok: false, reason: expect.stringContaining(CONNECT) } });
      });

      // A revoked federation (the review's M4): the discovery account's token refused at STS or iamcredentials is a missing
      // access, as the router calls and the access check read it, never a failure that keeps the last verdict.
      it.each([
        ['STS\'s invalid_grant', new GoogleError({ status: 400, reason: 'invalid_grant', message: 'The audience in ID Token does not match the expected audience.', host: 'sts.googleapis.com' })],
        ['iamcredentials\' 404', new GoogleError({ status: 404, reason: 'NOT_FOUND', message: 'Not found; Gaia id not found for email d@x', host: 'iamcredentials.googleapis.com' })],
      ])('a project whose discovery token is refused (%s) is missing its discovery with the connect command, its candidates kept', async (_, refused) => {
        const s = setup({ cfg: both });
        await s.ready;
        let fail: Error | null = null;
        const plan = await stepOf(s, google(() => ({ projects: [{ projectId: 'dev-project' }] }), { compute: devWithInternal(), fail: () => fail }));
        const before = (await s.store.accountCandidates('dev-project')).map((c) => JSON.stringify(c)).sort();
        fail = refused;
        s.advance(HOUR);
        expect(await scanAccount(s.deps, { runId: plan.runId, account: 'dev-project' })).toMatchObject({ ok: false, written: 0 });
        expect((await s.store.accountCandidates('dev-project')).map((c) => JSON.stringify(c)).sort()).toEqual(before);
        expect((await s.store.getAccountScan('dev-project'))!.access).toMatchObject({ discovery: { ok: false, reason: `GoogleError: ${refused.message}: ${CONNECT}` } });
      });

      it('a registry read that fails is no verdict: the last command verdict stands', async () => {
        const s = setup({ cfg: both });
        await s.ready;
        const reason = `the command account c@x is missing run.routes.invoke on x: ${CONNECT}`;
        s.deps.assumeCommand = async () => { throw Object.assign(new Error(reason), { name: 'AccessDenied' }); };
        const g = google(() => ({ projects: [{ projectId: 'dev-project' }] }), { compute: devWithInternal(), routers: [gcpRouter('dev-project', 'europe-west2')] });
        const plan = await stepOf(s, g);
        expect((await s.store.getAccountScan('dev-project'))!.access).toMatchObject({ command: { ok: false, reason } });
        s.deps.google = { ...g, env: 'dev', registry: { ...g.registry, list: async () => { throw new Error('dynamo throttled'); } } };
        s.advance(HOUR);
        await scanAccount(s.deps, { runId: plan.runId, account: 'dev-project' });
        expect((await s.store.getAccountScan('dev-project'))!.access).toMatchObject({ command: { ok: false, reason } });
      });
    });
  });
});
