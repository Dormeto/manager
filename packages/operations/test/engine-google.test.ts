// A Google Cloud candidate onboarded by the operations engine (Google Cloud manager design §8): the router of its project
// found again, the slot of the project and the router's region, the URL map locked, the router's preview, the tag
// `dormeto/managed` bound as the command account to what the preview names, the router's onboarding, its status, the
// candidate managed. A refusal of the onboarding removes the bindings the operation made; a lost answer keeps them.
import { describe, expect, it } from 'vitest';
import type { Candidate, DiscoveryStore } from '@dormeto/discovery';
import type { TagTarget } from '@dormeto/google';
import { createEngine, type RouterRef } from '../src/engine.js';
import { createRecords } from '../src/records.js';
import { fakeDynamo } from './dynamo-fake.js';

const T0 = Date.UTC(2026, 10, 9, 12, 0);
const PROJECT = 'dormeto-dev';
const NUMBER = '1034397096264';
const REGION = 'europe-west2';
const SERVICE = `projects/${PROJECT}/global/backendServices/dmt-demo-app`;
const MAP = `projects/${PROJECT}/global/urlMaps/dmt-dev`;
const CONTROLLER = 'https://dmtr-europe-west2-controller-abc123-nw.a.run.app';
const ROUTER: RouterRef = { name: 'dmtr-europe-west2', account: PROJECT, region: REGION, controller: CONTROLLER, source: 'manager', version: '0.40.0', cloud: 'gcp' };
// The router's name as the API lists it, and the operation's input as the API gives it.
const ROUTER_NAME = `dmtr-${PROJECT}-${REGION}`;
const INPUT = {
  candidateId: SERVICE, router: ROUTER_NAME, region: REGION, projectNumber: NUMBER, name: 'Demo', settings: { idleMinutes: 30, fallbackInstanceTypes: ['e2-medium'] },
  databases: [{ kind: 'cloudsql-instance', id: 'db-1' }], tags: { team: 'web' },
};
const WORKLOAD_ID = 'dmt-demo-app';
const TAG_VALUE = 'tagValues/281475162387331';

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  id: SERVICE, account: PROJECT, region: 'global', loadBalancer: 'dmt-dev', loadBalancerArn: '', listener: '', priority: '', conditions: 'hosts demo.gcp.dev.dormeto.com',
  hosts: ['demo.gcp.dev.dormeto.com'], targetGroup: 'dmt-demo-app', targetGroupArn: null, backend: { kind: 'instance', id: 'vm-1' }, tags: {}, rules: [],
  eligibility: 'eligible', idleHours7d: 150, requests7d: 3, backendService: SERVICE, urlMap: MAP, lb: { kind: 'global' },
  accountName: PROJECT, ouPath: [], scope: 'in', scopeReason: 'in scope', status: 'pending-onboarding', statusReason: 'eligible', firstSeenAt: 'x', lastSeenAt: 'x', history: [], ...over,
});

// What the tag step binds for the preview below: a VM, a zonal and a regional managed instance group, a Cloud SQL instance.
const COMPUTE = `//compute.googleapis.com/projects/${NUMBER}`;
const VM: TagTarget = { label: 'VM europe-west2-b/vm-1', location: 'europe-west2-b', parent: `${COMPUTE}/zones/europe-west2-b/instances/4471` };
const ZONAL: TagTarget = { label: 'managed instance group europe-west2-b/mig-z', location: 'europe-west2-b', parent: `${COMPUTE}/zones/europe-west2-b/instanceGroupManagers/5582` };
const REGIONAL: TagTarget = { label: 'managed instance group europe-west2/mig-r', location: 'europe-west2', parent: `${COMPUTE}/regions/europe-west2/instanceGroupManagers/6693` };
const SQL: TagTarget = { label: 'Cloud SQL instance db-1', location: 'europe-west1', parent: `//sqladmin.googleapis.com/projects/${PROJECT}/instances/db-1` };

// bound: the parents tagged already; failBind and failUnbind: the parents whose binding or removal fails.
function setup({ routers = [ROUTER], bound = [] as string[], failBind = [] as string[], failUnbind = [] as string[] } = {}) {
  let now = T0;
  let ids = 0;
  const records = createRecords({ dynamo: fakeDynamo(), table: 't', now: () => now });
  const items = new Map([[SERVICE, candidate()]]);
  const discovery = {
    getCandidate: async (id: string) => items.get(id) ?? null,
    replaceCandidates: async (after: Candidate[]) => { for (const c of after) items.set(c.id, c); },
  } as unknown as DiscoveryStore;
  // The router's actions, in its AWS shapes (router gcp/src/actions.mjs): preview, onboard and status.
  const invocations: [string, Record<string, unknown>, number][] = [];
  const answers: Record<string, (p: Record<string, unknown>) => unknown> = {
    preview: (p) => ({
      workloadId: WORKLOAD_ID, name: p.name ?? WORKLOAD_ID, tags: p.tags ?? {}, urlMap: p.urlMap, backendService: p.backendService, wakerBackendService: `dmtr-${WORKLOAD_ID}-waker`,
      eligible: true, reasons: [], lb: { kind: 'global' },
      vms: [{ zone: 'europe-west2-b', name: 'vm-1', selfLink: 'x', id: '4471' }],
      groups: [{ kind: 'zonal', location: 'europe-west2-b', name: 'mig-z', selfLink: 'x', id: '5582' }, { kind: 'regional', location: 'europe-west2', name: 'mig-r', selfLink: 'x', id: '6693' }],
      backends: [], databases: [{ kind: 'cloudsql-instance', id: 'db-1', tagged: null, name: 'db-1' }], ok: true, problems: [],
    }),
    onboard: (p) => ({ steps: [{ name: 'waker backend service', status: 'done' }, { name: 'url map', status: 'done' }], workload: { workloadId: p.workloadId } }),
    status: () => ({ workloadId: WORKLOAD_ID, name: 'Demo', backendService: 'dmt-demo-app', state: 'AWAKE', issues: [] }),
  };
  // The tag bindings, by parent; every call, in order.
  const bindings = new Set(bound);
  const tagCalls: string[] = [];
  const tags = {
    tagValueOf: async (project: string) => { tagCalls.push(`value ${project}`); return TAG_VALUE; },
    sqlRegionOf: async (project: string, name: string) => { tagCalls.push(`region ${project} ${name}`); return 'europe-west1'; },
    bindTag: async (target: TagTarget, value: string) => {
      tagCalls.push(`bind ${target.parent} ${value}`);
      if (failBind.includes(target.parent)) throw new Error('Google: 403 IAM_PERMISSION_DENIED: Permission denied');
      if (bindings.has(target.parent)) return false;
      bindings.add(target.parent);
      return true;
    },
    unbindTag: async (target: TagTarget, value: string) => {
      tagCalls.push(`unbind ${target.parent} ${value}`);
      if (failUnbind.includes(target.parent)) throw new Error('Google: 503 UNAVAILABLE: try again');
      return bindings.delete(target.parent) ? 1 : 0;
    },
  };
  const engine = createEngine({
    records, discovery, routers: async () => routers,
    target: async () => { throw new Error('no AWS account in a Google Cloud onboarding'); },
    bundle: async () => { throw new Error('no router bundle in a Google Cloud onboarding'); },
    google: {
      invoke: async (router, payload, { timeoutMs }) => {
        invocations.push([router.name, payload, timeoutMs]);
        return answers[payload.action as string]!(payload);
      },
      tags,
    },
    settings: { env: 'dev', routerVersion: '0.40.0', principals: [], routerSettings: { checkSchedule: '', ipLists: '', ipListsCatalog: '', ipListsBucket: '', noWakeRules: '', metrics: '', managerBus: '', commandRole: '' } },
    start: async (op) => `arn:execution:${op.id}`,
    now: () => now, newId: () => `op${++ids}`, log: { info() {}, warn() {}, error() {} },
  });
  async function drive(id: string) {
    for (let i = 0; i < 100; i += 1) {
      const r = await engine.next(id);
      if (r.done) return r;
      now += (r.waitSeconds ?? 0) * 1000;
    }
    throw new Error('the operation never finished');
  }
  return { engine, records, items, invocations, answers, bindings, tagCalls, drive };
}

const actionsOf = (s: ReturnType<typeof setup>) => s.invocations.map(([router, p, timeoutMs]) => [router, p.action, timeoutMs]);

describe('onboarding a Google Cloud candidate', () => {
  it('runs the Google Cloud steps in order on its target, holding the slot of the project and region and the URL map\'s lock, and the candidate is managed', async () => {
    const s = setup();
    const op = await s.engine.create('onboard', INPUT, 'ops@example.com');
    expect(op.target).toEqual({ account: PROJECT, region: REGION, router: ROUTER_NAME, backendService: SERVICE, urlMap: MAP, projectNumber: NUMBER });
    expect(op.activeKey).toBe(`TG#${SERVICE}`);
    expect(op.steps.map((x) => x.name)).toEqual(['find router', 'slot', 'lock load balancer', 'preview', 'tag', 'onboard', 'verify', 'candidate']);
    // Held from the lock on: the slot of the project and the router's region, the URL map's lock.
    for (let i = 0; i < 3; i += 1) await s.engine.next(op.id);
    expect((await s.records.getOperation(op.id))!.holds).toEqual({ locks: [`LB#${MAP}`], slots: ['ORG', `${PROJECT}#${REGION}`] });
    expect(await s.records.slotHolders(`${PROJECT}#${REGION}`)).toEqual([op.id]);

    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    const stored = (await s.records.getOperation(op.id))!;
    expect(stored.steps.map((x) => [x.name, x.status, x.detail])).toEqual([
      ['find router', 'done', 'router dmtr-europe-west2 0.40.0'],
      ['slot', 'done', undefined],
      ['lock load balancer', 'done', undefined],
      ['preview', 'done', `Demo (${WORKLOAD_ID})`],
      ['tag', 'done', `tagged ${[VM, ZONAL, REGIONAL, SQL].map((t) => t.label).join(', ')}`],
      ['onboard', 'done', 'waker backend service, url map'],
      ['verify', 'done', 'Demo AWAKE, backend service dmt-demo-app'],
      ['candidate', 'done', undefined],
    ]);
    // The onboarder's three within 300 s, the others within 10 s; no AWS account assumed.
    expect(actionsOf(s)).toEqual([[ROUTER.name, 'preview', 300_000], [ROUTER.name, 'onboard', 300_000], [ROUTER.name, 'status', 10_000]]);
    expect(s.items.get(SERVICE)).toMatchObject({ eligibility: 'managed', workloadId: WORKLOAD_ID, status: 'managed' });
    // Everything released.
    expect(await s.records.acquireLock(`LB#${MAP}`, 'other', 60_000)).toBe(true);
    expect(await s.records.slotHolders(`${PROJECT}#${REGION}`)).toEqual([]);
    expect(await s.records.claimActive(`TG#${SERVICE}`, 'other', 60_000)).toEqual({ ok: true });
  });

  it('sends AWS\'s preview and onboarder payloads with the URL map\'s and backend service\'s names and the load balancer\'s kind', async () => {
    const s = setup();
    const op = await s.engine.create('onboard', INPUT, 'ops@example.com');
    await s.drive(op.id);
    const [preview, onboard, status] = s.invocations.map(([, p]) => p);
    expect(Object.keys(preview!).sort()).toEqual(['action', 'backendService', 'databases', 'loadBalancer', 'name', 'settings', 'tags', 'urlMap']);
    expect(preview).toEqual({
      action: 'preview', urlMap: 'dmt-dev', backendService: 'dmt-demo-app', loadBalancer: 'global', name: 'Demo', settings: { idleMinutes: 30, fallbackInstanceTypes: ['e2-medium'] },
      databases: [{ kind: 'cloudsql-instance', id: 'db-1' }], tags: { team: 'web' },
    });
    expect(Object.keys(onboard!).sort()).toEqual(['action', 'backendService', 'by', 'databases', 'loadBalancer', 'name', 'settings', 'tags', 'urlMap', 'workloadId']);
    expect(onboard).toEqual({ ...preview, action: 'onboard', workloadId: WORKLOAD_ID, by: 'ops@example.com' });
    expect(status).toEqual({ action: 'status', workloadId: WORKLOAD_ID });
  });

  it('leaves the load balancer\'s kind to the router when discovery could not tell it, and sends no name or tags it was not given', async () => {
    const s = setup();
    s.items.set(SERVICE, candidate({ lb: undefined } as Partial<Candidate>));
    const op = await s.engine.create('onboard', { candidateId: SERVICE, router: ROUTER_NAME, region: REGION, projectNumber: NUMBER, settings: {}, databases: [] }, 'ops@example.com');
    await s.drive(op.id);
    expect(s.invocations[0]![1]).toEqual({ action: 'preview', urlMap: 'dmt-dev', backendService: 'dmt-demo-app', settings: {}, databases: [] });
    expect(s.invocations[1]![1]).toEqual({ action: 'onboard', workloadId: WORKLOAD_ID, urlMap: 'dmt-dev', backendService: 'dmt-demo-app', name: WORKLOAD_ID, settings: {}, databases: [], by: 'ops@example.com' });
  });

  it('binds the tag to the VM, the zonal and the regional group the preview names and the Cloud SQL instance given, in their locations, as made by this operation', async () => {
    const s = setup();
    const op = await s.engine.create('onboard', INPUT, 'ops@example.com');
    await s.drive(op.id);
    expect(s.tagCalls).toEqual([
      `value ${PROJECT}`, `region ${PROJECT} db-1`,
      ...[VM, ZONAL, REGIONAL, SQL].map((t) => `bind ${t.parent} ${TAG_VALUE}`),
    ]);
    expect((await s.records.getOperation(op.id))!.context.tagged).toEqual([VM, ZONAL, REGIONAL, SQL]);
    expect([...s.bindings]).toEqual([VM, ZONAL, REGIONAL, SQL].map((t) => t.parent));
  });

  it('a VM tagged already is not this operation\'s binding: left out of tagged, and said', async () => {
    const s = setup({ bound: [VM.parent] });
    const op = await s.engine.create('onboard', INPUT, 'ops@example.com');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    const stored = (await s.records.getOperation(op.id))!;
    expect(stored.context.tagged).toEqual([ZONAL, REGIONAL, SQL]);
    expect(stored.steps.find((x) => x.name === 'tag')!.detail).toBe(`tagged ${[ZONAL, REGIONAL, SQL].map((t) => t.label).join(', ')}; already tagged ${VM.label}`);
  });

  it('a refused onboarding removes the bindings this operation made, keeps the one there before, and fails with the refusal', async () => {
    const s = setup({ bound: [VM.parent] });
    s.answers.onboard = () => { throw Object.assign(new Error('backend service dmt-demo-app is already workload other'), { code: 'conflict' }); };
    const op = await s.engine.create('onboard', INPUT, 'ops@example.com');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'failed' });
    expect(s.tagCalls.filter((c) => c.startsWith('unbind'))).toEqual([ZONAL, REGIONAL, SQL].map((t) => `unbind ${t.parent} ${TAG_VALUE}`));
    expect([...s.bindings]).toEqual([VM.parent]);
    const stored = (await s.records.getOperation(op.id))!;
    const removed = `the tag bindings it made are removed: ${[ZONAL, REGIONAL, SQL].map((t) => t.label).join(', ')}`;
    expect(stored.error).toBe(`onboard: backend service dmt-demo-app is already workload other; ${removed}`);
    expect(stored.steps.find((x) => x.name === 'onboard')).toMatchObject({ status: 'failed', detail: `backend service dmt-demo-app is already workload other; ${removed}` });
    expect(stored.context.tagged).toEqual([]);
    expect(actionsOf(s).map(([, action]) => action)).toEqual(['preview', 'onboard']);
    expect(s.items.get(SERVICE)).toMatchObject({ eligibility: 'eligible' });
    expect(await s.records.claimActive(`TG#${SERVICE}`, 'other', 60_000)).toEqual({ ok: true });
  });

  it('a refusal of the manager\'s own (no router acted) removes the bindings too, naming one it could not remove', async () => {
    const s = setup({ failUnbind: [REGIONAL.parent] });
    s.answers.onboard = () => { throw Object.assign(new Error('the manager\'s accounts can\'t reach the router: dormeto gcp connect --project dormeto-host --profile <profile> --env dev'), { code: 'manager-access-missing' }); };
    const op = await s.engine.create('onboard', INPUT, 'ops@example.com');
    await s.drive(op.id);
    const stored = (await s.records.getOperation(op.id))!;
    expect(stored.error).toBe(`onboard: the manager's accounts can't reach the router: dormeto gcp connect --project dormeto-host --profile <profile> --env dev; the tag bindings it made are removed: ${[VM, ZONAL, SQL].map((t) => t.label).join(', ')}; still tagged: ${REGIONAL.label} (Google: 503 UNAVAILABLE: try again)`);
    expect([...s.bindings]).toEqual([REGIONAL.parent]);
    expect(stored.context.tagged).toEqual([REGIONAL]);
  });

  it('an onboarding whose answer was lost (a timeout) removes no binding: the router may have onboarded it, and the detail names what is kept', async () => {
    const s = setup();
    s.answers.onboard = () => { throw new Error('no answer within 300000 ms'); };
    const op = await s.engine.create('onboard', INPUT, 'ops@example.com');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'failed' });
    expect(s.tagCalls.filter((c) => c.startsWith('unbind'))).toEqual([]);
    expect([...s.bindings]).toEqual([VM, ZONAL, REGIONAL, SQL].map((t) => t.parent));
    const stored = (await s.records.getOperation(op.id))!;
    expect(stored.steps.find((x) => x.name === 'onboard')!.detail).toBe(
      `no answer within 300000 ms; the tag bindings it made are kept, as the router may have onboarded it: ${[VM, ZONAL, REGIONAL, SQL].map((t) => t.label).join(', ')}`,
    );
    expect(stored.context.tagged).toEqual([VM, ZONAL, REGIONAL, SQL]);
  });

  it('a binding that fails removes those the step made and fails it, before any onboarding', async () => {
    const s = setup({ bound: [VM.parent], failBind: [REGIONAL.parent] });
    const op = await s.engine.create('onboard', INPUT, 'ops@example.com');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'failed' });
    expect([...s.bindings]).toEqual([VM.parent]);
    const stored = (await s.records.getOperation(op.id))!;
    expect(stored.error).toBe(`tag: ${REGIONAL.label}: Google: 403 IAM_PERMISSION_DENIED: Permission denied; the tag bindings it made are removed: ${ZONAL.label}`);
    expect(stored.context.tagged).toEqual([]);
    expect(actionsOf(s).map(([, action]) => action)).toEqual(['preview']);
  });

  it('a refused preview fails before any binding', async () => {
    const s = setup();
    const ok = s.answers.preview!;
    s.answers.preview = (p) => ({ ...(ok(p) as object), eligible: false, ok: false, problems: ['backend service dmt-demo-app has no health check: a wake waits for a healthy instance, add one'] });
    const op = await s.engine.create('onboard', INPUT, 'ops@example.com');
    await s.drive(op.id);
    expect((await s.records.getOperation(op.id))!.error).toBe('preview: backend service dmt-demo-app has no health check: a wake waits for a healthy instance, add one');
    expect(s.tagCalls).toEqual([]);
  });

  it('a workload FAILED at the verification fails the operation, its bindings kept: the router onboarded it', async () => {
    const s = setup();
    s.answers.status = () => ({ workloadId: WORKLOAD_ID, name: 'Demo', backendService: 'dmt-demo-app', state: 'FAILED', issues: [] });
    const op = await s.engine.create('onboard', INPUT, 'ops@example.com');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'failed' });
    expect((await s.records.getOperation(op.id))!.error).toBe('verify: Demo FAILED');
    expect(s.tagCalls.filter((c) => c.startsWith('unbind'))).toEqual([]);
    expect(s.items.get(SERVICE)).toMatchObject({ eligibility: 'eligible' });
  });

  it('a verification that finds another backend service or issues fails, naming them', async () => {
    const s = setup();
    s.answers.status = () => ({ workloadId: WORKLOAD_ID, name: 'Demo', backendService: 'other', state: 'AWAKE', issues: ['the URL map names no waker'] });
    const op = await s.engine.create('onboard', INPUT, 'ops@example.com');
    await s.drive(op.id);
    expect((await s.records.getOperation(op.id))!.error).toBe('verify: Demo AWAKE, backend service other instead of dmt-demo-app, issues: the URL map names no waker');
  });

  it('a router gone or too old since the request fails at its finding, with the command that installs it', async () => {
    const gone = setup({ routers: [] });
    const op = await gone.engine.create('onboard', INPUT, 'ops@example.com');
    await gone.drive(op.id);
    expect((await gone.records.getOperation(op.id))!.error).toBe(`find router: no router in project ${PROJECT}, region ${REGION}: dormeto gcp install --project ${PROJECT} --region ${REGION} --version 0.40.0`);
    const old = setup({ routers: [{ ...ROUTER, version: '0.39.2' }] });
    const op2 = await old.engine.create('onboard', INPUT, 'ops@example.com');
    await old.drive(op2.id);
    expect((await old.records.getOperation(op2.id))!.error).toBe(`find router: router 0.39.2 can't report to the manager: dormeto gcp install --project ${PROJECT} --region ${REGION} --version 0.40.0`);
    expect([...gone.invocations, ...old.invocations]).toEqual([]);
  });

  it('refuses an input without the router\'s region or the project\'s number', async () => {
    const s = setup();
    await expect(s.engine.create('onboard', { ...INPUT, region: 'global' }, 'ops@example.com')).rejects.toThrow('bad router region: global');
    await expect(s.engine.create('onboard', { ...INPUT, projectNumber: undefined }, 'ops@example.com')).rejects.toThrow('bad project number: undefined');
  });
});
