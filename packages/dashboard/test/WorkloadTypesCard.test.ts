// The organization's workload types (vision settings at scale design §5, §9): the built-in ones and the custom ones, their
// selector and defaults; administrators add, change, order and remove the custom ones, and set any type's defaults.
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import WorkloadTypesCard from '../src/components/WorkloadTypesCard.vue';
import DefaultsDialog from '../src/components/DefaultsDialog.vue';
import { api } from '../src/api';
import { useSession } from '../src/stores/session';

const API = { name: 'api', description: 'Public APIs', tags: { kind: 'api' }, settings: { idleMinutes: 30 } };
const WEB = { name: 'web', tags: { team: 'shop' }, settings: {} };
let types: Record<string, unknown>[] = [];
const puts: unknown[] = [];
vi.mock('../src/api', () => ({
  api: vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/settings/types' && init?.method === 'PUT') {
      const sent = JSON.parse(String(init.body)).types;
      puts.push(sent);
      types = sent;
      return { types: sent, builtIn: ['instance', 'asg', 'ecs', 'k8s', 'databases'], note: 'routers apply it at their next check, within 5 minutes' };
    }
    if (path === '/settings/types') return { types, builtIn: ['instance', 'asg', 'ecs', 'k8s', 'databases'], updatedAt: null, updatedBy: null };
    if (path.startsWith('/settings/reach')) return { workloads: path.endsWith('name=api') ? 4 : 1, keys: {} };
    return {};
  }),
}));
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});

async function mountCard(role: 'admin' | 'viewer', stored: Record<string, unknown>[] = [API, { name: 'databases', settings: { idleMinutes: 45 } }]) {
  types = stored;
  puts.length = 0;
  setActivePinia(createPinia());
  useSession().role = role;
  const wrapper = mount(WorkloadTypesCard, { attachTo: document.body, global: { plugins: [createVuetify({ components, directives })] } });
  await flushPromises();
  return wrapper;
}
const typeField = (name: string) => document.querySelector(`[data-test="type-${name}"] input, [data-test="type-${name}"] textarea`) as HTMLInputElement;
const fill = async (name: string, value: string) => {
  const el = typeField(name);
  el.value = value;
  el.dispatchEvent(new Event('input'));
  await flushPromises();
};

describe('WorkloadTypesCard', () => {
  it('lists the custom types first, then the built-in ones, each with its selector, its defaults and its workloads', async () => {
    const wrapper = await mountCard('admin');
    expect(wrapper.findAll('[data-test="type-row"]').map((r) => r.attributes('data-name'))).toEqual(['api', 'instance', 'asg', 'ecs', 'k8s', 'databases']);
    const api = wrapper.find('[data-name="api"]');
    expect(api.text()).toContain('kind=api');
    expect(api.text()).toContain('Idle window 30 min');
    expect(api.text()).toContain('4 workloads');
    expect(wrapper.find('[data-name="databases"]').text()).toContain('Idle window 45 min');
    expect(wrapper.find('[data-name="ecs"]').text()).toContain('No defaults');
    wrapper.unmount();
  });

  it('adds a custom type selected by tags; refuses a built-in name, nothing sent', async () => {
    const wrapper = await mountCard('admin');
    await wrapper.find('[data-test="add-type"]').trigger('click');
    await flushPromises();
    await fill('name', 'ecs');
    await fill('tags', 'team=shop');
    (document.querySelector('[data-test="save-type"]') as HTMLButtonElement).click();
    await flushPromises();
    expect(document.querySelector('[data-test="type-problem"]')!.textContent).toContain('ecs is a built-in type');
    expect(puts).toEqual([]);
    await fill('name', 'web');
    (document.querySelector('[data-test="save-type"]') as HTMLButtonElement).click();
    await flushPromises();
    expect(puts).toEqual([[API, { name: 'databases', settings: { idleMinutes: 45 } }, WEB]]);
    wrapper.unmount();
  });

  it('sets a built-in type\'s defaults, removes and moves a custom one', async () => {
    const wrapper = await mountCard('admin', [API, WEB]);
    await wrapper.find('[data-name="ecs"] [data-test="edit-defaults"]').trigger('click');
    await flushPromises();
    const dialog = wrapper.findComponent(DefaultsDialog);
    expect(dialog.props()).toMatchObject({ level: 'type', name: 'ecs', values: {} });
    dialog.vm.$emit('submit', { idleMinutes: 20 });
    await flushPromises();
    expect(puts.at(-1)).toEqual([API, WEB, { name: 'ecs', settings: { idleMinutes: 20 } }]);
    await wrapper.find('[data-name="web"] [data-test="move-up"]').trigger('click');
    await flushPromises();
    expect((puts.at(-1) as { name: string }[]).map((t) => t.name)).toEqual(['web', 'api', 'ecs']);
    await wrapper.find('[data-name="api"] [data-test="remove-type"]').trigger('click');
    await flushPromises();
    expect((puts.at(-1) as { name: string }[]).map((t) => t.name)).toEqual(['web', 'ecs']);
    wrapper.unmount();
  });

  it('shows a viewer the types, without a button', async () => {
    const wrapper = await mountCard('viewer');
    expect(wrapper.findAll('[data-test="type-row"]')).toHaveLength(6);
    expect(wrapper.find('[data-test="add-type"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="edit-defaults"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
