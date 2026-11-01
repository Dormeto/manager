import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import WaitingPageCard from '../src/components/WaitingPageCard.vue';
import { ApiError } from '../src/api';
import { useSession } from '../src/stores/session';
import type { WaitingPageView } from '../src/waiting-page';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});

const calls: { path: string; init?: RequestInit }[] = [];
let answer: (path: string, init?: RequestInit) => unknown;
vi.mock('../src/api', async (original) => ({
  ...(await original<typeof import('../src/api')>()),
  api: vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    const out = answer(path, init);
    if (out instanceof Error) throw out;
    return structuredClone(out);
  }),
}));

const FAVICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=';
const view = (over: Partial<WaitingPageView> = {}): WaitingPageView => ({
  own: { mode: 'template', title: 'Shop' },
  inherited: { mode: 'template', icon: 'none', from: { mode: 'organization', icon: 'organization' } },
  effective: { mode: 'template', icon: 'none', title: 'Shop', description: 'Naps at night.', from: { mode: 'workload', icon: 'organization', title: 'workload', description: 'router' } },
  from: { mode: 'workload', icon: 'organization', title: 'workload', description: 'router' },
  favicon: { icon: FAVICON, fetchedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), error: null },
  warnings: [], terraform: false, by: 'fab@example.com', at: new Date(Date.now() - 86_400_000).toISOString(), ...over,
});
const PATH = '/workloads/r/w/waiting-page';

const mounted: ReturnType<typeof mount>[] = [];
async function show(role: 'viewer' | 'operator' | 'admin' | 'member', level: 'workload' | 'router' | 'organization' = 'workload', path = PATH) {
  setActivePinia(createPinia());
  useSession().role = role;
  const w = mount(WaitingPageCard, { props: { level, path, subject: 'shop' }, attachTo: document.body, global: { plugins: [createVuetify({ components, directives })] } });
  mounted.push(w);
  await flushPromises();
  return w;
}
beforeEach(() => { calls.length = 0; answer = () => view(); });
afterEach(() => { while (mounted.length) mounted.pop()!.unmount(); });
const button = (label: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
const frame = (root: ParentNode = document.body) => root.querySelector('iframe') as HTMLIFrameElement;

describe('WaitingPageCard', () => {
  it('shows the mode, each field with the level it comes from, the cached favicon with its age, and a sandboxed preview', async () => {
    const w = await show('viewer');
    const text = w.text();
    expect(text).toContain('Template');
    expect(w.get('[data-test="field-title"]').text()).toMatch(/Shop.*This workload/);
    expect(w.get('[data-test="field-description"]').text()).toMatch(/Naps at night\..*Router/);
    expect(w.get('[data-test="field-icon"]').text()).toMatch(/None.*Organization/);
    expect(w.get('[data-test="favicon"]').text()).toContain('3 h ago');
    expect(w.get('[data-test="favicon"] img').attributes('src')).toBe(FAVICON);
    const f = frame(w.element);
    expect(f.getAttribute('sandbox')).toBe('');
    expect(f.getAttribute('srcdoc')).toContain('<h1>Shop</h1>');
  });

  it('gives the reason a workload has no favicon', async () => {
    answer = () => view({ favicon: { icon: null, fetchedAt: '2026-11-01T10:00:00Z', error: 'no host name' } });
    expect((await show('viewer')).get('[data-test="favicon"]').text()).toContain('no host name');
  });

  it('shows a custom page by its size and where it comes from, and its warnings', async () => {
    answer = () => view({
      own: null, effective: { mode: 'custom', html: '<!doctype html><p>x</p>', from: { mode: 'organization', html: 'organization' } }, from: { mode: 'organization', html: 'organization' },
      warnings: ['the page has no element data-dormeto="status": the visitor will not read why it waits'],
    });
    const w = await show('viewer');
    expect(w.text()).toContain('Custom HTML');
    expect(w.text()).toContain('Organization');
    expect(w.text()).toContain('data-dormeto="status"');
  });

  it('is read-only for a viewer and a member: no Edit, no Reset', async () => {
    for (const role of ['viewer', 'member'] as const) {
      const w = await show(role);
      expect(w.find('[data-test="edit-waiting-page"]').exists()).toBe(false);
      expect(w.find('[data-test="reset-waiting-page"]').exists()).toBe(false);
    }
  });

  it('is read-only for a Terraform workload and names the variable', async () => {
    answer = () => view({ terraform: true, by: null });
    const w = await show('admin');
    expect(w.find('[data-test="edit-waiting-page"]').exists()).toBe(false);
    expect(w.get('[data-test="waiting-page-reason"]').text()).toContain('waiting_page');
    expect(w.text()).toContain('Terraform');
  });

  it('gives an operator the reason, not the buttons, on a stored custom page', async () => {
    answer = () => view({ own: { mode: 'custom', html: '<p>x</p>' }, effective: { mode: 'custom', html: '<p>x</p>', from: { mode: 'workload', html: 'workload' } }, from: { mode: 'workload', html: 'workload' } });
    const w = await show('operator');
    expect(w.find('[data-test="edit-waiting-page"]').exists()).toBe(false);
    expect(w.find('[data-test="reset-waiting-page"]').exists()).toBe(false);
    expect(w.get('[data-test="waiting-page-reason"]').text()).toContain('only an administrator');
    expect((await show('admin')).find('[data-test="edit-waiting-page"]').exists()).toBe(true);
  });

  it('says calmly that a member\'s read is refused, or that the router must be upgraded, and keeps the page up', async () => {
    answer = () => new ApiError(403, 'forbidden');
    const forbidden = await show('member');
    expect(forbidden.get('[data-test="waiting-page-unavailable"]').text()).toMatch(/not available/i);
    expect(forbidden.find('[data-test="edit-waiting-page"]').exists()).toBe(false);
    answer = () => new ApiError(409, 'upgrade the router to 0.35.0');
    const old = await show('admin');
    expect(old.get('[data-test="waiting-page-unavailable"]').text()).toContain('upgrade the router to 0.35.0');
    expect(old.find('[data-test="edit-waiting-page"]').exists()).toBe(false);
    answer = () => new Error('boom');
    expect((await show('admin')).get('[data-test="waiting-page-unavailable"]').text()).toContain('boom');
  });

  it('labels the organization\'s card Organization and shows its page', async () => {
    answer = () => ({ page: { mode: 'template', title: 'Acme', icon: 'none' }, warnings: [], updatedAt: '2026-11-01T10:00:00Z', updatedBy: 'fab@example.com' });
    const w = await show('viewer', 'organization', '/settings/waiting-page');
    expect(w.get('[data-test="waiting-page-level"]').text()).toBe('Organization');
    expect(w.get('[data-test="field-title"]').text()).toContain('Acme');
    expect(frame(w.element).getAttribute('srcdoc')).toContain('Acme');
  });

  it('does not offer Edit on the organization or router levels to an operator', async () => {
    expect((await show('operator', 'router', '/routers/r/waiting-page')).find('[data-test="edit-waiting-page"]').exists()).toBe(false);
  });

  it('resets its level with a DELETE after a confirmation', async () => {
    const w = await show('operator');
    await w.get('[data-test="reset-waiting-page"]').trigger('click');
    await flushPromises();
    expect(calls.some((c) => c.init?.method === 'DELETE')).toBe(false);
    (document.body.querySelector('[data-test="confirm-reset-waiting-page"]') as HTMLButtonElement).click();
    await flushPromises();
    expect(calls.filter((c) => c.init?.method === 'DELETE')).toEqual([{ path: PATH, init: { method: 'DELETE' } }]);
  });
});
