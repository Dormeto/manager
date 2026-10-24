import { describe, expect, it } from 'vitest';
import { freshBootLine, fromText, hibernationLine, readinessLine, routerInheritText } from '../src/hibernation';
import { causeText } from '../src/history';
import { mockApi } from '../src/mock';
import { state } from '../src/mock/state';
import { workloadStatus } from '../src/mock/views';

const base = { workload: null, router: null, manager: null, instances: null, freshBoot: false };

describe('hibernation texts', () => {
  it('says where the value comes from, for each level', () => {
    expect(fromText('workload')).toBe('set on this workload');
    expect(fromText('fallback-types')).toBe('off: the workload has fallback instance types');
    expect(fromText('router')).toBe('from the router');
    expect(fromText('manager')).toBe("from the manager's default");
    expect(fromText('default')).toBe('built-in default');
  });

  it('writes the line: On or Off, then where it comes from', () => {
    expect(hibernationLine({ ...base, hibernate: true, from: 'router' })).toBe('On, from the router');
    expect(hibernationLine({ ...base, hibernate: false, from: 'workload' })).toBe('Off, set on this workload');
    expect(hibernationLine({ ...base, hibernate: false, from: 'fallback-types' })).toBe('Off: the workload has fallback instance types');
    expect(hibernationLine({ ...base, hibernate: true, from: 'manager' })).toBe("On, from the manager's default");
    expect(hibernationLine({ ...base, hibernate: true, from: 'default' })).toBe('On, built-in default');
  });

  it("says Off for now while the router has not read the manager's settings (router 0.32.0's unknown)", () => {
    expect(hibernationLine({ ...base, hibernate: false, from: 'manager', unknown: true })).toBe("Off for now: the router has not read the manager's settings yet (naps stop)");
  });

  it('says the next nap stops the instances after 59 days hibernated (a fresh boot)', () => {
    expect(freshBootLine({ freshBoot: true })).toBe('The next nap stops the instances (a fresh boot after 59 days hibernated)');
    expect(freshBootLine({ freshBoot: false })).toBe('');
  });

  it('says which instances were launched with hibernation, only while the value is on', () => {
    const on = (instances: { id: string; configured: boolean; hibernated: boolean }[] | null) => readinessLine({ hibernate: true, instances });
    const i = (id: string, configured: boolean) => ({ id, configured, hibernated: false });
    expect(on(null)).toBe('');
    expect(on([])).toBe('');
    expect(on([i('i-0a', true), i('i-0b', true)])).toBe('Every instance was launched with hibernation');
    expect(on([i('i-0abc', false), i('i-0b', true), i('i-0c', true)])).toBe('2 of 3 instances were launched with hibernation; i-0abc is stopped instead');
    expect(on([i('i-0a', false), i('i-0b', false), i('i-0c', true)])).toBe('1 of 3 instances were launched with hibernation; i-0a, i-0b are stopped instead');
    // Off or fallback types: every instance is stopped, nothing to say.
    expect(readinessLine({ hibernate: false, instances: [i('i-0a', false), i('i-0b', true)] })).toBe('');
  });

  it("shows a router's inherited value: the manager's, as it last read it, or the built-in default", () => {
    const now = Date.parse('2026-10-24T12:00:00.000Z');
    expect(routerInheritText({ url: 's3://b/settings.json', hibernate: true, readAt: '2026-10-24T11:57:00.000Z', error: null }, now)).toBe('manager: On, read 3 min ago');
    expect(routerInheritText({ url: 's3://b/settings.json', hibernate: false, readAt: '2026-10-24T11:57:00.000Z', error: 'AccessDenied' }, now)).toBe('manager: Off (last read failed 3 min ago: AccessDenied)');
    // Nothing read yet (just upgraded), or every read failed: unknown, and naps stop plainly.
    expect(routerInheritText({ url: 's3://b/settings.json', hibernate: null, readAt: null, error: null }, now)).toBe('manager: unknown (not read yet): naps stop');
    expect(routerInheritText({ url: 's3://b/settings.json', hibernate: null, readAt: '2026-10-24T11:57:00.000Z', error: 'settings.json: not JSON' }, now)).toBe('manager: unknown (settings.json: not JSON): naps stop');
    expect(routerInheritText({ url: null, hibernate: null, readAt: null, error: null }, now)).toBe('built-in default: On');
  });
});

describe('hibernation in the history', () => {
  it('an ASLEEP phase that hibernated says how many instances', () => {
    expect(causeText({ state: 'ASLEEP', hibernated: ['i-0a'] })).toBe('hibernated 1 instance');
    expect(causeText({ state: 'ASLEEP', hibernated: ['i-0a', 'i-0b'] })).toBe('hibernated 2 instances');
    expect(causeText({ state: 'ASLEEP', cause: 'failed-released', hibernated: ['i-0a'] })).toBe('released after its idle window (the wake had failed), hibernated 1 instance');
    expect(causeText({ state: 'ASLEEP', hibernated: [] })).toBe('');
  });
});

describe("the demo's hibernation answers", () => {
  const get = (path: string) => mockApi(path) as Promise<any>;
  it('covers each place a workload value comes from (the router level once an administrator sets it)', async () => {
    const froms = new Set<string>();
    const collect = () => { for (const w of state().workloads) { const h = workloadStatus(state(), w, Date.now()).hibernation; if (h) froms.add(h.from); } };
    collect();
    await mockApi(`/routers/${state().routers[1]!.name}/settings`, { method: 'PUT', body: JSON.stringify({ hibernate: false }) });
    collect();
    expect([...froms].sort()).toEqual(['default', 'fallback-types', 'manager', 'router', 'workload']);
    await mockApi(`/routers/${state().routers[1]!.name}/settings`, { method: 'PUT', body: JSON.stringify({ hibernate: null }) });
  });

  it('knows nothing of hibernation before router 0.32.0, and refuses to set it there', async () => {
    const old = state().routers.find((r) => r.version.startsWith('0.31'))!;
    const details = await get(`/routers/${old.name}`);
    expect(details).not.toHaveProperty('settings');
    expect(details).not.toHaveProperty('managerSettings');
    const w = state().workloads.find((x) => x.router === old.name && x.source === 'manager')!;
    expect(workloadStatus(state(), w, Date.now())).not.toHaveProperty('hibernation');
    await expect(mockApi(`/routers/${old.name}/settings`, { method: 'PUT', body: JSON.stringify({ hibernate: false }) })).rejects.toMatchObject({ status: 409, message: 'upgrade the router to 0.32.0' });
  });

  it('puts the built-in default on a Terraform router without the manager catalog, and lists only standalone instances', async () => {
    const first = state().routers[0]!;
    expect(first.source).toBe('terraform');
    const details = await get(`/routers/${first.name}`);
    expect(details.managerSettings).toEqual({ url: null, hibernate: null, readAt: null, error: null });
    expect(details.configuration).not.toHaveProperty('ipListsCatalog');
    for (const w of state().workloads) {
      const h = workloadStatus(state(), w, Date.now()).hibernation;
      if (h && !w.backends.some((b) => b.kind === 'instance')) expect(h.instances).toBeNull();
    }
  });

  it('answers the global setting and changes it', async () => {
    expect(await get('/settings/workloads')).toMatchObject({ hibernate: true });
    const put = await mockApi('/settings/workloads', { method: 'PUT', body: JSON.stringify({ hibernate: false }) }) as any;
    expect(put).toMatchObject({ hibernate: false, note: 'routers apply it at their next check, within 5 minutes' });
    expect(typeof put.updatedBy).toBe('string');
    expect(Number.isNaN(Date.parse(put.updatedAt))).toBe(false);
    expect(await get('/settings/workloads')).toMatchObject({ hibernate: false });
    await mockApi('/settings/workloads', { method: 'PUT', body: JSON.stringify({ hibernate: true }) });
  });

  it("carries a router's settings at the top level of its answer, and refuses a Terraform workload", async () => {
    const router = state().routers[1]!;
    const details = await get(`/routers/${router.name}`);
    expect(details.settings).toEqual({ hibernate: null, by: null, at: null });
    expect(details.managerSettings).toMatchObject({ url: expect.any(String), hibernate: true, error: null });
    await mockApi(`/routers/${router.name}/settings`, { method: 'PUT', body: JSON.stringify({ hibernate: false }) });
    expect((await get(`/routers/${router.name}`)).settings).toMatchObject({ hibernate: false, by: expect.any(String) });
    await mockApi(`/routers/${router.name}/settings`, { method: 'PUT', body: JSON.stringify({ hibernate: null }) });
    const tf = state().workloads.find((w) => w.source === 'terraform' && !w.router.endsWith(state().routers.at(-1)!.name))!;
    await expect(mockApi(`/workloads/${tf.router}/${tf.workloadId}/settings`, { method: 'PUT', body: JSON.stringify({ hibernate: false }) }))
      .rejects.toMatchObject({ status: 409, message: `workload ${tf.workloadId} was written by Terraform: set hibernate in its workload module` });
  });
});
