// A Google Cloud candidate onboarded by the operations engine (Google Cloud manager design §8): the router of its project
// found again, the slot of the project and the router's region, the URL map locked, the router's preview, the tag
// `dormeto/managed` bound as the command account to what the preview names, the router's onboarding, its status, the
// candidate managed. A refusal of the onboarding removes the bindings the operation made; a lost answer keeps them.
// Offboarded the same way: the router's status, its pause and offboarding, the tag removed from what its status names,
// the candidate eligible again; a GKE workload, or one whose onboarding turned request logs on, refused before anything.
import { describe, expect, it } from 'vitest';
import type { Candidate, DiscoveryStore } from '@dormeto/discovery';
import { GoogleError, type TagTarget } from '@dormeto/google';
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

// bound: the parents tagged already; failBind and failUnbind: the parents whose binding or removal fails; missing: those
// whose removal Google answers 404 (gone meanwhile); valueRefused and regionRefused: why the tag value or a Cloud SQL
// instance's region can't be read.
function setup({ routers = [ROUTER], bound = [] as string[], failBind = [] as string[], failUnbind = [] as string[], missing = [] as string[], valueRefused = '', regionRefused = '' } = {}) {
  let now = T0;
  let ids = 0;
  const records = createRecords({ dynamo: fakeDynamo(), table: 't', now: () => now });
  const items = new Map([[SERVICE, candidate()]]);
  const discovery = {
    getCandidate: async (id: string) => items.get(id) ?? null,
    replaceCandidates: async (after: Candidate[]) => { for (const c of after) items.set(c.id, c); },
  } as unknown as DiscoveryStore;
  // The router's actions, in its AWS shapes (router gcp/src/actions.mjs): preview, onboard, status and offboard (the
  // offboarding's pause: its helper's).
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
    // AWS's offboard answer (:793): the steps of what the offboarding changed.
    offboard: () => ({ steps: [{ name: 'wake', status: 'skipped' }, { name: 'url map', status: 'done' }, { name: 'waker backend service', status: 'done' }, { name: 'workload configuration', status: 'done' }] }),
  };
  // The tag bindings, by parent; every call, in order.
  const bindings = new Set(bound);
  const tagCalls: string[] = [];
  const tags = {
    tagValueOf: async (project: string) => {
      tagCalls.push(`value ${project}`);
      if (valueRefused) throw new Error(valueRefused);
      return TAG_VALUE;
    },
    sqlRegionOf: async (project: string, name: string) => {
      tagCalls.push(`region ${project} ${name}`);
      if (regionRefused) throw new GoogleError({ status: 404, reason: 'NOT_FOUND', message: regionRefused });
      return 'europe-west1';
    },
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
      if (missing.includes(target.parent)) throw new GoogleError({ status: 404, reason: 'NOT_FOUND', message: `${target.parent} not found` });
      return bindings.delete(target.parent) ? 1 : 0;
    },
  };
  const engine = createEngine({
    records, discovery, routers: async () => routers,
    target: async () => { throw new Error('no AWS account in a Google Cloud onboarding'); },
    bundle: async () => { throw new Error('no router bundle in a Google Cloud onboarding'); },
    google: {
      // A `{refused}` answer thrown with its code, as googleInvoker does.
      invoke: async (router, payload, { timeoutMs }) => {
        invocations.push([router.name, payload, timeoutMs]);
        const answer = answers[payload.action as string]!(payload) as { refused?: { code: string; message: string } };
        if (answer?.refused) throw Object.assign(new Error(answer.refused.message), { code: answer.refused.code });
        return answer;
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
    // The router's not-eligible refusal (router gcp/src/onboarding.mjs:709, a 400: `invalid`).
    const refusal = `cannot onboard ${WORKLOAD_ID}: backend service dmt-demo-app is already workload other`;
    s.answers.onboard = () => ({ refused: { code: 'invalid', message: refusal } });
    const op = await s.engine.create('onboard', INPUT, 'ops@example.com');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'failed' });
    expect(s.tagCalls.filter((c) => c.startsWith('unbind'))).toEqual([ZONAL, REGIONAL, SQL].map((t) => `unbind ${t.parent} ${TAG_VALUE}`));
    expect([...s.bindings]).toEqual([VM.parent]);
    const stored = (await s.records.getOperation(op.id))!;
    const removed = `the tag bindings it made are removed: ${[ZONAL, REGIONAL, SQL].map((t) => t.label).join(', ')}`;
    expect(stored.error).toBe(`onboard: ${refusal}; ${removed}`);
    expect(stored.steps.find((x) => x.name === 'onboard')).toMatchObject({ status: 'failed', detail: `${refusal}; ${removed}` });
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

  describe('an onboarding refused as onboarded already (the step run again after an attempt whose answer was lost)', () => {
    const exists = { refused: { code: 'conflict', message: `workload ${WORKLOAD_ID} is onboarded already` } };
    const ALL = [VM, ZONAL, REGIONAL, SQL];

    it('the router has the workload on this candidate\'s backend service: an earlier attempt onboarded it, the step is done and nothing is removed', async () => {
      const s = setup();
      s.answers.onboard = () => exists;
      const op = await s.engine.create('onboard', INPUT, 'ops@example.com');
      expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
      expect(s.tagCalls.filter((c) => c.startsWith('unbind'))).toEqual([]);
      expect([...s.bindings]).toEqual(ALL.map((t) => t.parent));
      const stored = (await s.records.getOperation(op.id))!;
      expect(stored.steps.slice(-3).map((x) => [x.name, x.status, x.detail])).toEqual([
        ['onboard', 'done', `the router already had workload ${WORKLOAD_ID} on backend service dmt-demo-app: an earlier attempt onboarded it`],
        ['verify', 'done', 'Demo AWAKE, backend service dmt-demo-app'],
        ['candidate', 'done', undefined],
      ]);
      expect(stored.context.tagged).toEqual(ALL);
      // The status read after the refusal, then the verification's.
      expect(actionsOf(s)).toEqual([[ROUTER.name, 'preview', 300_000], [ROUTER.name, 'onboard', 300_000], [ROUTER.name, 'status', 10_000], [ROUTER.name, 'status', 10_000]]);
      expect(s.invocations[2]![1]).toEqual({ action: 'status', workloadId: WORKLOAD_ID });
      expect(s.items.get(SERVICE)).toMatchObject({ eligibility: 'managed', workloadId: WORKLOAD_ID });
    });

    it('the router\'s workload of that id has another backend service, or the router has none: the refusal stands, the bindings removed', async () => {
      for (const status of [
        () => ({ workloadId: WORKLOAD_ID, name: 'Other', backendService: 'other-app', state: 'AWAKE', issues: [] }),
        () => ({ refused: { code: 'not_found', message: `no workload ${WORKLOAD_ID}` } }),
      ]) {
        const s = setup();
        s.answers.onboard = () => exists;
        s.answers.status = status;
        const op = await s.engine.create('onboard', INPUT, 'ops@example.com');
        expect(await s.drive(op.id)).toEqual({ done: true, status: 'failed' });
        expect([...s.bindings]).toEqual([]);
        const stored = (await s.records.getOperation(op.id))!;
        expect(stored.error).toBe(`onboard: workload ${WORKLOAD_ID} is onboarded already; the tag bindings it made are removed: ${ALL.map((t) => t.label).join(', ')}`);
        expect(stored.context.tagged).toEqual([]);
        expect(actionsOf(s).map(([, action]) => action)).toEqual(['preview', 'onboard', 'status']);
      }
    });

    it('a status whose answer is lost too can\'t tell: nothing is removed, and the detail says so', async () => {
      const s = setup();
      s.answers.onboard = () => exists;
      s.answers.status = () => { throw new Error('no answer within 10000 ms'); };
      const op = await s.engine.create('onboard', INPUT, 'ops@example.com');
      expect(await s.drive(op.id)).toEqual({ done: true, status: 'failed' });
      expect(s.tagCalls.filter((c) => c.startsWith('unbind'))).toEqual([]);
      expect((await s.records.getOperation(op.id))!.error).toBe(
        `onboard: workload ${WORKLOAD_ID} is onboarded already; its status can't be read (no answer within 10000 ms): the tag bindings it made are kept, as the router may have onboarded it: ${ALL.map((t) => t.label).join(', ')}`,
      );
    });
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

describe('offboarding a Google Cloud workload', () => {
  // The operation's input as the API gives it: the router (its name), its project and region, the project's number.
  const OFFBOARD = { router: ROUTER_NAME, account: PROJECT, region: REGION, workloadId: WORKLOAD_ID, projectNumber: NUMBER };
  const ALL = [VM, ZONAL, REGIONAL, SQL];
  const labels = (targets: TagTarget[]) => targets.map((t) => t.label).join(', ');
  // The router's status of a workload the CLI onboarded (router gcp/src/actions.mjs's status): AWS's backend kinds, with
  // the numeric ids the onboarding stored and their locations; a Cloud SQL instance by its name.
  const BACKENDS = [
    { kind: 'instance', id: 'vm-1', status: null, location: 'europe-west2-b', resourceId: '4471' },
    { kind: 'asg', id: 'mig-z', status: null, location: 'europe-west2-b', resourceId: '5582' },
    { kind: 'asg', id: 'mig-r', status: null, location: 'europe-west2', resourceId: '6693' },
    { kind: 'cloudsql-instance', id: 'db-1', status: null, companion: true },
  ];
  const GKE = { kind: 'k8s', id: 'k8s:europe-west2/dmt-gke:shop:Deployment/web', status: null, cluster: 'europe-west2/dmt-gke', namespace: 'shop', owner: 'Deployment/web' };

  // A managed candidate, its four backends tagged; `status` changes the router's answer, the workload asleep until the
  // offboarding's pause wakes it.
  function offboarding({ status = {}, ...options }: NonNullable<Parameters<typeof setup>[0]> & { status?: Record<string, unknown> } = {}) {
    const s = setup({ bound: ALL.map((t) => t.parent), ...options });
    s.items.set(SERVICE, candidate({ eligibility: 'managed', workloadId: WORKLOAD_ID, status: 'managed', statusReason: 'managed' }));
    let state = 'ASLEEP';
    s.answers.status = () => ({
      workloadId: WORKLOAD_ID, name: 'Demo', state, source: 'cli', backendService: 'dmt-demo-app', urlMap: 'dmt-dev', lb: { kind: 'global' },
      settings: { wakeTimeoutSeconds: 300 }, issues: [], rules: [], backends: BACKENDS, ...status,
    });
    s.answers.pause = () => {
      state = 'AWAKE';
      return { pause: { scope: 'workload', by: 'ops@example.com', reason: 'offboarding' }, woken: ['vm-1'] };
    };
    return s;
  }

  it('runs the Google Cloud steps on the router of its project and region, holding the slot and the URL map\'s lock, removes the tag from what its status names, and the candidate is eligible again', async () => {
    const s = offboarding();
    const op = await s.engine.create('offboard', OFFBOARD, 'ops@example.com');
    expect(op.target).toEqual({ account: PROJECT, region: REGION, router: ROUTER_NAME, workloadId: WORKLOAD_ID, projectNumber: NUMBER });
    expect(op.activeKey).toBe(`WL#${PROJECT}#${REGION}#${WORKLOAD_ID}`);
    expect(op.steps.map((x) => x.name)).toEqual(['locate', 'slot', 'lock load balancer', 'pause', 'wait awake', 'offboard', 'untag', 'candidate']);
    for (let i = 0; i < 3; i += 1) await s.engine.next(op.id);
    expect((await s.records.getOperation(op.id))!.holds).toEqual({ locks: [`LB#${MAP}`], slots: ['ORG', `${PROJECT}#${REGION}`] });

    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    const stored = (await s.records.getOperation(op.id))!;
    expect(stored.steps.map((x) => [x.name, x.status, x.detail])).toEqual([
      ['locate', 'done', 'Demo ASLEEP'],
      ['slot', 'done', undefined],
      ['lock load balancer', 'done', undefined],
      ['pause', 'done', 'woken'],
      ['wait awake', 'done', undefined],
      ['offboard', 'done', 'url map, waker backend service, workload configuration'],
      ['untag', 'done', `untagged ${labels(ALL)}`],
      ['candidate', 'done', undefined],
    ]);
    // The onboarder's offboard within 300 s, the others within 10 s; no AWS account assumed.
    expect(actionsOf(s)).toEqual([[ROUTER.name, 'status', 10_000], [ROUTER.name, 'pause', 10_000], [ROUTER.name, 'status', 10_000], [ROUTER.name, 'offboard', 300_000]]);
    expect(s.invocations.map(([, p]) => p)).toEqual([
      { action: 'status', workloadId: WORKLOAD_ID },
      { action: 'pause', workloadId: WORKLOAD_ID, by: 'ops@example.com', reason: 'offboarding', keepAsleep: false },
      { action: 'status', workloadId: WORKLOAD_ID },
      { action: 'offboard', workloadId: WORKLOAD_ID, by: 'ops@example.com' },
    ]);
    // The Cloud SQL instance's region read at the locate, the tag value at the untag; each binding removed, one per run.
    expect(s.tagCalls).toEqual([`region ${PROJECT} db-1`, `value ${PROJECT}`, ...ALL.map((t) => `unbind ${t.parent} ${TAG_VALUE}`)]);
    expect([...s.bindings]).toEqual([]);
    expect(stored.steps.find((x) => x.name === 'untag')!.attempts).toBe(4);
    expect(stored.context.untag).toEqual([]);
    const c = s.items.get(SERVICE)!;
    expect(c).toMatchObject({ eligibility: 'eligible' });
    expect(c.workloadId).toBeUndefined();
    expect(await s.records.acquireLock(`LB#${MAP}`, 'other', 60_000)).toBe(true);
    expect(await s.records.slotHolders(`${PROJECT}#${REGION}`)).toEqual([]);
    expect(await s.records.claimActive(`WL#${PROJECT}#${REGION}#${WORKLOAD_ID}`, 'other', 60_000)).toEqual({ ok: true });
  });

  it('builds the URL map\'s and backend service\'s paths from the load balancer: a regional or internal one\'s in its region (the router\'s when unsaid), the others global', async () => {
    for (const [lb, scope] of [
      [{ kind: 'regional', region: 'europe-west2' }, 'regions/europe-west2'],
      [{ kind: 'internal' }, `regions/${REGION}`],
      [{ kind: 'classic' }, 'global'],
      [{ kind: 'cross-region-internal' }, 'global'],
      [undefined, 'global'],
    ] as const) {
      const s = offboarding({ status: { lb } });
      const service = `projects/${PROJECT}/${scope}/backendServices/dmt-demo-app`;
      s.items.set(service, candidate({ id: service, backendService: service, eligibility: 'managed', workloadId: WORKLOAD_ID, status: 'managed' }));
      const op = await s.engine.create('offboard', OFFBOARD, 'ops@example.com');
      for (let i = 0; i < 3; i += 1) await s.engine.next(op.id);
      expect((await s.records.getOperation(op.id))!.holds.locks, JSON.stringify(lb)).toEqual([`LB#projects/${PROJECT}/${scope}/urlMaps/dmt-dev`]);
      expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
      expect(s.items.get(service), JSON.stringify(lb)).toMatchObject({ eligibility: 'eligible' });
      if (scope !== 'global') expect(s.items.get(SERVICE)).toMatchObject({ eligibility: 'managed' });
    }
  });

  it('a GKE workload is refused at the locate with the router\'s words and the CLI\'s command: no pause sent, nothing untagged, the candidate managed', async () => {
    const s = offboarding({ status: { backends: [GKE] } });
    const op = await s.engine.create('offboard', OFFBOARD, 'ops@example.com');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'failed' });
    const stored = (await s.records.getOperation(op.id))!;
    expect(stored.error).toBe(`locate: cannot offboard ${WORKLOAD_ID} through the manager: a GKE workload's Kubernetes access is the CLI's to remove: dormeto gcp workloads offboard ${WORKLOAD_ID} --project ${PROJECT} --region ${REGION}`);
    expect(stored.steps.map((x) => x.status)).toEqual(['failed', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending']);
    expect(actionsOf(s).map(([, action]) => action)).toEqual(['status']);
    expect(s.tagCalls).toEqual([]);
    expect(s.items.get(SERVICE)).toMatchObject({ eligibility: 'managed', workloadId: WORKLOAD_ID });
    expect(await s.records.claimActive(`WL#${PROJECT}#${REGION}#${WORKLOAD_ID}`, 'other', 60_000)).toEqual({ ok: true });
  });

  it('a workload whose onboarding turned request logs on is refused the same way, before anything changes', async () => {
    const s = offboarding({ status: { requestLogs: { before: { enable: false, sampleRate: 0 } } } });
    const op = await s.engine.create('offboard', OFFBOARD, 'ops@example.com');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'failed' });
    expect((await s.records.getOperation(op.id))!.error).toBe(
      `locate: cannot offboard ${WORKLOAD_ID} through the manager: its onboarding turned its backend service's request logs on, which the CLI sets back: dormeto gcp workloads offboard ${WORKLOAD_ID} --project ${PROJECT} --region ${REGION}`,
    );
    expect(actionsOf(s).map(([, action]) => action)).toEqual(['status']);
    expect(s.tagCalls).toEqual([]);
  });

  it('a binding already gone (none listed, or a 404 on its removal) is nothing to remove: said, and the step skipped when none was', async () => {
    const some = offboarding({ bound: [VM.parent, SQL.parent], missing: [SQL.parent] });
    const op = await some.engine.create('offboard', OFFBOARD, 'ops@example.com');
    expect(await some.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    expect((await some.records.getOperation(op.id))!.steps.find((x) => x.name === 'untag')).toMatchObject({
      status: 'done', detail: `untagged ${VM.label}; not tagged ${labels([ZONAL, REGIONAL, SQL])}`,
    });
    const none = offboarding({ bound: [] });
    const op2 = await none.engine.create('offboard', OFFBOARD, 'ops@example.com');
    expect(await none.drive(op2.id)).toEqual({ done: true, status: 'succeeded' });
    expect((await none.records.getOperation(op2.id))!.steps.find((x) => x.name === 'untag')).toMatchObject({ status: 'skipped', detail: `not tagged ${labels(ALL)}` });
    expect(none.items.get(SERVICE)).toMatchObject({ eligibility: 'eligible' });
  });

  it('a removal that fails fails the step after the router\'s offboarding, naming every target still tagged and those untagged', async () => {
    const s = offboarding({ failUnbind: [REGIONAL.parent] });
    const op = await s.engine.create('offboard', OFFBOARD, 'ops@example.com');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'failed' });
    const stored = (await s.records.getOperation(op.id))!;
    expect(stored.error).toBe(`untag: ${REGIONAL.label}: Google: 503 UNAVAILABLE: try again; still tagged: ${labels([REGIONAL, SQL])}; untagged ${labels([VM, ZONAL])}`);
    expect(stored.context.untag).toEqual([REGIONAL, SQL]);
    expect([...s.bindings]).toEqual([REGIONAL.parent, SQL.parent]);
    expect(actionsOf(s).map(([, action]) => action)).toEqual(['status', 'pause', 'status', 'offboard']);
    expect(s.items.get(SERVICE)).toMatchObject({ eligibility: 'managed' });
  });

  it('a tag value that can\'t be read fails the step naming every target still tagged', async () => {
    const refused = `the tag value ${PROJECT}/dormeto/managed can't be read: \`dormeto gcp connect\` gives the manager's command account access to it`;
    const s = offboarding({ valueRefused: refused });
    const op = await s.engine.create('offboard', OFFBOARD, 'ops@example.com');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'failed' });
    expect((await s.records.getOperation(op.id))!.error).toBe(`untag: ${refused}; still tagged: ${labels(ALL)}`);
    expect([...s.bindings]).toEqual(ALL.map((t) => t.parent));
  });

  it('a Cloud SQL instance whose region can\'t be read fails the locate, naming it, before anything changes', async () => {
    const s = offboarding({ regionRefused: 'The Cloud SQL instance does not exist.' });
    const op = await s.engine.create('offboard', OFFBOARD, 'ops@example.com');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'failed' });
    expect((await s.records.getOperation(op.id))!.error).toBe('locate: Cloud SQL instance db-1: The Cloud SQL instance does not exist.');
    expect(actionsOf(s).map(([, action]) => action)).toEqual(['status']);
  });

  it('a backend without a resource id (an older onboarding) is named at the locate, and the untag says to remove its tag by hand', async () => {
    const s = offboarding({ status: { backends: [{ kind: 'instance', id: 'vm-old', status: null, location: 'europe-west2-c' }, { kind: 'asg', id: 'mig-old', status: null, location: 'europe-west2' }, BACKENDS[0]] } });
    const op = await s.engine.create('offboard', OFFBOARD, 'ops@example.com');
    expect(await s.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    const stored = (await s.records.getOperation(op.id))!;
    const old = 'VM europe-west2-c/vm-old, managed instance group europe-west2/mig-old';
    expect(stored.steps.find((x) => x.name === 'locate')!.detail).toBe(`Demo ASLEEP; no resource id stored for ${old} (an older onboarding): the manager can't remove the tag dormeto/managed there`);
    expect(stored.steps.find((x) => x.name === 'untag')!.detail).toBe(`untagged ${VM.label}; remove the tag dormeto/managed from ${old} by hand: an older onboarding stored no resource id`);
    expect(s.tagCalls.filter((c) => c.startsWith('unbind'))).toEqual([`unbind ${VM.parent} ${TAG_VALUE}`]);
  });

  it('an offboarding the router no longer has the workload of (an earlier attempt\'s answer lost) is done, and the tag removed; another refusal fails it, nothing untagged', async () => {
    const again = offboarding();
    again.answers.offboard = () => ({ refused: { code: 'not_found', message: `no workload ${WORKLOAD_ID}` } });
    const op = await again.engine.create('offboard', OFFBOARD, 'ops@example.com');
    expect(await again.drive(op.id)).toEqual({ done: true, status: 'succeeded' });
    expect((await again.records.getOperation(op.id))!.steps.find((x) => x.name === 'offboard')).toMatchObject({
      status: 'done', detail: `the router no longer has workload ${WORKLOAD_ID}: offboarded already`,
    });
    expect([...again.bindings]).toEqual([]);
    const busy = offboarding();
    busy.answers.offboard = () => ({ refused: { code: 'conflict', message: `cannot offboard ${WORKLOAD_ID}: it is NAPPING, try again once it is done` } });
    const op2 = await busy.engine.create('offboard', OFFBOARD, 'ops@example.com');
    expect(await busy.drive(op2.id)).toEqual({ done: true, status: 'failed' });
    expect((await busy.records.getOperation(op2.id))!.error).toBe(`offboard: cannot offboard ${WORKLOAD_ID}: it is NAPPING, try again once it is done`);
    expect(busy.tagCalls.filter((c) => c.startsWith('unbind'))).toEqual([]);
  });

  it('refuses an input without the project\'s number or with a bad region', async () => {
    const s = offboarding();
    await expect(s.engine.create('offboard', { ...OFFBOARD, projectNumber: undefined }, 'ops@example.com')).rejects.toThrow('bad project number: undefined');
    await expect(s.engine.create('offboard', { ...OFFBOARD, region: 'global' }, 'ops@example.com')).rejects.toThrow('bad router region: global');
  });
});
