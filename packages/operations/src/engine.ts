// Operations engine (vision docs/specs/2026-10-05-onboarding-design.md, R4b): an operation is a list of steps run one at a
// time by the Step Functions workflow (`next` until done, waiting as asked), each step idempotent; `fail` releases what the
// operation holds. Steps act in the target account and region through `target` (DmtCommandRole).
import { exclusionCriterion, matches, restatus, type Candidate, type DiscoveryStore, type Exclusion } from '@dormeto/discovery';
import { fill, type Blueprint } from './blueprint.js';
import { INSTALL_STEPS, RetryLater, UNINSTALL_STEPS, type InstallStep, type StepResult, type UninstallStep, type createInstaller } from './installer.js';
import type { Operation, OperationType, Records } from './records.js';
import { ClusterAccessDenied, ensureClusterAccess, removeClusterAccess, type EksPort } from './cluster-access.js';

const MINUTE = 60_000;
// An operation lasts at most its slot waits (SLOT_WAIT_MAX) and the steps after them: the workflow's timeout is 25 hours
// (an execution timeout is never caught: the operation would stay running).
const ACTIVE_TTL = 25 * 60 * MINUTE;
const LOCK_LEASE = 60 * MINUTE;
const BUSY_MAX = 30 * MINUTE;
// A step pending longer than this (a resource never settling) fails instead of looping until the workflow timeout.
const PENDING_MAX = 30 * MINUTE;
const SLOTS = 3;
// At most this many operations work at once across the organization (scale design §6); one waiting for the slot of its
// account and region gives its place back meanwhile.
const ORG_SLOT = 'ORG';
const ORG_SLOTS = 50;
const slotMax = (key: string) => (key === ORG_SLOT ? ORG_SLOTS : SLOTS);
// Waiting for a slot lasts as long as it takes (the holders of dead operations expire), polling less often: 10 s to 60 s,
// up to 24 hours after the operation started (about 13,000 workflow events of the 25,000 an execution can hold).
const slotWait = (attempts: number) => Math.min(60, 10 * 2 ** Math.max(0, attempts - 1));
const SLOT_WAIT_MAX = 24 * 60 * MINUTE;
const RETRY_MAX = 30;
// AWS errors that pass: the step waits and runs again (a resource being updated, a throttled API).
const TRANSIENT = new Set([
  'ContinuousBackupsUnavailableException', 'ResourceInUseException', 'LimitExceededException', 'TooManyRequestsException', 'ThrottlingException', 'Throttling',
  'ResourceConflictException', 'ConcurrentModificationException', 'ServiceUnavailableException', 'InternalFailure',
]);
const WAKE_GRACE = 2 * MINUTE;

export interface RouterRef {
  name: string;
  account: string;
  region: string;
  controller: string; // function ARNs
  onboarder?: string;
  source: 'terraform' | 'manager';
  version?: string;
  build?: string;
  uninstalling?: boolean;
}

export interface TargetAccess {
  // The EKS clusters of the account and region (Kubernetes workloads, R10.5): their access entries.
  eks: EksPort;
  installer(options: Parameters<typeof createInstaller>[1]): ReturnType<typeof createInstaller>;
  invoke(functionArn: string, payload: Record<string, unknown>): Promise<any>;
}

export interface EngineDeps {
  records: Records;
  discovery?: Pick<DiscoveryStore, 'getCandidate' | 'replaceCandidates' | 'accountCandidates' | 'getInventory' | 'getExclusion' | 'updateExclusion' | 'deleteExclusion'
    | 'getConnection' | 'putConnection' | 'deleteConnection' | 'getAccountScan'>;
  routers(): Promise<RouterRef[]>;
  target(account: string, region: string): Promise<TargetAccess>;
  bundle(): Promise<{ blueprint: Blueprint; zip: Uint8Array; codeSha256: string }>;
  // managerBus: the manager's event bus, where the routers send their state (scale design §3).
  // commandRole: the command role's name without its path; the forwarder ignores the manager's own calls (routers 0.23.0).
  // ipListsCatalog and ipListsBucket: the manager's IP lists (R6b), read by its routers (router 0.24.0).
  // discoveryRole: the discovery role's name (DmtDiscoveryRole by default), given the view policy in the clusters.
  settings: { env: string; principals: string[]; discoveryRole?: string; routerSettings: { checkSchedule: string; ipLists: string; ipListsCatalog: string; ipListsBucket: string; noWakeRules: string; metrics: string; managerBus: string; commandRole: string } };
  start(op: Operation): Promise<string>; // starts the workflow execution, returns its ARN
  now?: () => number;
  newId?: () => string;
  log: { info(event: string, data?: object): void; warn(event: string, data?: object): void; error(event: string, data?: object): void };
}

// Another operation runs on the same target.
export class Conflict extends Error {
  override name = 'Conflict';
  constructor(readonly operationId: string) {
    super(`another operation is running on this target: ${operationId}`);
  }
}

// A lock or slot is held by another operation: the step waits.
class Busy extends Error {}
class SlotBusy extends Busy {}

type Outcome = StepResult | { status: 'wait'; seconds: number; detail?: string };

const installSteps = INSTALL_STEPS.map((s) => `install ${s}`);
const uninstallSteps = UNINSTALL_STEPS.map((s) => `uninstall ${s}`);
// The router's access to the EKS clusters of its account and region, and its check of each (Kubernetes workloads, R10.5).
const clusterSteps = ['access entries', 'check clusters'];
// EKS honours a new access entry within seconds: until then the cluster does not know the router's role.
const ENTRY_PROPAGATION_MS = 120_000;
const PLANS: Record<OperationType, string[]> = {
  'install-router': ['find router', 'lock router', ...installSteps, 'register router', ...clusterSteps, 'verify router'],
  'upgrade-router': ['find router', 'lock router', ...installSteps, 'register router', ...clusterSteps, 'verify router'],
  'uninstall-router': ['find router', 'lock router', 'mark uninstalling', 'check empty', 'remove access entries', ...uninstallSteps, 'unregister router'],
  // The slot before the load balancer's lock: an operation waiting for a slot holds no lock others wait for.
  onboard: ['find router', 'lock router', ...installSteps, 'register router', ...clusterSteps, 'slot', 'lock load balancer', 'preview', 'onboard', 'verify', 'candidate'],
  // Paused first (that wakes an asleep workload): no nap starts or commits while the instrumentation goes.
  offboard: ['locate', 'slot', 'lock load balancer', 'pause', 'wait awake', 'offboard', 'candidate'],
  // Exclusions (scale design §6): the API answers at once; their workloads are paused or resumed here, in batches.
  exclude: ['pause workloads'],
  'lift-exclusion': ['resume workloads'],
  // Event-driven discovery refresh (packaging design §5): one per account at a time; the rules before the role on removal.
  'connect-account': ['forwarder role', 'forwarder rules', 'connected'],
  'disconnect-account': ['remove forwarder rules', 'remove forwarder role', 'disconnected'],
  // Again, after the customer applied the manifest or switched a cluster to access entries.
  'cluster-access': ['find router', ...clusterSteps],
};
const ACCOUNT_ID = /^\d{12}$/;
const REGION_NAME = /^[a-z]{2}(-[a-z]+)+-\d$/;
// Router calls per step of an exclusion: the step runs again until every workload is done.
const EXCLUSION_BATCH = 25;
const EXCLUDED = 'excluded: ';
type Pause = NonNullable<Exclusion['paused']>[number];
const pauseKey = (p: Pause) => `${p.router} ${p.account ?? ''} ${p.region ?? ''} ${p.workloadId}`;
// The pauses recorded, and those added once each.
const withPauses = (recorded: Pause[] = [], added: Pause[]) => {
  const seen = new Set(recorded.map(pauseKey));
  return [...recorded, ...added.filter((p) => !seen.has(pauseKey(p)) && Boolean(seen.add(pauseKey(p))))];
};

const iso = (ms: number) => new Date(ms).toISOString();
const loadBalancerOfRule = (ruleArn: string) => ruleArn.replace(':listener-rule/app/', ':loadbalancer/app/').split('/').slice(0, 4).join('/');

export function createEngine(deps: EngineDeps) {
  const { records } = deps;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  // Installed routers are named dmtr-<env>: DmtCommandRole and DmtRouterBoundary are scoped to that namespace.
  const routerName = `dmtr-${deps.settings.env}`;

  const notConfigured = (err: unknown) => /^workload not configured/.test((err as Error).message ?? '');
  const callRouter = async (router: RouterRef, payload: Record<string, unknown>) => (await deps.target(router.account, router.region)).invoke(router.controller, payload);

  // The managed workloads an exclusion matches: the candidates of its account (and the workload it was created from, in
  // the routers of its target group's account and region), each with the routers of its account and region.
  async function excludedWorkloads(e: Exclusion, hint?: { workloadId: string }) {
    const d = deps.discovery!;
    const inventory = (await d.getInventory()) ?? { accounts: [], ous: {} };
    const criterion = exclusionCriterion(e);
    const all = await deps.routers();
    const routersOf = (account: string, region: string | undefined) => all.filter((r) => r.region === region && r.account === account);
    const wanted = new Map<string, { workloadId: string; targetGroupArn?: string; routers: RouterRef[] }>();
    for (const c of await d.accountCandidates(e.target.account)) {
      const account = inventory.accounts.find((a) => a.id === c.account) ?? { id: c.account, name: c.accountName, ouPath: c.ouPath, tags: {} };
      if (!c.workloadId || c.goneAt || !matches(criterion, account, c, inventory)) continue;
      wanted.set(`${c.workloadId} ${c.targetGroupArn}`, {
        workloadId: c.workloadId, ...(c.targetGroupArn ? { targetGroupArn: c.targetGroupArn } : {}), routers: routersOf(c.account, c.region),
      });
    }
    const hinted = hint && `${hint.workloadId} ${e.target.arn}`;
    if (hint && hinted && !wanted.has(hinted)) {
      wanted.set(hinted, { workloadId: hint.workloadId, ...(e.target.arn ? { targetGroupArn: e.target.arn } : {}), routers: routersOf(e.target.account, e.target.region) });
    }
    return [...wanted.entries()].map(([key, w]) => ({ key, ...w }));
  }

  // Pause the workloads of an exclusion, a batch per run of the step. Each pause is recorded with the exclusion before its
  // router is called (a lift resumes whatever is recorded; resuming a pause never made changes nothing), and the records
  // of the pauses not made are removed after the calls: a batch run again records each pause once.
  async function pauseExcluded(op: Operation): Promise<Outcome> {
    const d = deps.discovery!;
    const e = await d.getExclusion(String(op.target.exclusionId));
    if (!e || e.liftedAt) return { status: 'done', detail: 'lifted since' };
    const wanted = await excludedWorkloads(e, op.input.hint as { workloadId: string } | undefined);
    const handled = new Set((op.context.handled as string[] | undefined) ?? []);
    const unpaused = [...((op.context.unpaused as string[] | undefined) ?? [])];
    const batch = wanted.filter((w) => !handled.has(w.key)).slice(0, EXCLUSION_BATCH);
    const pauseOf = (router: RouterRef, workloadId: string): Pause => ({ router: router.name, account: router.account, region: router.region, workloadId });
    const tried = batch.flatMap((w) => w.routers.map((router) => pauseOf(router, w.workloadId)));
    if (tried.length) await d.updateExclusion(e.id, (x) => ({ ...x, paused: withPauses(x.paused, tried) }));
    const made = new Set<string>();
    for (const w of batch) {
      let outcome: string | null = `${w.workloadId}: no registered router manages it`;
      for (const router of w.routers) {
        try {
          await callRouter(router, {
            action: 'pause', workloadId: w.workloadId, ...(w.targetGroupArn ? { targetGroupArn: w.targetGroupArn } : {}), by: op.by, reason: `${EXCLUDED}${e.reason}`,
            ...(e.expiresAt ? { until: e.expiresAt } : {}), exclusionId: e.id,
          });
          made.add(pauseKey(pauseOf(router, w.workloadId)));
          outcome = null;
          break;
        } catch (err) {
          if (notConfigured(err)) continue;
          outcome = `${w.workloadId} (${router.name}): ${(err as Error).message}`;
          break;
        }
      }
      if (outcome) unpaused.push(outcome);
    }
    const notMade = new Set(tried.map(pauseKey).filter((k) => !made.has(k)));
    let after: Exclusion | null = e;
    if (notMade.size) after = await d.updateExclusion(e.id, (x) => ({ ...x, paused: (x.paused ?? []).filter((p) => !notMade.has(pauseKey(p))) }));
    else if (tried.length) after = await d.getExclusion(e.id);
    for (const w of batch) handled.add(w.key);
    op.context.handled = [...handled];
    op.context.unpaused = unpaused;
    if (wanted.some((w) => !handled.has(w.key))) return { status: 'wait', seconds: 0, detail: `${handled.size} of ${wanted.length}` };
    return { status: 'done', detail: [`paused ${after?.paused?.length ?? 0}`, ...unpaused.map((u) => `not paused ${u}`)].join('; ') };
  }

  // Resume what an exclusion paused, a batch per run; what cannot be resumed stays with the exclusion (lifting), for a
  // later lift; the exclusion goes once everything is resumed. A workload its router no longer knows (offboarded since)
  // has nothing left to resume.
  async function resumeExcluded(op: Operation): Promise<Outcome> {
    const d = deps.discovery!;
    const id = String(op.target.exclusionId);
    let e = await d.getExclusion(id);
    if (!e) return { status: 'done', detail: 'nothing to resume' };
    // Marked lifted here too: the API marks it once this operation is started, and may not get to.
    if (!e.liftedAt) e = (await d.updateExclusion(id, (x) => ({ ...x, liftedAt: x.liftedAt ?? op.createdAt }))) ?? e;
    const handled = new Set((op.context.handled as string[] | undefined) ?? []);
    const errors = [...((op.context.errors as string[] | undefined) ?? [])];
    const batch = (e.paused ?? []).filter((p) => !handled.has(pauseKey(p))).slice(0, EXCLUSION_BATCH);
    const all = await deps.routers();
    const resumed = new Set<string>();
    for (const p of batch) {
      const router = all.find((r) => r.name === p.router && (!p.account || r.account === p.account) && (!p.region || r.region === p.region));
      try {
        if (!router) throw new Error(`router ${p.router} is no longer registered`);
        await callRouter(router, { action: 'resume', workloadId: p.workloadId, by: op.by, exclusionId: id });
        resumed.add(pauseKey(p));
      } catch (err) {
        if (notConfigured(err)) resumed.add(pauseKey(p));
        else errors.push(`${p.router}/${p.workloadId}: ${(err as Error).message}`);
      }
    }
    for (const p of batch) handled.add(pauseKey(p));
    const after = resumed.size ? await d.updateExclusion(id, (x) => ({ ...x, paused: (x.paused ?? []).filter((p) => !resumed.has(pauseKey(p))) })) : e;
    op.context.handled = [...handled];
    op.context.errors = errors;
    const left = (after?.paused ?? []).filter((p) => !handled.has(pauseKey(p)));
    if (left.length) return { status: 'wait', seconds: 0, detail: `${left.length} to resume` };
    if (after?.paused?.length) return { status: 'done', detail: `not resumed: ${errors.join('; ')} (lift again to retry)` };
    await d.deleteExclusion(id);
    return { status: 'done', detail: 'every workload resumed' };
  }

  // The onboarder derives the workload id from the target group (routers 0.20.0 and later); the name is for people. Both
  // are kept in the operation for the next steps.
  // The candidate's Kubernetes workload (its cluster, owner and switch), null for any other backend; kept in the operation.
  async function kubernetesOf(op: Operation): Promise<{ cluster: string; namespace: string } | null> {
    if (op.type !== 'onboard') return null;
    if (op.context.kubernetes === undefined) {
      const backend = (await deps.discovery?.getCandidate(String(op.input.candidateId)))?.backend as { kind?: string; kubernetes?: unknown } | null | undefined;
      op.context.kubernetes = backend?.kind === 'k8s' ? backend.kubernetes ?? null : null;
    }
    return op.context.kubernetes as { cluster: string; namespace: string } | null;
  }

  async function previewOf(op: Operation) {
    const kubernetes = await kubernetesOf(op);
    const preview = await invokeRouter(op, 'onboarder', {
      action: 'preview', targetGroupArn: op.target.targetGroupArn, ...(op.input.name ? { name: op.input.name } : {}), settings: op.input.settings ?? {}, databases: op.input.databases ?? [],
      ...(kubernetes ? { kubernetes } : {}),
    });
    if (!preview?.workloadId) throw new Error(`router ${(await routerOf(op))?.name ?? ''} is older than 0.20.0: upgrade it to onboard`);
    op.context.workloadId = preview.workloadId;
    op.context.name = preview.name;
    return preview as { ok: boolean; problems?: string[]; workloadId: string; name: string };
  }

  // The target of an operation, and the key no second operation may claim at the same time.
  async function targetOf(type: OperationType, input: Record<string, unknown>): Promise<{ target: Record<string, string>; activeKey: string }> {
    if (type === 'exclude' || type === 'lift-exclusion') {
      const e = await deps.discovery?.getExclusion(String(input.exclusionId));
      if (!e) throw new Error(`unknown exclusion: ${input.exclusionId}`);
      return { target: { exclusionId: e.id, account: e.target.account }, activeKey: `EXCL#${e.id}` };
    }
    if (type === 'onboard') {
      const c = await deps.discovery?.getCandidate(String(input.candidateId));
      if (!c || !c.targetGroupArn) throw new Error(`unknown candidate: ${input.candidateId}`);
      return { target: { account: c.account, region: c.region, targetGroupArn: c.targetGroupArn, loadBalancerArn: c.loadBalancerArn }, activeKey: `TG#${c.targetGroupArn}` };
    }
    if (type === 'connect-account' || type === 'disconnect-account') {
      const account = String(input.account);
      if (!ACCOUNT_ID.test(account)) throw new Error(`bad account: ${input.account}`);
      const regions = input.regions;
      if (!Array.isArray(regions) || !regions.every((r) => typeof r === 'string' && REGION_NAME.test(r))) throw new Error(`bad regions: ${JSON.stringify(regions)}`);
      return { target: { account }, activeKey: `ACCT#${account}` };
    }
    const account = String(input.account);
    const region = String(input.region);
    if (type === 'offboard') return { target: { account, region, router: String(input.router), workloadId: String(input.workloadId) }, activeKey: `WL#${account}#${region}#${input.workloadId}` };
    return { target: { account, region }, activeKey: `ROUTER#${account}#${region}` };
  }

  async function create(type: OperationType, input: Record<string, unknown>, by: string): Promise<Operation> {
    const { target, activeKey } = await targetOf(type, input);
    const id = newId();
    const claim = await records.claimActive(activeKey, id, ACTIVE_TTL);
    if (!claim.ok) throw new Conflict(claim.operationId);
    const at = iso(now());
    const op: Operation = {
      id, type, target, input, status: 'running', steps: PLANS[type].map((name) => ({ name, status: 'pending' })), cursor: 0,
      holds: { locks: [], slots: [] }, activeKey, context: {}, by, createdAt: at, updatedAt: at,
    };
    await records.putOperation(op);
    try {
      op.executionArn = await deps.start(op);
    } catch (err) {
      await finish(op, 'failed', `workflow not started: ${(err as Error).message}`);
      throw err;
    }
    // Started: the workflow runs it whatever happens now, so create never throws past this point (a caller undoing what it
    // did would leave the workflow acting alone); only its execution's name would be missing from the record.
    await records.putOperation(op).catch((err) => deps.log.warn('OperationNotUpdated', { id, error: (err as Error).message }));
    deps.log.info('OperationCreated', { id, type, target, by });
    return op;
  }

  // --- Steps -----------------------------------------------------------------------------------------------------------

  const routerOf = async (op: Operation) => (await deps.routers()).find((r) => r.account === op.target.account && r.region === op.target.region) ?? null;
  const access = (op: Operation) => deps.target(op.target.account!, op.target.region!);

  async function filledBlueprint(op: Operation) {
    const { blueprint, zip, codeSha256 } = await deps.bundle();
    const filled = fill(blueprint, { name: routerName, region: op.target.region!, account: op.target.account!, partition: 'aws', ...deps.settings.routerSettings });
    return { blueprint: filled, zip, codeSha256 };
  }

  // The router's roles that call the clusters (their access entries).
  async function routerRolesOf(op: Operation) {
    const { blueprint } = await filledBlueprint(op);
    return blueprint.roles.filter((r) => ['controller', 'waker', 'onboarder'].includes(r.key)).map((r) => `arn:aws:iam::${op.target.account}:role${r.path}${r.name}`);
  }

  async function installer(op: Operation) {
    const { blueprint, zip, codeSha256 } = await filledBlueprint(op);
    const target = await access(op);
    const boundaryArn = `arn:aws:iam::${op.target.account}:policy/DmtRouterBoundary`;
    return { blueprint, run: target.installer({ boundaryArn, principals: deps.settings.principals, zip: async () => zip, codeSha256 }) };
  }

  // The forwarder of the router bundle (routers 0.23.0 and later), filled for the operation's account.
  async function forwarderOf(op: Operation) {
    const { blueprint } = await deps.bundle();
    if (!blueprint.forwarder) throw new Error(`the router bundle ${blueprint.router?.version ?? ''} has no forwarder: routers 0.23.0 or later`);
    return fill(blueprint.forwarder, { name: routerName, account: op.target.account!, partition: 'aws', ...deps.settings.routerSettings });
  }
  // The installer of the account in a region (IAM is the account's: any region does for the role).
  const regionsOf = (op: Operation) => (op.input.regions as string[]) ?? [];
  async function regionInstaller(op: Operation, region: string) {
    const target = await deps.target(op.target.account!, region);
    return target.installer({ boundaryArn: `arn:aws:iam::${op.target.account}:policy/DmtRouterBoundary`, principals: deps.settings.principals, zip: async () => new Uint8Array(), codeSha256: '' });
  }
  const stepsOf = (results: StepResult[]): Outcome => {
    const details = results.flatMap((r) => (r.status === 'done' && r.detail ? [r.detail] : []));
    return details.length ? { status: 'done', detail: details.join('; ') } : { status: 'skipped' };
  };

  async function lock(op: Operation, key: string, what: string): Promise<Outcome> {
    if (await records.acquireLock(key, op.id, LOCK_LEASE)) {
      if (!op.holds.locks.includes(key)) op.holds.locks.push(key);
      return { status: 'done' };
    }
    throw new Busy(`another operation holds the ${what}`);
  }

  const installing = (op: Operation) => op.context.install === true;
  const invokeRouter = async (op: Operation, fn: 'controller' | 'onboarder', payload: Record<string, unknown>) => {
    const router = op.context.router as RouterRef;
    const arn = fn === 'controller' ? router.controller : router.onboarder;
    if (!arn) throw new Error(`router ${router.name} has no onboarder: upgrade it to 0.17.0 or later`);
    return (await access(op)).invoke(arn, payload);
  };

  async function updateCandidate(op: Operation, change: (c: Candidate) => Candidate): Promise<Outcome> {
    const id = String(op.input.candidateId ?? op.context.targetGroupArn ?? '');
    const c = id ? await deps.discovery?.getCandidate(id) : null;
    if (!c) return { status: 'skipped', detail: 'no discovery candidate' };
    await deps.discovery!.replaceCandidates([restatus(change(c), iso(now()))], [c]);
    return { status: 'done' };
  }

  async function run(op: Operation, name: string): Promise<Outcome> {
    if (name.startsWith('install ')) {
      if (op.type === 'onboard' && !installing(op)) return { status: 'skipped' };
      const { blueprint, run: inst } = await installer(op);
      return inst.install(name.slice('install '.length) as InstallStep, blueprint);
    }
    if (name.startsWith('uninstall ')) {
      const { blueprint, run: inst } = await installer(op);
      return inst.uninstall(name.slice('uninstall '.length) as UninstallStep, blueprint);
    }
    switch (name) {
      case 'forwarder role': {
        // Recorded before anything is created: a connect failing part-way is still disconnected (R5c review I4).
        const current = await deps.discovery!.getConnection(op.target.account!);
        await deps.discovery!.putConnection({
          ...(current ?? { connectedAt: iso(now()) }), account: op.target.account!, regions: [...new Set([...(current?.regions ?? []), ...regionsOf(op)])].sort(),
          status: current?.status === 'connected' ? 'connected' : 'connecting',
        });
        return (await regionInstaller(op, regionsOf(op)[0] ?? 'us-east-1')).forwarder.role(await forwarderOf(op));
      }
      case 'forwarder rules': {
        const f = await forwarderOf(op);
        const results: StepResult[] = [];
        for (const region of regionsOf(op)) results.push(await (await regionInstaller(op, region)).forwarder.rule(f));
        return stepsOf(results);
      }
      case 'connected': {
        const current = await deps.discovery!.getConnection(op.target.account!);
        await deps.discovery!.putConnection({ account: op.target.account!, regions: [...new Set([...(current?.regions ?? []), ...regionsOf(op)])].sort(), status: 'connected', connectedAt: iso(now()) });
        return { status: 'done' };
      }
      case 'remove forwarder rules': {
        // Every region connected, whatever the operation names.
        const connected = (await deps.discovery!.getConnection(op.target.account!))?.regions ?? [];
        op.context.regions = [...new Set([...regionsOf(op), ...connected])];
        const f = await forwarderOf(op);
        const results: StepResult[] = [];
        for (const region of op.context.regions as string[]) results.push(await (await regionInstaller(op, region)).forwarder.removeRule(f));
        return stepsOf(results);
      }
      case 'remove forwarder role':
        return (await regionInstaller(op, (op.context.regions as string[] | undefined)?.[0] ?? 'us-east-1')).forwarder.removeRole(await forwarderOf(op));
      case 'disconnected': {
        if (!(await deps.discovery!.getConnection(op.target.account!))) return { status: 'skipped' };
        await deps.discovery!.deleteConnection(op.target.account!);
        return { status: 'done' };
      }
      case 'find router': {
        const router = await routerOf(op);
        const where = `${op.target.account}/${op.target.region}`;
        if (op.type === 'install-router') {
          if (router) throw new Error(`router ${router.name} is already in ${where}`);
          op.context.install = true;
          return { status: 'done', detail: `no router in ${where}` };
        }
        if (op.type === 'onboard') {
          if (router?.uninstalling) throw new Error(`router ${router.name} is being uninstalled`);
          if (router) {
            op.context.router = router;
            return { status: 'done', detail: `router ${router.name}` };
          }
          op.context.install = true;
          return { status: 'done', detail: `no router in ${where}: installing ${routerName}` };
        }
        if (!router) throw new Error(`no router in ${where}`);
        if (op.type === 'cluster-access') {
          op.context.router = router;
          return { status: 'done', detail: `router ${router.name} ${router.version ?? ''}`.trim() };
        }
        if (router.source !== 'manager') throw new Error(`router ${router.name} was installed by Terraform: remove it with Terraform`);
        op.context.router = router;
        op.context.install = true;
        return { status: 'done', detail: `router ${router.name} ${router.version ?? ''}`.trim() };
      }
      case 'lock router':
        if (op.type === 'onboard' && !installing(op)) return { status: 'skipped' };
        return lock(op, `ROUTER#${op.target.account}#${op.target.region}`, 'router');
      case 'register router': {
        if (op.type === 'onboard' && !installing(op)) return { status: 'skipped' };
        const { blueprint } = await filledBlueprint(op);
        const fn = (key: string) => `arn:aws:lambda:${op.target.region}:${op.target.account}:function:${blueprint.functions.find((f) => f.key === key)!.name}`;
        const router = {
          name: blueprint.router.name, account: op.target.account!, region: op.target.region!, controller: fn('controller'), onboarder: fn('onboarder'),
          version: blueprint.router.version, build: blueprint.router.build, installedBy: op.by, installedAt: iso(now()),
        };
        await records.putRouter(router);
        op.context.router = { ...router, source: 'manager' };
        return { status: 'done', detail: `${router.name} ${router.version}` };
      }
      case 'access entries': {
        const kubernetes = await kubernetesOf(op);
        if (op.type === 'onboard' && !kubernetes) return { status: 'skipped' };
        const router = op.context.router as RouterRef;
        if (router.source === 'terraform') {
          if (kubernetes) op.context.clusters = [kubernetes.cluster];
          return { status: 'skipped', detail: `router ${router.name} is written in Terraform: its access entries are the customer's (module eks-access)` };
        }
        const routerRoles = await routerRolesOf(op);
        const discoveryRole = `arn:aws:iam::${op.target.account}:role/${deps.settings.discoveryRole ?? 'DmtDiscoveryRole'}`;
        let results;
        try {
          results = await ensureClusterAccess((await access(op)).eks, { routerRoles, discoveryRole });
        } catch (err) {
          // A router's install or upgrade goes on without its clusters; what needs a cluster fails.
          if (err instanceof ClusterAccessDenied && (op.type === 'install-router' || op.type === 'upgrade-router')) return { status: 'skipped', detail: err.message };
          throw err;
        }
        op.context.clusters = results.filter((r) => r.ready).map((r) => r.cluster);
        if (results.some((r) => r.status === 'done')) op.context.entriesAt = now();
        if (!results.length) return { status: 'skipped', detail: 'no EKS cluster in the account and region' };
        return { status: results.some((r) => r.status === 'done') ? 'done' : 'skipped', detail: results.map((r) => r.detail).join('; ') };
      }
      case 'check clusters': {
        const clusters = (op.context.clusters as string[] | undefined) ?? [];
        if (!clusters.length) return { status: 'skipped' };
        const kubernetes = await kubernetesOf(op);
        const checks: { cluster: string; reachable: boolean; allowed: boolean; missing: string[]; reason?: string }[] = [];
        for (const cluster of clusters) {
          try {
            checks.push(await invokeRouter(op, 'controller', { action: 'clusterCheck', cluster, ...(kubernetes?.cluster === cluster ? { namespace: kubernetes.namespace } : {}) }));
          } catch (err) {
            if (/unknown action/.test((err as Error).message)) return { status: 'skipped', detail: `router ${(op.context.router as RouterRef).name} is older than 0.29.0: no cluster check` };
            throw err;
          }
        }
        // Entries just made: a cluster that does not know the router's role yet is asked again.
        const entriesAt = op.context.entriesAt as number | undefined;
        if (entriesAt && now() - entriesAt < ENTRY_PROPAGATION_MS && checks.some((c) => c.reachable && !c.allowed && !c.missing?.length)) {
          return { status: 'wait', seconds: 15, detail: 'the cluster takes the new access entries' };
        }
        // Kept on the router: its view lists the clusters with their reach and rights.
        const installed = await records.getRouter(op.target.account!, op.target.region!);
        if (installed) {
          const checkedAt = iso(now());
          await records.putRouter({ ...installed, clusters: checks.map((c) => ({ name: c.cluster, reachable: c.reachable, allowed: c.allowed, missing: c.missing ?? [], ...(c.reason ? { reason: c.reason } : {}), checkedAt })) });
        }
        // An onboarding stops on its candidate's cluster when the router may not use it.
        const own = kubernetes && checks.find((c) => c.cluster === kubernetes.cluster);
        if (own && !own.allowed) {
          throw new Error(`cluster ${own.cluster}: ${own.missing?.length ? `the router may not ${own.missing.join('; ')}: apply dormeto-kubernetes-<version>.yaml of the release (the ClusterRole and its binding to the group dormeto:router): https://dormeto.com/organization-access.html#kubernetes` : own.reason ?? 'not allowed'}`);
        }
        const text = (c: (typeof checks)[number]) => `cluster ${c.cluster}: ${!c.reachable ? `unreachable (${c.reason})` : c.allowed ? 'reachable, every right' : `missing ${c.missing?.length ? c.missing.join('; ') : c.reason}`}`;
        return { status: 'done', detail: checks.map(text).join('; ') };
      }
      case 'verify router': {
        const info = await invokeRouter(op, 'controller', { action: 'router' });
        return { status: 'done', detail: `router ${info?.router?.version} build ${info?.router?.build}` };
      }
      case 'mark uninstalling': {
        const installed = await records.getRouter(op.target.account!, op.target.region!);
        if (installed && !installed.uninstalling) await records.putRouter({ ...installed, uninstalling: true });
        return { status: 'done' };
      }
      case 'check empty': {
        // Operations still running on the router (onboardings that found it before the mark) finish first.
        if ((await records.slotHolders(`${op.target.account}#${op.target.region}`)).length) throw new Busy('operations are still running on the router');
        let listed;
        try {
          listed = await invokeRouter(op, 'controller', { action: 'list' });
        } catch (err) {
          // A controller deleted by an earlier attempt of this uninstall: nothing left to offboard.
          if ((err as Error).name !== 'ResourceNotFoundException') throw err;
          return { status: 'done', detail: 'controller already deleted' };
        }
        const count = (listed?.workloads ?? []).length;
        if (count) throw new Error(`router ${(op.context.router as RouterRef).name} still has ${count} workload${count === 1 ? '' : 's'}: offboard ${count === 1 ? 'it' : 'them'} first`);
        return { status: 'done' };
      }
      case 'remove access entries': {
        const routerRoles = await routerRolesOf(op);
        let results;
        try {
          results = await removeClusterAccess((await access(op)).eks, { routerRoles });
        } catch (err) {
          if (!(err instanceof ClusterAccessDenied)) throw err;
          const names = routerRoles.map((arn) => arn.split('/').at(-1)).join(', ');
          return { status: 'skipped', detail: `${err.message}; remove the access entries of the router's roles (${names}) from the region's clusters by hand` };
        }
        if (!results.length) return { status: 'skipped', detail: 'no EKS cluster in the account and region' };
        return { status: results.some((r) => r.status === 'done') ? 'done' : 'skipped', detail: results.map((r) => r.detail).join('; ') };
      }
      case 'unregister router':
        await records.deleteRouter(op.target.account!, op.target.region!);
        return { status: 'done' };
      case 'locate': {
        const router = await routerOf(op);
        if (!router) throw new Error(`no router in ${op.target.account}/${op.target.region}`);
        op.context.router = router;
        const status = await invokeRouter(op, 'controller', { action: 'status', workloadId: op.target.workloadId });
        // Refused before waking it: the onboarder only offboards what the manager onboarded.
        if (status?.source === 'terraform') throw new Error(`workload ${op.target.workloadId} was written in Terraform: remove its workload module instead`);
        const ruleArn = status?.rules?.[0]?.arn as string | undefined;
        op.context.targetGroupArn = status?.targetGroupArn;
        op.context.loadBalancerArn = ruleArn ? loadBalancerOfRule(ruleArn) : null;
        op.context.wakeTimeoutSeconds = status?.settings?.wakeTimeoutSeconds ?? 600;
        // The name people see (routers 0.20.0 and later), for the operation's title.
        op.context.name = status?.name ?? op.target.workloadId;
        return { status: 'done', detail: `${op.context.name} ${status?.state}` };
      }
      case 'lock load balancer': {
        const lb = op.target.loadBalancerArn ?? (op.context.loadBalancerArn as string | null);
        if (!lb) return { status: 'skipped', detail: 'no rule left: no load balancer to lock' };
        return lock(op, `LB#${lb}`, 'load balancer');
      }
      case 'slot': {
        const key = `${op.target.account}#${op.target.region}`;
        if (!(await records.acquireSlot(key, op.id, SLOTS, LOCK_LEASE))) {
          await records.releaseSlot(ORG_SLOT, op.id);
          op.holds.slots = op.holds.slots.filter((k) => k !== ORG_SLOT);
          throw new SlotBusy(`${SLOTS} operations already run in ${op.target.account}/${op.target.region}`);
        }
        if (!op.holds.slots.includes(key)) op.holds.slots.push(key);
        // An uninstall marked after this operation found the router: stop (it waits for the slots to be released).
        const current = await routerOf(op);
        if (current?.uninstalling) throw new Error(`router ${current.name} is being uninstalled`);
        return { status: 'done' };
      }
      case 'preview': {
        const preview = await previewOf(op);
        if (!preview.ok) throw new Error((preview.problems ?? ['refused']).join('; '));
        return { status: 'done', detail: `${preview.name} (${preview.workloadId})` };
      }
      case 'onboard': {
        // An operation started by a manager that did not keep the preview's id yet: ask again.
        if (!op.context.workloadId) await previewOf(op);
        const kubernetes = await kubernetesOf(op);
        const result = await invokeRouter(op, 'onboarder', {
          action: 'onboard', workloadId: op.context.workloadId, targetGroupArn: op.target.targetGroupArn, name: op.context.name,
          settings: op.input.settings ?? {}, databases: op.input.databases ?? [], by: op.by, ...(kubernetes ? { kubernetes } : {}),
        });
        op.context.wakerTargetGroupArn = result?.workload?.wakerTargetGroupArn;
        return { status: 'done', detail: (result?.steps ?? []).filter((x: { status: string }) => x.status === 'done').map((x: { name: string }) => x.name).join(', ') };
      }
      case 'verify': {
        if (!op.context.workloadId) await previewOf(op);
        const status = await invokeRouter(op, 'controller', { action: 'status', workloadId: op.context.workloadId });
        if (status?.route !== 'app' || (status?.issues ?? []).length) throw new Error(`route ${status?.route}${status?.issues?.length ? `, issues: ${status.issues.join('; ')}` : ''}`);
        return { status: 'done', detail: `${op.context.name} ${status.state}, route app` };
      }
      case 'pause': {
        const result = await invokeRouter(op, 'controller', { action: 'pause', workloadId: op.target.workloadId, by: op.by, reason: 'offboarding', keepAsleep: false });
        return { status: 'done', ...(result?.woken?.length ? { detail: 'woken' } : {}) };
      }
      case 'wait awake': {
        const status = await invokeRouter(op, 'controller', { action: 'status', workloadId: op.target.workloadId });
        if (status?.state === 'AWAKE') return { status: 'done' };
        const started = Date.parse((op.steps[op.cursor]!.startedAt) ?? iso(now()));
        if (now() - started > Number(op.context.wakeTimeoutSeconds ?? 600) * 1000 + WAKE_GRACE) throw new Error(`still ${status?.state} after the wake timeout`);
        return { status: 'wait', seconds: 15, detail: status?.state };
      }
      case 'offboard': {
        const result = await invokeRouter(op, 'onboarder', { action: 'offboard', workloadId: op.target.workloadId, by: op.by });
        return { status: 'done', detail: (result?.steps ?? []).filter((x: { status: string }) => x.status === 'done').map((x: { name: string }) => x.name).join(', ') };
      }
      case 'pause workloads': return pauseExcluded(op);
      case 'resume workloads': return resumeExcluded(op);
      case 'candidate':
        if (op.type === 'onboard' && !op.context.workloadId) await previewOf(op);
        return op.type === 'onboard'
          ? updateCandidate(op, (c) => {
            const { reason: _r, ...rest } = c;
            return { ...rest, eligibility: 'managed', workloadId: String(op.context.workloadId) };
          })
          : updateCandidate(op, (c) => {
            const { workloadId: _w, ...rest } = c;
            return { ...rest, eligibility: 'eligible' };
          });
      default:
        throw new Error(`unknown step: ${name}`);
    }
  }

  // --- Workflow tasks --------------------------------------------------------------------------------------------------

  async function finish(op: Operation, status: 'succeeded' | 'failed', error?: string) {
    // A connect or disconnect that failed: its error on the connection, so that the next runs show it and wait before
    // trying again (R5c review I5).
    if (status === 'failed' && (op.type === 'connect-account' || op.type === 'disconnect-account') && deps.discovery) {
      const current = await deps.discovery.getConnection(op.target.account!).catch(() => null);
      const regions = [...new Set([...(current?.regions ?? []), ...regionsOf(op)])].sort();
      await deps.discovery.putConnection({ connectedAt: iso(now()), status: 'connecting', ...current, account: op.target.account!, regions, lastError: error ?? 'failed', failedAt: iso(now()) })
        .catch((err) => deps.log.warn('ConnectionNotUpdated', { account: op.target.account, error: (err as Error).message }));
    }
    for (const key of op.holds.locks) await records.releaseLock(key, op.id);
    for (const key of op.holds.slots) await records.releaseSlot(key, op.id);
    await records.releaseActive(op.activeKey, op.id);
    op.holds = { locks: [], slots: [] };
    op.status = status;
    op.finishedAt = iso(now());
    op.updatedAt = op.finishedAt;
    if (error) op.error = error;
    await records.putOperation(op);
    deps.log[status === 'succeeded' ? 'info' : 'warn']('OperationFinished', { id: op.id, type: op.type, status, ...(error ? { error } : {}) });
  }

  // Runs the current step: done (the next step follows at once), pending or waiting (come back later), or failed.
  async function next(id: string): Promise<{ done: boolean; status?: 'succeeded' | 'failed'; waitSeconds?: number }> {
    const op = await records.getOperation(id);
    if (!op) throw new Error(`unknown operation: ${id}`);
    if (op.status !== 'running') return { done: true, status: op.status };
    const step = op.steps[op.cursor];
    if (!step) {
      await finish(op, 'succeeded');
      return { done: true, status: 'succeeded' };
    }
    // Leases of what it holds are renewed at each step: a long wait never lets another operation in.
    for (const key of op.holds.locks) await records.acquireLock(key, op.id, LOCK_LEASE);
    for (const key of op.holds.slots) await records.acquireSlot(key, op.id, slotMax(key), LOCK_LEASE);
    step.status = 'running';
    step.startedAt ??= iso(now());
    step.attempts = (step.attempts ?? 0) + 1;
    op.updatedAt = iso(now());
    try {
      if (!op.holds.slots.includes(ORG_SLOT)) {
        if (!(await records.acquireSlot(ORG_SLOT, op.id, ORG_SLOTS, LOCK_LEASE))) throw new SlotBusy(`${ORG_SLOTS} operations already run across the organization: waiting for one to end`);
        op.holds.slots.push(ORG_SLOT);
      }
      const outcome = await run(op, step.name);
      if (outcome.status === 'pending' || outcome.status === 'wait') {
        if (outcome.status === 'pending' && outcome.changed) step.changed = true;
        if (outcome.detail) step.detail = outcome.detail;
        if (outcome.status === 'pending' && now() - Date.parse(step.startedAt) > PENDING_MAX) {
          throw new Error(`still pending after ${PENDING_MAX / MINUTE} minutes${outcome.detail ? ` (${outcome.detail})` : ''}`);
        }
        await records.putOperation(op);
        return { done: false, waitSeconds: outcome.status === 'wait' ? outcome.seconds : 5 };
      }
      step.status = step.changed || outcome.status === 'done' ? 'done' : 'skipped';
      if (outcome.detail) step.detail = outcome.detail;
      step.finishedAt = iso(now());
      op.cursor += 1;
      if (op.cursor >= op.steps.length) {
        await finish(op, 'succeeded');
        return { done: true, status: 'succeeded' };
      }
      await records.putOperation(op);
      return { done: false, waitSeconds: 0 };
    } catch (err) {
      const waited = now() - Date.parse(step.startedAt);
      if (err instanceof SlotBusy && now() - Date.parse(op.createdAt) <= SLOT_WAIT_MAX) {
        step.detail = err.message;
        await records.putOperation(op);
        return { done: false, waitSeconds: slotWait(step.attempts) };
      }
      if (err instanceof Busy && waited <= BUSY_MAX) {
        step.detail = err.message;
        await records.putOperation(op);
        return { done: false, waitSeconds: 10 };
      }
      if ((err instanceof RetryLater || TRANSIENT.has((err as Error).name)) && step.attempts <= RETRY_MAX) {
        step.detail = (err as Error).message;
        await records.putOperation(op);
        return { done: false, waitSeconds: err instanceof RetryLater ? err.seconds : 10 };
      }
      const message = err instanceof SlotBusy ? `waited more than ${SLOT_WAIT_MAX / 60 / MINUTE} hours for a slot: ${err.message}`
        : err instanceof Busy ? `${err.message} since more than ${BUSY_MAX / MINUTE} minutes` : (err as Error).message;
      step.status = 'failed';
      step.detail = message;
      step.finishedAt = iso(now());
      await finish(op, 'failed', `${step.name}: ${message}`);
      return { done: true, status: 'failed' };
    }
  }

  // The workflow failed outside a step (a task timeout, a Lambda error): release and record.
  async function fail(id: string, error: string) {
    const op = await records.getOperation(id);
    if (!op || op.status !== 'running') return;
    const step = op.steps[op.cursor];
    if (step && step.status === 'running') {
      step.status = 'failed';
      step.detail = error;
    }
    await finish(op, 'failed', error);
  }

  // The connections decided by a discovery run (packaging design §5): an operation per account, none for an account with
  // one running, nor a connect where the last check found no command role (as onboardings are refused, R5a).
  async function connections({ connect, disconnect }: { connect: { account: string; regions: string[] }[]; disconnect: string[] }, by: string) {
    const created: string[] = [];
    const skipped: { account: string; reason: string }[] = [];
    const start = async (type: OperationType, input: { account: string; regions: string[] }) => {
      try {
        created.push((await create(type, input, by)).id);
      } catch (err) {
        if (!(err instanceof Conflict)) throw err;
        skipped.push({ account: input.account, reason: 'another operation runs on this account' });
      }
    };
    for (const c of connect) {
      const command = (await deps.discovery?.getAccountScan(c.account))?.access?.command;
      if (command && !command.ok) {
        skipped.push({ account: c.account, reason: `no command role: ${command.reason}` });
        continue;
      }
      await start('connect-account', c);
    }
    for (const account of disconnect) await start('disconnect-account', { account, regions: [] });
    return { created, skipped };
  }

  return { create, next, fail, connections };
}

export type Engine = ReturnType<typeof createEngine>;
