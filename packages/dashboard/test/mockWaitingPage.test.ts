import { beforeEach, describe, expect, it } from 'vitest';
import { mockApi } from '../src/mock';
import { state } from '../src/mock/state';
import type { OrganizationPageView, WaitingPageView } from '../src/waiting-page';

const put = (path: string, page: unknown) => mockApi(path, { method: 'PUT', body: JSON.stringify({ page }) });
const del = (path: string) => mockApi(path, { method: 'DELETE' });
const get = <T>(path: string) => mockApi(path) as Promise<T>;
const HTML = '<!doctype html><p data-dormeto="status"></p>';

function workloads() {
  const d = state();
  const current = (r: string) => Number(d.routers.find((x) => x.name === r)!.version.split('.')[1]) >= 35;
  const manager = d.workloads.find((w) => w.source === 'manager' && current(w.router))!;
  const terraform = d.workloads.find((w) => w.source === 'terraform' && current(w.router))!;
  const old = d.workloads.find((w) => !current(w.router))!;
  const path = (w: { router: string; workloadId: string }) => `/workloads/${w.router}/${w.workloadId}/waiting-page`;
  return { d, manager, terraform, old, path };
}

beforeEach(() => {
  const d = state();
  d.me.role = 'admin';
  d.me.effectiveRole = 'admin';
  d.waitingPage = { page: null, updatedAt: null, updatedBy: null };
  for (const r of d.routers) r.page = null;
  for (const w of d.workloads) w.page = null;
});

describe('the demo\'s waiting pages', () => {
  it('sets, reads and clears the organization\'s page, audited, and rejects a bad one with sentences', async () => {
    expect(await get<OrganizationPageView>('/settings/waiting-page')).toMatchObject({ page: null, warnings: [] });
    const set = await put('/settings/waiting-page', { mode: 'template', icon: 'none', title: 'Acme portal' }) as OrganizationPageView;
    expect(set.page).toEqual({ mode: 'template', icon: 'none', title: 'Acme portal' });
    expect(state().audit[0]).toMatchObject({ action: 'waiting-page', target: 'organization', result: 'organization template' });
    expect((await get<OrganizationPageView>('/settings/waiting-page')).updatedBy).toBe(state().me.email);
    await expect(put('/settings/waiting-page', { mode: 'template', title: 'a'.repeat(81) })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('80') });
    await expect(put('/settings/waiting-page', { mode: 'template', html: HTML })).rejects.toMatchObject({ status: 400 });
    await del('/settings/waiting-page');
    expect((await get<OrganizationPageView>('/settings/waiting-page')).page).toBeNull();
  });

  it('resolves a workload\'s page field by field over the router\'s and the organization\'s, with where each comes from', async () => {
    const { manager, path } = workloads();
    await put('/settings/waiting-page', { mode: 'template', icon: 'none', title: 'Acme', description: 'Org text' });
    await put(`/routers/${manager.router}/waiting-page`, { mode: 'template', title: 'Router title' });
    await put(path(manager), { mode: 'template', description: 'Mine' });
    const view = await get<WaitingPageView>(path(manager));
    expect(view.own).toEqual({ mode: 'template', description: 'Mine' });
    expect(view.effective).toMatchObject({ mode: 'template', icon: 'none', title: 'Router title', description: 'Mine' });
    expect(view.from).toMatchObject({ mode: 'workload', icon: 'organization', title: 'router', description: 'workload' });
    expect(view.inherited).toMatchObject({ title: 'Router title', description: 'Org text' });
    expect(view).toMatchObject({ terraform: false, by: state().me.email });
    await del(path(manager));
    expect((await get<WaitingPageView>(path(manager))).own).toBeNull();
  });

  it('a custom page decides the mode, and warns when it has no status hook', async () => {
    const { manager, path } = workloads();
    await put('/settings/waiting-page', { mode: 'template', title: 'Acme' });
    const put1 = await put(path(manager), { mode: 'custom', html: '<!doctype html><p>wait</p>' }) as WaitingPageView;
    expect(put1.warnings[0]).toContain('data-dormeto="status"');
    expect((await get<WaitingPageView>(path(manager))).effective).toMatchObject({ mode: 'custom', html: '<!doctype html><p>wait</p>', from: { mode: 'workload', html: 'workload' } });
    expect(state().audit[0]!.result).toMatch(/^workload custom, 26 bytes, sha256 [0-9a-f]{64}$/);
  });

  it('seeds a cached favicon on workloads, one with the reason there is none', async () => {
    const { d, path } = workloads();
    const views = await Promise.all(d.workloads.filter((w) => Number(d.routers.find((r) => r.name === w.router)!.version.split('.')[1]) >= 35).map((w) => get<WaitingPageView>(path(w))));
    expect(views.some((v) => v.favicon?.icon?.startsWith('data:image/'))).toBe(true);
    expect(views.some((v) => v.favicon && v.favicon.icon === null && v.favicon.error)).toBe(true);
  });

  it('refuses a Terraform workload\'s write, and a router before 0.35.0 with a 409', async () => {
    const { terraform, old, path } = workloads();
    await expect(put(path(terraform), { mode: 'template', title: 'x' })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('waiting_page') });
    expect((await get<WaitingPageView>(path(terraform))).terraform).toBe(true);
    await expect(get(path(old))).rejects.toMatchObject({ status: 409, message: 'upgrade the router to 0.35.0' });
    await expect(get(`/routers/${old.router}/waiting-page`)).rejects.toMatchObject({ status: 409, message: 'upgrade the router to 0.35.0' });
  });

  it('keeps a custom page for administrators: an operator\'s set, replace and clear are refused (403)', async () => {
    const { d, manager, path } = workloads();
    await put(path(manager), { mode: 'custom', html: HTML });
    d.me.role = 'operator';
    d.me.effectiveRole = 'operator';
    await expect(put(path(manager), { mode: 'custom', html: HTML })).rejects.toMatchObject({ status: 403 });
    await expect(put(path(manager), { mode: 'template', title: 'x' })).rejects.toMatchObject({ status: 403 });
    await expect(del(path(manager))).rejects.toMatchObject({ status: 403 });
    await expect(put('/settings/waiting-page', { mode: 'template', title: 'x' })).rejects.toMatchObject({ status: 403 });
    await expect(put(`/routers/${manager.router}/waiting-page`, { mode: 'template', title: 'x' })).rejects.toMatchObject({ status: 403 });
    d.me.role = 'admin';
    d.me.effectiveRole = 'admin';
    await del(path(manager));
    d.me.role = 'operator';
    d.me.effectiveRole = 'operator';
    await expect(put(path(manager), { mode: 'template', title: 'ok' })).resolves.toBeTruthy();
  });
});
