// Onboarding and offboarding a Google Cloud standalone candidate (plan 5, M51): the target is its resource (its path), the claim
// `RES#<path>`, no URL map to lock, the router's preview and onboarding with `resource` in place of the URL map and the backend
// service (the router's handover), the tag `dormeto/managed` bound to the resource (a VM's or a group's by the numeric id the scan
// read) and to its companions, the verification the router's status AWAKE with its resource among its backends, the candidate
// managed. Only what the last scan listed as eligible (the safety net: the router cannot see a backend service). Offboarding wakes
// it first, unless its resource is missing; the tag removed from what the status names.
import { describe, expect, it } from 'vitest';
import type { DiscoveryStore, StandaloneCandidate } from '@dormeto/discovery';
import type { TagTarget } from '@dormeto/google';
import { createEngine, type RouterRef } from '../src/engine.js';
import { createRecords } from '../src/records.js';
import { fakeDynamo } from './dynamo-fake.js';

const T0 = Date.UTC(2026, 10, 21, 12, 0);
const PROJECT = 'dormeto-dev';
const NUMBER = '1034397096264';
const REGION = 'europe-west2';
const ZONE = 'europe-west2-b';
const VM = `projects/${PROJECT}/zones/${ZONE}/instances/build-agent`;
const MIG = `projects/${PROJECT}/zones/${ZONE}/instanceGroupManagers/workers`;
const SQL = `projects/${PROJECT}/instances/orders`;
const ROUTER: RouterRef = { name: 'dmtr-europe-west2', account: PROJECT, region: REGION, controller: 'https://c', source: 'manager', version: '0.42.0', cloud: 'gcp' };
const ROUTER_NAME = `dmtr-${PROJECT}-${REGION}`;
const TAG_VALUE = 'tagValues/281475162387331';
const COMPUTE = `//compute.googleapis.com/projects/${NUMBER}`;

const candidate = (id: string, backend: StandaloneCandidate['backend'], over: Partial<StandaloneCandidate> = {}): StandaloneCandidate => ({
  kind: 'standalone', id, resource: id, cloud: 'gcp', account: PROJECT, region: 'europe-west2', name: backend.id, backend, tags: {}, eligibility: 'eligible', idleHours7d: 150,
  accountName: PROJECT, ouPath: [], scope: 'in', scopeReason: 'in scope', status: 'pending-onboarding', statusReason: 'eligible', firstSeenAt: 'x', lastSeenAt: 'x', history: [], ...over,
});
const CANDIDATES = [
  candidate(VM, { kind: 'instance', id: 'build-agent', location: ZONE, resourceId: '4471' }),
  candidate(MIG, { kind: 'asg', id: 'workers', location: ZONE, resourceId: '5582' }),
  candidate(SQL, { kind: 'cloudsql-instance', id: 'orders' }),
];
const INPUT = (resource: string) => ({ candidateId: resource, router: ROUTER_NAME, region: REGION, projectNumber: NUMBER, name: 'Agent', settings: { idleCpuPercent: 3 }, databases: [{ kind: 'cloudsql-instance', id: 'side' }] });

function setup({ candidates = CANDIDATES } = {}) {
  let now = T0;
  let ids = 0;
  const records = createRecords({ dynamo: fakeDynamo(), table: 't', now: () => now });
  const items = new Map<string, StandaloneCandidate>(candidates.map((c) => [c.id, c]));
  const discovery = {
    getCandidate: async (id: string) => items.get(id) ?? null,
    replaceCandidates: async (after: StandaloneCandidate[]) => { for (const c of after) items.set(c.id, c); },
  } as unknown as DiscoveryStore;
  // The router's actions for a standalone workload (router gcp/src/actions.mjs, the Plan 5 router handover).
  const router = { kind: 'standalone' as string | undefined, state: 'AWAKE', resourceMissing: false, backends: null as unknown[] | null, statusPolls: 0, listedAfter: 0, resource: VM };
  const invocations: Record<string, unknown>[] = [];
  const entryOf = (resource: string) => (resource.includes('/instances/') && resource.includes('/zones/') ? { kind: 'instance', id: resource.split('/').at(-1), status: 'running', location: ZONE, resourceId: '4471' }
    : resource.includes('instanceGroupManagers') ? { kind: 'asg', id: resource.split('/').at(-1), status: 'running', location: ZONE, resourceId: '5582' } : { kind: 'cloudsql-instance', id: resource.split('/').at(-1), status: 'running' });
  const answers: Record<string, (p: Record<string, unknown>) => unknown> = {
    preview: (p) => ({
      workloadId: 'w1', ...(router.kind ? { kind: router.kind } : {}), name: p.name ?? 'w1', tags: {}, resource: p.resource, eligible: true, reasons: [],
      backend: { kind: 'instance', id: 'build-agent', tagged: null, location: ZONE }, databases: [{ kind: 'cloudsql-instance', id: 'side', tagged: null, name: 'side' }], ok: true, problems: [],
    }),
    onboard: (p) => {
      router.resource = String(p.resource);
      return { steps: [{ name: 'workload configuration', status: 'done' }], workload: { workloadId: 'w1' } };
    },
    status: () => {
      router.statusPolls += 1;
      const backends = router.backends ?? (router.statusPolls > router.listedAfter ? [entryOf(router.resource), { kind: 'cloudsql-instance', id: 'side', status: 'running', companion: true }] : []);
      return { workloadId: 'w1', name: 'Agent', kind: 'standalone', resource: router.resource, state: router.state, backends, ...(router.resourceMissing ? { resourceMissing: true } : {}), settings: { wakeTimeoutSeconds: 600 } };
    },
    pause: () => ({ pause: {}, woken: [] }),
    offboard: () => ({ steps: [{ name: 'wake', status: 'skipped' }, { name: 'restore autoscalers', status: 'skipped' }, { name: 'workload configuration', status: 'done' }] }),
    report: () => ({}),
  };
  const bindings = new Set<string>();
  const tagCalls: string[] = [];
  const tags = {
    tagValueOf: async (project: string) => { tagCalls.push(`value ${project}`); return TAG_VALUE; },
    sqlRegionOf: async (project: string, name: string) => { tagCalls.push(`region ${project} ${name}`); return 'europe-west1'; },
    bindTag: async (target: TagTarget) => { tagCalls.push(`bind ${target.parent}`); bindings.add(target.parent); return true; },
    unbindTag: async (target: TagTarget) => { tagCalls.push(`unbind ${target.parent}`); return bindings.delete(target.parent) ? 1 : 0; },
  };
  const engine = createEngine({
    records, discovery, routers: async () => [ROUTER],
    target: async () => { throw new Error('no AWS account here'); },
    bundle: async () => { throw new Error('no router bundle here'); },
    google: {
      invoke: async (_r, payload) => {
        invocations.push(payload);
        return answers[payload.action as string]!(payload);
      },
      tags,
    },
    settings: { env: 'dev', routerVersion: '0.42.0', principals: [], routerSettings: {} as never },
    start: async (op) => `arn:execution:${op.id}`,
    now: () => now, newId: () => `op${++ids}`, log: { info() {}, warn() {}, error() {} },
  });
  async function drive(id: string) {
    for (let i = 0; i < 200; i += 1) {
      const r = await engine.next(id);
      if (r.done) return r;
      now += (r.waitSeconds ?? 0) * 1000;
    }
    throw new Error('the operation never finished');
  }
  return { engine, records, items, router, invocations, tagCalls, bindings, drive };
}

describe('onboarding a Google Cloud standalone candidate', () => {
  it('targets its resource, locks no URL map, sends the router its resource, tags it by its numeric id and its companion, verifies it AWAKE, and marks the candidate managed', async () => {
    const s = setup();
    const op = await s.engine.create('onboard', INPUT(VM), 'ops@example.com');
    expect([op.target, op.activeKey]).toEqual([{ account: PROJECT, region: REGION, router: ROUTER_NAME, resource: VM, projectNumber: NUMBER }, `RES#${VM}`]);
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    const stored = (await s.records.getOperation(op.id))!;
    expect(stored.steps.map((x) => [x.name, x.status, x.detail])).toEqual([
      ['find router', 'done', 'router dmtr-europe-west2 0.42.0'], ['slot', 'done', undefined], ['lock load balancer', 'skipped', 'a standalone workload: no load balancer to lock'],
      ['preview', 'done', 'Agent (w1)'], ['tag', 'done', `tagged VM ${ZONE}/build-agent, Cloud SQL instance side`], ['onboard', 'done', 'workload configuration'],
      ['verify', 'done', 'Agent AWAKE, instance build-agent running, Cloud SQL instance side running; in the manager now'], ['candidate', 'done', undefined],
    ]);
    expect(s.invocations.filter((p) => p.action === 'preview' || p.action === 'onboard')).toEqual([
      { action: 'preview', name: 'Agent', resource: VM, settings: { idleCpuPercent: 3 }, databases: [{ kind: 'cloudsql-instance', id: 'side' }] },
      { action: 'onboard', workloadId: 'w1', name: 'Agent', resource: VM, settings: { idleCpuPercent: 3 }, databases: [{ kind: 'cloudsql-instance', id: 'side' }], by: 'ops@example.com' },
    ]);
    expect(s.tagCalls).toEqual([`value ${PROJECT}`, `region ${PROJECT} side`, `bind ${COMPUTE}/zones/${ZONE}/instances/4471`, `bind //sqladmin.googleapis.com/projects/${PROJECT}/instances/side`]);
    expect(s.items.get(VM)).toMatchObject({ eligibility: 'managed', workloadId: 'w1', status: 'managed' });
  });

  it('tags a group by its numeric id, a Cloud SQL resource by its name and region', async () => {
    const mig = setup();
    await mig.drive((await mig.engine.create('onboard', INPUT(MIG), 'ops')).id);
    expect(mig.tagCalls.filter((c) => c.startsWith('bind'))).toEqual([`bind ${COMPUTE}/zones/${ZONE}/instanceGroupManagers/5582`, `bind //sqladmin.googleapis.com/projects/${PROJECT}/instances/side`]);
    const sql = setup();
    await sql.drive((await sql.engine.create('onboard', INPUT(SQL), 'ops')).id);
    expect(sql.tagCalls.filter((c) => c.startsWith('bind') || c.startsWith('region'))).toEqual([
      `region ${PROJECT} orders`, `region ${PROJECT} side`, `bind //sqladmin.googleapis.com/projects/${PROJECT}/instances/orders`, `bind //sqladmin.googleapis.com/projects/${PROJECT}/instances/side`,
    ]);
  });

  it('waits for its resource among the backends, 15 s a poll, up to 3 minutes', async () => {
    const s = setup();
    s.router.listedAfter = 3;
    expect(await s.drive((await s.engine.create('onboard', INPUT(VM), 'ops')).id)).toEqual({ done: true, status: 'succeeded' });
    const t = setup();
    t.router.backends = [];
    const op = await t.engine.create('onboard', INPUT(VM), 'ops');
    expect(await t.drive(op.id)).toEqual({ done: true, status: 'failed' });
    expect((await t.records.getOperation(op.id))!.error).toBe(`verify: Agent is onboarded, but its status has no backend for ${VM} after 3 minutes: see it in Workloads, and offboard it there if it should not stay`);
  });

  it('refuses what the last scan did not list as eligible, in plain words, before any call', async () => {
    const s = setup({ candidates: [candidate(VM, { kind: 'instance', id: 'build-agent', location: ZONE, resourceId: '1' }, { eligibility: 'ineligible', reason: 'VM build-agent backs backend service web: it belongs to an HTTP workload' })] });
    await expect(s.engine.create('onboard', INPUT(VM), 'ops')).rejects.toThrow(`cannot onboard ${VM}: VM build-agent backs backend service web: it belongs to an HTTP workload`);
    await expect(s.engine.create('onboard', INPUT(MIG), 'ops')).rejects.toThrow(`${MIG} is not a standalone candidate of the last discovery run: turn on Standalone resources in the discovery perimeter, run discovery, then onboard it from its candidate (the scan checks what the router cannot: that no backend service uses it)`);
    expect(s.invocations).toEqual([]);
  });

  it('refuses a candidate no longer pending in scope (final review I3): out of scope, excluded, dismissed, gone, before any call', async () => {
    const backend = { kind: 'instance' as const, id: 'build-agent', location: ZONE, resourceId: '1' };
    for (const [status, words] of [
      ['out-of-scope', 'it is out of scope (standalone scan off): bring it into the discovery perimeter with Standalone resources on, run discovery, then onboard it'],
      ['excluded', 'it is excluded (standalone scan off): lift the exclusion, run discovery, then onboard it'],
      ['dismissed', 'it is dismissed: restore it, then onboard it'],
      ['gone', 'the last discovery run did not find it'],
    ] as const) {
      const s = setup({ candidates: [candidate(VM, backend, { status, statusReason: 'standalone scan off' })] });
      await expect(s.engine.create('onboard', INPUT(VM), 'ops'), status).rejects.toThrow(`cannot onboard ${VM}: ${words}`);
      expect(s.invocations).toEqual([]);
    }
  });

  it('fails the preview on a router that does not know standalone workloads, with its upgrade', async () => {
    const s = setup();
    s.router.kind = undefined;
    const op = await s.engine.create('onboard', INPUT(VM), 'ops');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'failed' });
    expect((await s.records.getOperation(op.id))!.error).toBe(`preview: router dmtr-europe-west2 is older than 0.42.0: upgrade it to onboard a standalone resource (dormeto gcp routers install --project ${PROJECT} --region ${REGION})`);
    expect(s.invocations.some((p) => p.action === 'onboard')).toBe(false);
  });
});

describe('offboarding a Google Cloud standalone workload', () => {
  const offboard = { router: ROUTER_NAME, account: PROJECT, region: REGION, workloadId: 'w1', projectNumber: NUMBER };
  const managed = () => [candidate(VM, { kind: 'instance', id: 'build-agent', location: ZONE, resourceId: '4471' }, { eligibility: 'managed', workloadId: 'w1', status: 'managed' })];

  it('wakes it, offboards it, removes the tag from its resource and companion, and gives its candidate back', async () => {
    const s = setup({ candidates: managed() });
    for (const parent of [`${COMPUTE}/zones/${ZONE}/instances/4471`, `//sqladmin.googleapis.com/projects/${PROJECT}/instances/side`]) s.bindings.add(parent);
    const op = await s.engine.create('offboard', offboard, 'ops');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    expect((await s.records.getOperation(op.id))!.steps.map((x) => [x.name, x.status])).toEqual([
      ['locate', 'done'], ['slot', 'done'], ['lock load balancer', 'skipped'], ['pause', 'done'], ['wait awake', 'done'], ['offboard', 'done'], ['untag', 'done'], ['candidate', 'done'],
    ]);
    expect(s.tagCalls).toEqual([`region ${PROJECT} side`, `value ${PROJECT}`, `unbind ${COMPUTE}/zones/${ZONE}/instances/4471`, `unbind //sqladmin.googleapis.com/projects/${PROJECT}/instances/side`]);
    expect(s.items.get(VM)).toMatchObject({ eligibility: 'eligible', status: 'pending-onboarding' });
  });

  it('offboards one whose resource is missing without waking it, whatever its state', async () => {
    const s = setup({ candidates: managed() });
    Object.assign(s.router, { state: 'ASLEEP', resourceMissing: true, backends: [] });
    const op = await s.engine.create('offboard', offboard, 'ops');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    expect((await s.records.getOperation(op.id))!.steps.map((x) => [x.name, x.status, x.detail]).slice(0, 5)).toEqual([
      ['locate', 'done', 'Agent ASLEEP, its resource missing'], ['slot', 'done', undefined], ['lock load balancer', 'skipped', 'a standalone workload: no load balancer to lock'],
      ['pause', 'skipped', 'its resource is missing: nothing to wake'], ['wait awake', 'skipped', 'its resource is missing: nothing to wake'],
    ]);
    expect(s.invocations.map((p) => p.action)).toEqual(['status', 'offboard']);
  });
});

// Every Google Cloud call of these operations as the command account is the router's gcp/access.json's: its role dormetoCommand on
// the project, and roles/resourcemanager.tagUser on the tag value (what reads the value and lets the binding use it). Skipped
// without the router's checkout beside the manager.
const ACCESS = new URL('../../../../router/gcp/access.json', import.meta.url);
const { existsSync, readFileSync } = await import('node:fs');
describe.skipIf(!existsSync(ACCESS))('the command account\'s calls for a standalone workload', () => {
  it('are each allowed to dormetoCommand or the tag value\'s tagUser', async () => {
    const access = JSON.parse(readFileSync(ACCESS, 'utf8')) as { manager: { roles: { dormetoCommand: { permissions: string[] } }; grants: { routerProjects: { account: string; role: string; on: string }[] } } };
    const granted = new Set(access.manager.roles.dormetoCommand.permissions);
    const calls: string[] = [];
    for (const resource of [VM, MIG, SQL]) {
      const s = setup();
      await s.drive((await s.engine.create('onboard', INPUT(resource), 'ops')).id);
      calls.push(...s.tagCalls);
    }
    const off = setup({ candidates: [candidate(VM, { kind: 'instance', id: 'build-agent', location: ZONE, resourceId: '4471' }, { eligibility: 'managed', workloadId: 'w1', status: 'managed' })] });
    off.bindings.add(`${COMPUTE}/zones/${ZONE}/instances/4471`);
    await off.drive((await off.engine.create('offboard', { router: ROUTER_NAME, account: PROJECT, region: REGION, workloadId: 'w1', projectNumber: NUMBER }, 'ops')).id);
    calls.push(...off.tagCalls);
    const kindOf = (parent: string) => (parent.includes('/instanceGroupManagers/') ? 'compute.instanceGroupManagers' : parent.startsWith('//sqladmin') ? 'cloudsql.instances' : 'compute.instances');
    const needed = new Set<string>();
    for (const call of calls) {
      const [verb, target] = call.split(' ');
      if (verb === 'bind') needed.add(`${kindOf(target!)}.listTagBindings`).add(`${kindOf(target!)}.createTagBinding`);
      else if (verb === 'unbind') needed.add(`${kindOf(target!)}.listTagBindings`).add(`${kindOf(target!)}.deleteTagBinding`);
      else if (verb === 'region') needed.add('cloudsql.instances.get');
      else if (verb === 'value') expect(access.manager.grants.routerProjects).toContainEqual({ account: 'command', role: 'roles/resourcemanager.tagUser', on: 'tagValue' });
      else throw new Error(`a call the table does not know: ${call}`);
    }
    expect([...needed].filter((p) => !granted.has(p))).toEqual([]);
    expect(needed.size).toBeGreaterThan(6);
  });
});
