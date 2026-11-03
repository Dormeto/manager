// The organization's settings on the Workload defaults card (vision settings at scale design §9): what it sets, edited by administrators.
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import WorkloadDefaultsCard from '../src/components/WorkloadDefaultsCard.vue';
import DefaultsDialog from '../src/components/DefaultsDialog.vue';
import { api } from '../src/api';
import { useSession } from '../src/stores/session';

let doc: Record<string, unknown> = {};
vi.mock('../src/api', () => ({
  api: vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/settings/workloads' && init?.method === 'PUT') return { ...doc, defaults: JSON.parse(String(init.body)).defaults, note: 'routers apply it at their next check, within 5 minutes' };
    if (path === '/settings/workloads') return doc;
    return { workloads: 0, keys: {} };
  }),
}));
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});

async function mountCard(role: 'admin' | 'viewer', defaults: Record<string, unknown>) {
  doc = { hibernate: true, joinMinutes: null, endedWindowDays: null, defaults, updatedAt: null, updatedBy: null };
  setActivePinia(createPinia());
  useSession().role = role;
  const wrapper = mount(WorkloadDefaultsCard, { attachTo: document.body, global: { plugins: [createVuetify({ components, directives })] } });
  await flushPromises();
  return wrapper;
}

describe('the organization\'s settings on the Workload defaults card', () => {
  it('says what the organization sets, or the built-in values', async () => {
    const set = await mountCard('viewer', { idleMinutes: 30, wakeMode: 'browser' });
    expect(set.find('[data-test="default-settings-value"]').text()).toBe('Idle window 30 min · Wake mode browser');
    expect(set.find('[data-test="edit-settings"]').exists()).toBe(false);
    set.unmount();
    const none = await mountCard('viewer', {});
    expect(none.find('[data-test="default-settings-value"]').text()).toBe('Built-in values');
    none.unmount();
  });

  it('lets an administrator change them: only the defaults are sent', async () => {
    const wrapper = await mountCard('admin', { idleMinutes: 30 });
    await wrapper.find('[data-test="edit-settings"]').trigger('click');
    await flushPromises();
    const dialog = wrapper.findComponent(DefaultsDialog);
    expect(dialog.props()).toMatchObject({ level: 'organization', values: { idleMinutes: 30 } });
    vi.mocked(api).mockClear();
    dialog.vm.$emit('submit', { idleMinutes: null, waitSeconds: 20 });
    await flushPromises();
    expect(vi.mocked(api).mock.calls[0]).toEqual(['/settings/workloads', { method: 'PUT', body: JSON.stringify({ defaults: { idleMinutes: null, waitSeconds: 20 } }) }]);
    expect(wrapper.emitted('notice')![0]![0]).toMatchObject({ type: 'success' });
    wrapper.unmount();
  });
});
