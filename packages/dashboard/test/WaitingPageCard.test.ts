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
    const out = await answer(path, init);
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
  const w = mount(WaitingPageCard, { props: { level, path, subject: 'shop', onNotice: (n: { type: string; text: string }) => notices.push(n) }, attachTo: document.body, global: { plugins: [createVuetify({ components, directives })] } });
  mounted.push(w);
  await flushPromises();
  return w;
}
beforeEach(() => { calls.length = 0; notices.length = 0; answer = () => view(); });
afterEach(() => { while (mounted.length) mounted.pop()!.unmount(); });
const button = (label: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
const notices: { type: string; text: string }[] = [];
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
    const auto = { mode: 'template' as const, icon: 'auto', title: 'Shop', from: { mode: 'workload', icon: 'default', title: 'workload' } };
    answer = () => view({ effective: auto, favicon: { icon: null, fetchedAt: '2026-11-01T10:00:00Z', error: 'no rule for the whole of a host name' } });
    expect((await show('viewer')).get('[data-test="favicon"]').text()).toContain('no rule for the whole of a host name');
    answer = () => view({ effective: auto, favicon: null });
    expect((await show('viewer')).get('[data-test="favicon"]').text()).toContain('not read yet');
    answer = () => view({ favicon: null });
    expect((await show('viewer')).get('[data-test="favicon"]').text()).toContain('not read: the icon is none');
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

  it('reads the organization\'s page for the dialog when a custom page sits between it and the workload', async () => {
    const org = { page: { mode: 'template', title: 'ORG-T', description: 'ORG-D' }, warnings: [], by: 'fab@example.com', at: '2026-11-01T10:00:00Z' };
    answer = (path) => (path === '/settings/waiting-page' ? org : view({ own: null, inherited: { mode: 'custom', html: '<p>x</p>', from: { mode: 'router', html: 'router' } } }));
    const w = await show('admin');
    expect(calls.map((c) => c.path)).toContain('/settings/waiting-page');
    await w.get('[data-test="edit-waiting-page"]').trigger('click');
    await flushPromises();
    const preview = document.body.querySelector('[data-test="waiting-page-dialog"] iframe')!.getAttribute('srcdoc');
    expect(preview).toContain('<h1>ORG-T</h1>');
    expect(preview).toContain('ORG-D');
  });

  it('does not read the organization\'s page when nothing custom is in the middle, and goes without it when it cannot be read', async () => {
    await show('admin');
    expect(calls.map((c) => c.path)).toEqual([PATH]);
    calls.length = 0;
    answer = (path) => (path === '/settings/waiting-page' ? new ApiError(403, 'no') : view({ own: null, inherited: { mode: 'custom', html: '<p>x</p>', from: { mode: 'router', html: 'router' } } }));
    const w = await show('admin');
    expect(w.find('[data-test="waiting-page-unavailable"]').exists()).toBe(false);
  });

  it('labels the organization\'s card Organization and shows its page', async () => {
    answer = () => ({ page: { mode: 'template', title: 'Acme', icon: 'none' }, warnings: [], at: '2026-11-01T10:00:00Z', by: 'fab@example.com' });
    const w = await show('viewer', 'organization', '/settings/waiting-page');
    expect(w.get('[data-test="waiting-page-level"]').text()).toBe('Organization');
    expect(w.get('[data-test="field-title"]').text()).toContain('Acme');
    expect(w.text()).toContain('fab@example.com');
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

  it('shows a member who may read the workload its page, read-only', async () => {
    const w = await show('member');
    expect(w.find('[data-test="waiting-page-unavailable"]').exists()).toBe(false);
    expect(w.get('[data-test="field-title"]').text()).toContain('Shop');
    expect(w.find('[data-test="edit-waiting-page"]').exists()).toBe(false);
    expect(w.find('[data-test="reset-waiting-page"]').exists()).toBe(false);
  });

  it('never draws a custom page in the card: its size and who set it, and no frame', async () => {
    answer = () => view({
      own: { mode: 'custom', html: 'x'.repeat(2048) }, effective: { mode: 'custom', html: 'x'.repeat(2048), from: { mode: 'workload', html: 'workload' } }, from: { mode: 'workload', html: 'workload' },
    });
    const w = await show('admin');
    expect(w.find('iframe').exists()).toBe(false);
    expect(w.get('[data-test="field-mode"]').text()).toContain('Custom HTML (2.0 KiB)');
    expect(w.text()).toContain('Set by fab@example.com');
  });

  it('says the size of a small custom page in bytes', async () => {
    answer = () => view({ own: null, effective: { mode: 'custom', html: '<!doctype html><p>wait</p>', from: { mode: 'organization', html: 'organization' } }, from: { mode: 'organization', html: 'organization' } });
    expect((await show('viewer')).get('[data-test="field-mode"]').text()).toContain('Custom HTML (26 bytes)');
  });

  it('hides the template\'s mini preview from assistive technology, since the fields say it', async () => {
    const w = await show('viewer');
    expect(w.get('.dm-wp-frame').attributes('aria-hidden')).toBe('true');
  });

  it('lets an administrator reset a page the manager left on a Terraform workload, not one Terraform wrote', async () => {
    answer = () => view({ terraform: true, by: 'ops@example.com' });
    const left = await show('admin');
    expect(left.find('[data-test="edit-waiting-page"]').exists()).toBe(false);
    expect(left.find('[data-test="reset-waiting-page"]').exists()).toBe(true);
    expect(left.get('[data-test="waiting-page-reason"]').text()).toContain('waiting_page');
    answer = () => view({ terraform: true, by: null });
    expect((await show('admin')).find('[data-test="reset-waiting-page"]').exists()).toBe(false);
  });

  describe('Edit to Save', () => {
    const edit = async (w: Awaited<ReturnType<typeof show>>, title: string) => {
      await w.get('[data-test="edit-waiting-page"]').trigger('click');
      await flushPromises();
      const input = document.body.querySelector('[data-test="title"] input') as HTMLInputElement;
      input.value = title;
      input.dispatchEvent(new Event('input'));
      await flushPromises();
    };
    const save = async () => {
      ([...document.body.querySelectorAll('[data-test="waiting-page-dialog"] button')].find((b) => b.textContent?.trim() === 'Save') as HTMLButtonElement).click();
      await flushPromises();
    };
    const dialogOpen = (w: Awaited<ReturnType<typeof show>>) => w.findComponent({ name: 'WaitingPageDialog' }).props('modelValue');

    it('sends the page as PUT { page }, closes, reloads, says when visitors see it, and shows the warnings the router gives', async () => {
      let stored = view();
      answer = (path, init) => {
        if (init?.method === 'PUT') { stored = view({ own: JSON.parse(String(init.body)).page, warnings: ['the page has no element data-dormeto="status": the visitor will not read why it waits'] }); return stored; }
        return stored;
      };
      const w = await show('admin');
      await edit(w, 'Acme shop');
      await save();
      const put = calls.find((c) => c.init?.method === 'PUT')!;
      expect(put.path).toBe(PATH);
      expect(JSON.parse(String(put.init!.body))).toEqual({ page: { mode: 'template', title: 'Acme shop' } });
      expect(dialogOpen(w)).toBe(false);
      expect(w.text()).toContain('data-dormeto="status"');
      expect(notices.at(-1)).toMatchObject({ type: 'success', text: expect.stringContaining('within about a minute') });
      expect(notices.at(-1)!.text).not.toMatch(/5 minutes|6 minutes/);
    });

    it('says within about a minute at the organization too', async () => {
      answer = () => ({ page: null, warnings: [], at: null, by: null });
      const w = await show('admin', 'organization', '/settings/waiting-page');
      await edit(w, 'Acme');
      await save();
      expect(notices.at(-1)!.text).toContain('within about a minute');
      expect(w.text()).not.toMatch(/5 minutes/);
    });

    for (const [status, message] of [[400, 'title must be at most 80 characters'], [403, 'your role cannot change a custom page'], [409, 'workload w was written by Terraform: set waiting_page in its workload module']] as const) {
      it(`keeps the dialog open and shows a ${status} from the save`, async () => {
        answer = (path, init) => (init?.method === 'PUT' ? Object.assign(new Error(message), { status }) : view());
        const w = await show('admin');
        await edit(w, 'x');
        await save();
        expect(dialogOpen(w)).toBe(true);
        expect(document.body.querySelector('[data-test="waiting-page-error"]')!.textContent).toContain(message);
        expect(notices).toEqual([]);
      });
    }

    it('keeps the card when the reload after a save fails', async () => {
      let puts = 0;
      answer = (path, init) => {
        if (init?.method === 'PUT') { puts += 1; return view(); }
        return puts ? new Error('timeout') : view();
      };
      const w = await show('admin');
      await edit(w, 'x');
      await save();
      expect(w.find('[data-test="field-title"]').exists()).toBe(true);
      expect(w.get('[data-test="waiting-page-stale"]').text()).toContain('timeout');
    });
  });

  it('keeps the newest answer when the path changes while an older read is slow', async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    answer = (path) => (path === '/workloads/a/x/waiting-page' ? slow.then(() => view({ own: { mode: 'template', title: 'OLD' }, effective: { mode: 'template', icon: 'none', title: 'OLD', from: { mode: 'workload', title: 'workload' } } })) : view({ effective: { mode: 'template', icon: 'none', title: 'NEW', from: { mode: 'workload', title: 'workload' } } }));
    const w = await show('viewer', 'workload', '/workloads/a/x/waiting-page');
    await w.setProps({ path: '/workloads/a/y/waiting-page' });
    await flushPromises();
    release();
    await flushPromises();
    expect(w.get('[data-test="field-title"]').text()).toContain('NEW');
  });
});
