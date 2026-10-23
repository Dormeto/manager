// What the dashboard's actions change in the demo (npm run dev:mock), validated and audited as the API does.
import type { Candidate, DiscoveryConfig } from '@dormeto/discovery/types';
import type { Pause } from '../types';
import { AVAILABLE } from './fixtures';
import { groupNameProblem, tagsProblem } from '../tags';
import { grantRowsProblem } from '../groups';
import { rowsOf } from '../tags';
import { ACCOUNTS, ME, accountName } from './org';
import {
  addOperation, audited, change, fail, matches, onboardEffect, plan, operationStatus, restatus, routerIn, routerOf, runRecord, workloadOf,
  type Demo, type DemoGroup, type DemoOperation, type DemoRouter, type DemoWorkload, type WorkflowType,
} from './state';
import { operationView } from './views';
import { MINUTE, SECOND, iso } from './util';
import { hasHibernation, hibernationOf } from './state';

type Body = Record<string, unknown>;
const ACCOUNT = /^\d{12}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ROLES = ['viewer', 'operator', 'admin', 'member'];
const CLUSTER_STEPS = ['access entries', 'check clusters'];

// --- Pauses, naps and wakes ----------------------------------------------------------------------------------------------

function reasonIn(body: Body, max = 256): string {
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason || reason.length > max) fail(400, 'bad_request', `reason required, at most ${max} characters`);
  return reason;
}
function aheadIn(body: Body, key: string, now: number): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || Date.parse(value) <= now) fail(400, 'bad_request', `${key} must be a date in the future`);
  return new Date(Date.parse(value as string)).toISOString();
}
function pauseRequest(body: Body, now: number) {
  const reason = reasonIn(body);
  const until = aheadIn(body, 'until', now);
  if (body.keepAsleep !== undefined && typeof body.keepAsleep !== 'boolean') fail(400, 'bad_request', 'keepAsleep must be true or false');
  const keepAsleep = body.keepAsleep === true;
  const text = (woken: string[]) => [reason, ...(until ? [`until ${until}`] : []), ...(keepAsleep ? ['keep asleep'] : []), ...(woken.length ? [`woken ${woken.join(', ')}`] : [])].join('; ');
  return { reason, until, keepAsleep, text };
}

// A wake from the manager: started now, or once the nap in progress ends.
function wake(w: DemoWorkload, cause: string, now: number): boolean {
  if (w.state === 'NAPPING') {
    w.pendingWake = true;
    return true;
  }
  if (w.state !== 'ASLEEP' && w.state !== 'FAILED') return false;
  change(w, 'WAKING', now, { cause, by: ME });
  return true;
}
// Requests stop with a pause lifted: the workload naps again once idle.
const settle = (w: DemoWorkload, now: number) => {
  if (w.activeUntil !== Infinity) w.activeUntil = Math.max(w.activeUntil, now);
};

export function pauseRouter(d: Demo, r: DemoRouter, body: Body, now: number) {
  const { reason, until, keepAsleep, text } = pauseRequest(body, now);
  return audited(d, 'router-pause', r.name, () => {
    if (r.pauses.length) fail(409, 'conflict', `router ${r.name} is already paused`);
    r.pauses = [{ scope: 'router', by: ME, at: iso(now), reason, until: until ?? null, keepAsleep }];
    const woken = keepAsleep ? [] : d.workloads.filter((w) => w.router === r.name && wake(w, 'pause', now));
    return { result: text(woken.map((w) => w.workloadId)), response: { woken: woken.map((w) => w.name) } };
  });
}

export function resumeRouter(d: Demo, r: DemoRouter, now: number) {
  return audited(d, 'router-resume', r.name, () => {
    const resumed = r.pauses.length > 0;
    r.pauses = [];
    for (const w of d.workloads) if (w.router === r.name) settle(w, now);
    return { result: resumed ? 'resumed' : 'not paused', response: { resumed } };
  });
}

export function workloadAction(d: Demo, router: string, id: string, action: string, body: Body, now: number) {
  const w = workloadOf(d, router, id);
  const target = `${router}/${id}`;
  const routerPaused = d.routers.find((r) => r.name === router)?.pauses.length;
  switch (action) {
    case 'nap':
      return audited(d, 'nap', target, () => {
        if (w.pauses.length || routerPaused) fail(409, 'conflict', 'workload paused: never napped until resumed');
        if (w.state !== 'AWAKE') fail(409, 'conflict', `not awake: ${w.state}`);
        change(w, 'NAPPING', now, { cause: 'manager', by: ME });
        w.activeUntil = now;
        w.lastRequestAt = now - 4 * MINUTE;
        return { result: 'requested', response: { accepted: true } };
      });
    case 'wake':
      return audited(d, 'wake', target, () => {
        // Someone looks at it for a few minutes, then it naps once idle.
        if (wake(w, 'manager', now) && w.activeUntil !== Infinity) w.activeUntil = now + 3 * MINUTE + w.wakeMs;
        return { result: w.pendingWake ? 'NAPPING, woken after the nap' : w.state, response: { state: w.state } };
      });
    case 'pause': {
      const { reason, until, keepAsleep, text } = pauseRequest(body, now);
      return audited(d, 'pause', target, () => {
        if (w.pauses.some((p) => !p.exclusionId)) fail(409, 'conflict', 'already paused');
        w.pauses.push({ scope: 'workload', by: ME, at: iso(now), reason, until: until ?? null, keepAsleep });
        const woken = !keepAsleep && wake(w, 'pause', now) ? [w.workloadId] : [];
        return { result: text(woken), response: { woken } };
      });
    }
    case 'resume':
      return audited(d, 'resume', target, () => {
        const before = w.pauses.length;
        w.pauses = w.pauses.filter((p) => p.exclusionId);
        settle(w, now);
        return { result: before > w.pauses.length ? 'resumed' : 'not paused', response: { resumed: before > w.pauses.length } };
      });
    case 'rename': {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      // eslint-disable-next-line no-control-regex
      if (!name || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) fail(400, 'bad_request', 'name required: at most 64 characters, no control characters');
      return audited(d, 'rename', target, () => {
        if (w.source === 'terraform') fail(409, 'conflict', `workload ${id} written by Terraform: rename it in its workload module`);
        w.name = name;
        return { result: name, response: { workloadId: w.workloadId, name } };
      });
    }
  }
  return fail(404, 'not_found', `no route for POST /api/workloads/${router}/${id}/${action}`);
}

// --- Operations ----------------------------------------------------------------------------------------------------------

const conflict = (d: Demo, now: number, same: (op: DemoOperation) => boolean) => {
  const running = d.operations.find((op) => operationStatus(op, now) === 'running' && same(op));
  if (running) fail(409, 'conflict', `another operation is running on this target: ${running.id}`, { operationId: running.id });
};
const commandRole = (account: string) => {
  const a = ACCOUNTS.find((x) => x.id === account);
  if (a && !a.command) fail(409, 'no_access', `account ${account}: its command role DmtCommandRole cannot be assumed (AccessDenied); see the Organization access page`);
};
const newRouterName = (account: string, region: string) => `dmtr-${accountName(account)}-${region}`;
const newRouter = (account: string, region: string, at: number): DemoRouter => ({
  name: newRouterName(account, region), account, region, source: 'manager', ...AVAILABLE, installedAt: at, metrics: false,
  concurrency: { limit: 1000, needed: 6, worstCase: 12 }, peak: 1, clusters: [], ownLists: [], pauses: [], hibernate: null, hibernateBy: null, hibernateAt: null, readsManager: true,
});

export function startOperation(d: Demo, body: Body, now: number) {
  const type = String(body.type ?? '') as WorkflowType;
  if (!['onboard', 'offboard', 'install-router', 'upgrade-router', 'uninstall-router'].includes(type)) {
    fail(400, 'bad_request', 'type must be onboard, offboard, install-router, upgrade-router or uninstall-router');
  }
  const id = crypto.randomUUID();
  let op: Omit<DemoOperation, 'applied'>;
  let target: string;
  if (type === 'onboard') {
    const c = d.candidates.find((x) => x.id === body.candidateId) ?? fail(400, 'bad_request', `unknown candidate: ${String(body.candidateId)}`);
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined;
    if (name && name.length > 64) fail(400, 'bad_request', 'name: at most 64 characters');
    const tagsError = body.tags === undefined ? null : tagsProblem(body.tags as Record<string, string>);
    if (tagsError) fail(400, 'bad_request', tagsError);
    commandRole(c.account);
    if (c.status !== 'pending-onboarding') fail(409, 'conflict', `${c.targetGroup ?? c.id} is not to onboard (${c.status})`);
    conflict(d, now, (o) => o.target.targetGroupArn === c.targetGroupArn);
    const router = routerIn(d, c.account, c.region);
    const kubernetes = c.backend?.kind === 'k8s';
    op = {
      id, type, target: { account: c.account, region: c.region, targetGroupArn: c.targetGroupArn ?? c.id, loadBalancerArn: c.loadBalancerArn },
      input: { candidateId: c.id, ...(name ? { name } : {}), settings: body.settings ?? {}, databases: body.databases ?? [], ...(body.tags !== undefined ? { tags: body.tags } : {}) }, context: { name: name ?? c.targetGroup ?? c.id },
      by: ME, createdAt: now,
      steps: plan('onboard', now, {
        skip: (s) => (router ? s.startsWith('install ') || s === 'register router' : false) || (!kubernetes && CLUSTER_STEPS.includes(s)),
        details: {
          'find router': router ? `${router.name} ${router.version}` : `none: installing ${newRouterName(c.account, c.region)} ${AVAILABLE.version}`,
          preview: `${c.rules.length} rule${c.rules.length === 1 ? '' : 's'}, the waker target group to create`,
          ...(kubernetes ? { 'check clusters': `${c.backend?.kubernetes?.cluster ?? 'cluster'}: reachable, every right` } : {}),
        },
      }),
    };
    target = `${c.id}${name ? ` as ${name}` : ''}`;
  } else if (type === 'install-router') {
    const account = String(body.account ?? '');
    const region = String(body.region ?? '');
    if (!ACCOUNT.test(account) || !REGION.test(region)) fail(400, 'bad_request', 'account (12 digits) and region required');
    if (!ACCOUNTS.some((a) => a.id === account)) fail(404, 'not_found', `unknown account or region: ${account}/${region}`);
    commandRole(account);
    const existing = routerIn(d, account, region);
    if (existing) fail(409, 'conflict', `${existing.name} is already installed in ${account}/${region}`);
    conflict(d, now, (o) => o.target.account === account && o.target.region === region && o.type.endsWith('-router'));
    op = {
      id, type, target: { account, region }, input: { account, region }, by: ME, createdAt: now,
      steps: plan(type, now, { skip: (s) => CLUSTER_STEPS.includes(s), details: { 'find router': `none: installing ${newRouterName(account, region)} ${AVAILABLE.version}`, 'verify router': `${AVAILABLE.version} (${AVAILABLE.build})` } }),
      effect: (at) => { if (!routerIn(d, account, region)) d.routers.push(newRouter(account, region, at)); },
    };
    target = `${account}/${region}`;
  } else {
    const router = routerOf(d, String(body.router ?? ''));
    const where = { account: router.account, region: router.region };
    conflict(d, now, (o) => o.target.account === router.account && o.target.region === router.region && (o.type.endsWith('-router') || (body.workloadId !== undefined && o.target.workloadId === body.workloadId)));
    if (type === 'offboard') {
      const w = workloadOf(d, router.name, String(body.workloadId ?? ''));
      // The workload is woken first (paused), then its instrumentation removed.
      wake(w, 'pause', now);
      op = {
        id, type, target: { ...where, router: router.name, workloadId: w.workloadId }, input: { router: router.name, ...where, workloadId: w.workloadId }, context: { name: w.name },
        by: ME, createdAt: now, steps: plan(type, now, { details: { locate: router.name, 'wait awake': 'awake' }, slow: { step: 'wait awake', ms: Math.min(w.wakeMs, 90 * SECOND) + 5 * SECOND, every: 10 * SECOND } }),
        effect: (at) => {
          d.workloads = d.workloads.filter((x) => x !== w);
          const c = d.candidates.find((x) => x.workloadId === w.workloadId && x.account === w.account && x.region === w.region);
          if (c) {
            const { workloadId: _w, ...rest } = c;
            const released: Candidate = { ...rest, eligibility: 'eligible', rules: c.rules.map((x) => ({ ...x, managed: false })) };
            d.candidates = d.candidates.map((x) => (x === c ? released : x));
          }
          restatus(d, at);
        },
      };
      target = `${router.name}/${w.workloadId}`;
    } else {
      if (router.source === 'terraform') fail(409, 'conflict', `${router.name} is written in Terraform: change it with its router module`);
      if (type === 'upgrade-router') {
        if (router.version === AVAILABLE.version) fail(409, 'conflict', `${router.name} already runs ${AVAILABLE.version}`);
        op = {
          id, type, target: where, input: where, by: ME, createdAt: now,
          steps: plan(type, now, { skip: (s) => !router.clusters.length && CLUSTER_STEPS.includes(s), details: { 'find router': `${router.name} ${router.version}`, 'verify router': `${AVAILABLE.version} (${AVAILABLE.build})` } }),
          effect: () => Object.assign(router, { version: AVAILABLE.version, build: AVAILABLE.build }),
        };
      } else {
        const count = d.workloads.filter((w) => w.router === router.name).length;
        op = {
          id, type, target: where, input: where, by: ME, createdAt: now,
          steps: plan(type, now, { details: { 'find router': router.name }, ...(count ? { fail: { step: 'check empty', detail: `${count} workload${count === 1 ? '' : 's'}: offboard them first` } } : {}) }),
          ...(count ? { error: `check empty: ${router.name} still has ${count} workload${count === 1 ? '' : 's'}: offboard them first` } : {}),
          effect: () => { d.routers = d.routers.filter((r) => r !== router); },
        };
      }
      target = router.name;
    }
  }
  return audited(d, `operation-${type}`, target, () => {
    const created = addOperation(d, op);
    if (type === 'onboard') created.effect = onboardEffect(d, String(op.input.candidateId), created);
    return { result: `started ${id}`, response: { operation: operationView(created, now) } };
  });
}

// --- Exclusions ----------------------------------------------------------------------------------------------------------

const ARNS = {
  'target-group': /^arn:aws[\w-]*:elasticloadbalancing:([a-z0-9-]+):(\d{12}):targetgroup\/([^/]+)\/[0-9a-f]+$/,
  'load-balancer': /^arn:aws[\w-]*:elasticloadbalancing:([a-z0-9-]+):(\d{12}):loadbalancer\/app\/([^/]+)\/[0-9a-f]+$/,
};
const KIND_TEXT = { 'target-group': 'target group', 'load-balancer': 'load balancer', account: 'account' } as const;

export function createExclusion(d: Demo, body: Body, now: number) {
  const t = (body.target ?? {}) as { kind?: string; arn?: string; account?: string };
  let target: Demo['exclusions'][number]['target'];
  if (t.kind === 'account') {
    if (!ACCOUNT.test(String(t.account ?? ''))) fail(400, 'bad_request', 'target.account must be a 12-digit account ID');
    target = { kind: 'account', account: t.account!, name: accountName(t.account!) };
  } else if (t.kind === 'target-group' || t.kind === 'load-balancer') {
    const parsed = ARNS[t.kind].exec(String(t.arn ?? '')) ?? fail(400, 'bad_request', `target.arn must be the ARN of an application ${KIND_TEXT[t.kind]}`);
    target = { kind: t.kind, arn: t.arn!, account: parsed[2]!, region: parsed[1]!, name: parsed[3]! };
  } else {
    return fail(400, 'bad_request', 'target.kind must be target-group, load-balancer, account');
  }
  const reason = reasonIn(body, 246);
  const expiresAt = aheadIn(body, 'expiresAt', now);
  const text = `${KIND_TEXT[target.kind]} ${target.name}${target.kind === 'account' && target.name !== target.account ? ` (${target.account})` : ''}`;
  return audited(d, 'exclude', text, () => {
    const exclusion: Demo['exclusions'][number] = { id: crypto.randomUUID(), target, reason, by: ME, at: iso(now), ...(expiresAt ? { expiresAt } : {}) };
    d.exclusions.push(exclusion);
    // Its managed workloads are woken and never napped until offboarded.
    const paused = d.workloads.filter((w) => matches(exclusion, w));
    for (const w of paused) {
      const pause: Pause = { scope: 'workload', by: ME, at: iso(now), reason: `excluded: ${reason}`, until: expiresAt ?? null, keepAsleep: false, exclusionId: exclusion.id };
      w.pauses.push(pause);
      wake(w, 'pause', now);
    }
    if (paused.length) exclusion.paused = paused.map((w) => ({ router: w.router, workloadId: w.workloadId, account: w.account, region: w.region }));
    const candidates = restatus(d, now);
    const op = addOperation(d, {
      id: crypto.randomUUID(), type: 'exclude', target: { exclusionId: exclusion.id, account: target.account }, input: { exclusionId: exclusion.id }, by: ME, createdAt: now,
      steps: plan('exclude', now, { details: { 'pause workloads': paused.length ? `${paused.length} paused: ${paused.map((w) => w.name).join(', ')}` : `no managed workload in ${target.account}` } }),
    });
    return { result: [reason, ...(expiresAt ? [`until ${expiresAt}`] : []), `operation ${op.id}`].join('; '), response: { exclusion, candidates, operation: operationView(op, now) } };
  });
}

export function liftExclusion(d: Demo, id: string, now: number) {
  const exclusion = d.exclusions.find((e) => e.id === id) ?? fail(404, 'not_found', `unknown exclusion: ${id}`);
  return audited(d, 'exclusion-lift', `${KIND_TEXT[exclusion.target.kind]} ${exclusion.target.name}`, () => {
    for (const w of d.workloads) {
      if (!w.pauses.some((p) => p.exclusionId === id)) continue;
      w.pauses = w.pauses.filter((p) => p.exclusionId !== id);
      settle(w, now);
    }
    d.exclusions = d.exclusions.filter((e) => e !== exclusion);
    const candidates = restatus(d, now);
    const op = addOperation(d, {
      id: crypto.randomUUID(), type: 'lift-exclusion', target: { exclusionId: id, account: exclusion.target.account }, input: { exclusionId: id }, by: ME, createdAt: now,
      steps: plan('lift-exclusion', now, { details: { 'resume workloads': exclusion.paused?.length ? `${exclusion.paused.length} resumed` : 'no workload paused' } }),
    });
    return { result: `${exclusion.reason}; operation ${op.id}`, response: { candidates, operation: operationView(op, now) } };
  });
}

// --- Discovery -----------------------------------------------------------------------------------------------------------

export function runDiscovery(d: Demo, now: number) {
  return audited(d, 'discovery-run', 'discovery', () => {
    if (d.runs.at(-1)?.record.status === 'running') fail(409, 'conflict', 'a discovery run is in progress');
    const record = runRecord(d, now, now, 'manual', ME);
    d.runs.push({ record: { ...record, status: 'running', targets: [], emptyPairs: 0, skipped: [] }, finishAt: now + 9 * SECOND });
    return { result: 'requested', response: { accepted: true } };
  });
}

export function changeDismissal(d: Demo, action: 'dismiss' | 'restore', body: Body, now: number) {
  const ids = body.ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some((x) => typeof x !== 'string')) fail(400, 'bad_request', 'ids must be a list of 1 to 100 candidate IDs');
  const found = (ids as string[]).map((x) => d.candidates.find((c) => c.id === x));
  const missing = (ids as string[]).filter((_, i) => !found[i]);
  if (missing.length) fail(404, 'not_found', `unknown candidates: ${missing.join(', ')}`);
  const note = typeof body.note === 'string' ? body.note.slice(0, 256) : undefined;
  return audited(d, `discovery-${action}`, (ids as string[]).join(' '), () => {
    for (const c of found as Candidate[]) {
      if (action === 'dismiss') c.dismissed = { by: ME, at: iso(now), ...(note ? { note } : {}) };
      else delete c.dismissed;
    }
    restatus(d, now);
    return { result: `${found.length} candidate${found.length === 1 ? '' : 's'}`, response: { candidates: found } };
  });
}

export function putConfig(d: Demo, body: Body, now: number) {
  const c = body as unknown as DiscoveryConfig;
  const errors: string[] = [];
  if (c.version !== 1) errors.push('version: must be 1');
  if (c.mode !== 'organization' && c.mode !== 'account') errors.push('mode: must be "organization" or "account"');
  if (!Array.isArray(c.regions) || !c.regions.length || c.regions.some((r) => r !== '*' && !REGION.test(r))) errors.push('regions: region names (eu-west-1), or ["*"] for every region');
  if (!Number.isInteger(c.refreshHours) || c.refreshHours < 1 || c.refreshHours > 168) errors.push('refreshHours: must be an integer from 1 to 168');
  const names = new Set<string>();
  (Array.isArray(c.filters) ? c.filters : []).forEach((f, i) => {
    const name = typeof f.name === 'string' ? f.name.trim() : '';
    if (!name || name.length > 64) errors.push(`filters[${i}].name: required, at most 64 characters`);
    else if (names.has(name)) errors.push(`filters[${i}]: duplicate filter name "${name}"`);
    names.add(name);
    if (!Array.isArray(f.include) || !f.include.length) errors.push(`filters[${i}].include: at least one criterion`);
    for (const [j, criterion] of [...(f.include ?? []), ...(f.exclude ?? [])].entries()) {
      if (criterion.accountIds?.some((a) => !ACCOUNT.test(a))) errors.push(`filters[${i}] criterion ${j + 1}: accountIds must be 12-digit account IDs`);
    }
  });
  for (const [i, g] of (c.globalExcludes ?? []).entries()) {
    if (g.accountIds?.some((a) => !ACCOUNT.test(a))) errors.push(`globalExcludes[${i}].accountIds: 12-digit account IDs`);
  }
  if (errors.length) fail(400, 'bad_request', 'invalid configuration', { errors });
  const filters = c.filters.length;
  const summary = `${filters} filter${filters === 1 ? '' : 's'}, ${c.globalExcludes.length} global exclude${c.globalExcludes.length === 1 ? '' : 's'}, regions ${c.regions.join(' ')}`;
  return audited(d, 'discovery-config', 'discovery', () => {
    d.config = { config: structuredClone(c), updatedAt: iso(now), updatedBy: ME };
    return { result: summary, response: { config: d.config.config } };
  });
}

// --- Users, preferences, savings settings --------------------------------------------------------------------------------

export function userAction(d: Demo, method: string, email: string | undefined, b: string | undefined, action: string | undefined, body: Body, now: number) {
  if (method === 'GET' && !email) return { users: d.users };
  if (method === 'POST' && !email) {
    const address = String(body.email ?? '').trim().toLowerCase();
    if (!EMAIL.test(address)) fail(400, 'bad_request', 'valid email required');
    const role = String(body.role ?? '');
    if (!ROLES.includes(role)) fail(400, 'bad_request', 'role must be viewer, operator, admin or member');
    const groups = knownGroups(d, body.groups ?? []);
    return audited(d, 'invite', address, () => {
      if (d.users.some((u) => u.email === address)) fail(409, 'conflict', `${address} already has an account`);
      d.users.push({ email: address, role, status: 'FORCE_CHANGE_PASSWORD', enabled: true, createdAt: iso(now), mfa: false, groups });
      return { result: `${role}, sent`, response: { email: address, role, invitation: 'sent' } };
    });
  }
  const address = (email ?? '').toLowerCase();
  const user = d.users.find((u) => u.email === address) ?? fail(404, 'not_found', `unknown user: ${address}`);
  const notSelf = () => { if (address === d.me.email) fail(409, 'conflict', 'you cannot change your own account'); };
  if (method === 'PUT' && b === 'role' && !action) {
    const role = String(body.role ?? '');
    if (!ROLES.includes(role)) fail(400, 'bad_request', 'role must be viewer, operator, admin or member');
    return audited(d, 'role', address, () => { notSelf(); user.role = role; return { result: role, response: { email: address, role } }; });
  }
  if (method === 'PUT' && b === 'groups' && !action) {
    const groups = knownGroups(d, body.groups);
    return audited(d, 'user-groups', address, () => { user.groups = groups; return { result: groups.join(', ') || 'none', response: { email: address, groups } }; });
  }
  if (method === 'POST' && b === 'resend' && !action) return audited(d, 'resend', address, () => ({ result: 'sent', response: { email: address, invitation: 'sent' } }));
  if (method === 'POST' && (b === 'enable' || b === 'disable') && !action) {
    return audited(d, b, address, () => { notSelf(); user.enabled = b === 'enable'; return { result: 'done', response: { email: address, enabled: user.enabled } }; });
  }
  if (method === 'POST' && b === 'mfa' && action === 'reset') {
    return audited(d, 'mfa-reset', address, () => {
      notSelf();
      const deleted = Boolean(user.mfa);
      user.mfa = false;
      return { result: deleted ? 'reset, authenticator deleted' : 'reset, no authenticator deleted', response: { email: address, mfa: false, tokenDeleted: deleted } };
    });
  }
  return fail(404, 'not_found', `no route for ${method} /api/users/${[email, b, action].filter(Boolean).join('/')}`);
}

// --- Tags and groups (R11) -----------------------------------------------------------------------------------------------

function knownGroups(d: Demo, value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((g) => typeof g === 'string')) fail(400, 'bad_request', 'groups: an array of group names');
  const unknown = (value as string[]).find((g) => !d.groups.some((x) => x.name === g));
  if (unknown) fail(400, 'bad_request', `unknown group: ${unknown}`);
  return [...new Set(value as string[])];
}

export function setTags(d: Demo, router: string, id: string, body: Body) {
  const w = workloadOf(d, router, id);
  const problem = tagsProblem(body.tags as Record<string, string>);
  if (problem) fail(400, 'bad_request', problem);
  return audited(d, 'tags', `${router}/${id}`, () => {
    if (w.source === 'terraform') fail(409, 'conflict', `workload ${id} was written by Terraform: set tags in its workload module`);
    w.tags = { ...(body.tags as Record<string, string>) };
    return { result: Object.entries(w.tags).map(([k, v]) => `${k}=${v}`).join(', ') || 'no tags', response: { workloadId: id, tags: w.tags } };
  });
}

export function groupsAction(d: Demo, method: string, name: string | undefined, body: Body, now: number) {
  if (method === 'GET' && !name) return { groups: d.groups };
  const checked = (current: Pick<DemoGroup, 'description' | 'grants'>) => {
    if (body.description !== undefined && (typeof body.description !== 'string' || [...body.description].length > 200)) fail(400, 'bad_request', 'description: at most 200 characters');
    if (body.grants !== undefined) {
      const grants = body.grants as DemoGroup['grants'];
      const problem = Array.isArray(grants) ? grantRowsProblem(grants.map((g) => ({ rows: rowsOf(g.tags), permissions: g.permissions }))) : 'grants: an array';
      if (problem) fail(400, 'bad_request', problem);
    }
    return { description: (body.description as string | undefined)?.trim() ?? current.description, grants: (body.grants as DemoGroup['grants'] | undefined) ?? current.grants };
  };
  if (method === 'POST' && !name) {
    const problem = groupNameProblem(String(body.name ?? ''));
    if (problem) fail(400, 'bad_request', problem);
    if (d.groups.length >= 100) fail(409, 'conflict', 'at most 100 groups');
    return audited(d, 'group-create', String(body.name), () => {
      if (d.groups.some((g) => g.name === body.name)) fail(409, 'conflict', `group ${String(body.name)} already exists`);
      const group = { name: String(body.name), ...checked({ description: '', grants: [] }), updatedAt: iso(now), updatedBy: ME };
      d.groups.push(group);
      return { result: `${group.grants.length} grants`, response: { group } };
    });
  }
  const group = d.groups.find((g) => g.name === name) ?? fail(404, 'not_found', `unknown group: ${name}`);
  if (method === 'PUT') {
    return audited(d, 'group-update', group.name, () => {
      Object.assign(group, checked(group), { updatedAt: iso(now), updatedBy: ME });
      return { result: `${group.grants.length} grants`, response: { group } };
    });
  }
  if (method === 'DELETE') {
    return audited(d, 'group-delete', group.name, () => {
      d.groups = d.groups.filter((g) => g !== group);
      for (const u of d.users) u.groups = (u.groups ?? []).filter((g) => g !== group.name);
      return { result: 'deleted', response: { deleted: group.name } };
    });
  }
  return fail(404, 'not_found', `no route for ${method} /api/groups/${name ?? ''}`);
}

export function putPreferences(d: Demo, body: Body) {
  if (typeof body.dismissedUpdate === 'string') d.preferences = { ...d.preferences, dismissedUpdate: body.dismissedUpdate };
  if (body.refreshSeconds === undefined && body.dismissedUpdate !== undefined) return d.preferences;
  const refresh = body.refreshSeconds;
  if (!Number.isInteger(refresh) || (refresh !== 0 && ((refresh as number) < 5 || (refresh as number) > 600))) fail(400, 'bad_request', 'refreshSeconds must be 0 (off) or an integer from 5 to 600');
  d.preferences = { ...d.preferences, refreshSeconds: refresh as number };
  return d.preferences;
}

// The daily update check: the setting, with the demo's last result (a newer version than the one running).
export function updateCheck(d: Demo, now: number) {
  return { ...d.updateCheck, newer: d.updateCheck.enabled, result: d.updateCheck.enabled ? { checkedAt: new Date(now - 3_600_000).toISOString(), running: '0.11.0', latest: '0.13.0' } : null };
}
export function putUpdateCheck(d: Demo, body: Body, now: number) {
  if (typeof body.enabled !== 'boolean' || typeof body.alert !== 'boolean') fail(400, 'bad_request', 'enabled and alert must be true or false');
  if (body.alert && !body.enabled) fail(400, 'bad_request', 'the alert needs the daily check turned on');
  d.updateCheck = { enabled: body.enabled as boolean, alert: body.alert as boolean, updatedAt: new Date(now).toISOString(), updatedBy: ME };
  return updateCheck(d, now);
}

export function putSavingsSettings(d: Demo, body: Body, now: number) {
  const percent = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 90;
  if (!percent(body.compute) || !percent(body.databases)) fail(400, 'bad_request', 'compute and databases must be whole percentages from 0 to 90');
  return audited(d, 'savings-discounts', 'savings', () => {
    d.savings = { compute: body.compute as number, databases: body.databases as number, updatedAt: iso(now), updatedBy: ME };
    return { result: `compute ${d.savings.compute}%, databases ${d.savings.databases}%`, response: { settings: d.savings } };
  });
}

// --- Hibernation (router 0.32.0) -----------------------------------------------------------------------------------------

const hibernateIn = (body: Body, nullable: boolean): boolean | null => {
  const v = body.hibernate;
  if (typeof v === 'boolean' || (nullable && v === null)) return v;
  return fail(400, 'bad_request', nullable ? 'hibernate must be true, false or null' : 'hibernate must be true or false');
};

// The manager's default for every workload (administrators; the routers read it at their next check).
export function putWorkloadDefaults(d: Demo, body: Body, now: number) {
  const hibernate = hibernateIn(body, false) as boolean;
  return audited(d, 'settings', 'workloads', () => {
    d.hibernation = { hibernate, updatedAt: iso(now), updatedBy: ME };
    return { result: `hibernate ${hibernate ? 'on' : 'off'}`, response: { ...d.hibernation, note: 'routers apply it at their next check, within 5 minutes' } };
  });
}

export function setRouterSettings(d: Demo, router: DemoRouter, body: Body, now: number) {
  const hibernate = hibernateIn(body, true);
  return audited(d, 'router-settings', router.name, () => {
    if (!hasHibernation(router)) fail(409, 'conflict', 'upgrade the router to 0.32.0');
    router.hibernate = hibernate;
    router.hibernateBy = hibernate === null ? null : ME;
    router.hibernateAt = hibernate === null ? null : now;
    return { result: `hibernate ${hibernate === null ? 'inherit' : hibernate ? 'on' : 'off'}`, response: { level: 'router', settings: { hibernate, by: router.hibernateBy, at: router.hibernateAt === null ? null : iso(router.hibernateAt) } } };
  });
}

export function setWorkloadSettings(d: Demo, router: string, id: string, body: Body, now: number) {
  const w = workloadOf(d, router, id);
  const hibernate = hibernateIn(body, true);
  return audited(d, 'workload-settings', `${router}/${id}`, () => {
    if (!hasHibernation(d.routers.find((r) => r.name === router)!)) fail(409, 'conflict', 'upgrade the router to 0.32.0');
    if (w.source === 'terraform') fail(409, 'conflict', `workload ${id} was written by Terraform: set hibernate in its workload module`);
    w.hibernate = hibernate;
    return { result: `hibernate ${hibernate === null ? 'inherit' : hibernate ? 'on' : 'off'}`, response: { level: 'workload', settings: { hibernate }, hibernation: hibernationOf(d, w, now) } };
  });
}
