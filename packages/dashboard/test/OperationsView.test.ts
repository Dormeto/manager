import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import OperationsView from '../src/views/OperationsView.vue';

const operation = (id: string, step: string) => ({
  id, type: 'upgrade-router', target: { router: 'dmtr-dev-eu-west-3' }, input: {}, status: 'running', cursor: 1, by: 'ops@example.com',
  createdAt: '2026-10-07T06:00:00.000Z', updatedAt: '2026-10-07T06:00:00.000Z',
  // A finished step shows only in the expanded row (the progress column names the current one).
  steps: [{ name: step, status: 'done' }, { name: 'install functions', status: 'running' }],
});
// jsdom has no ResizeObserver, which the Vuetify data table uses.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
vi.mock('../src/api', () => ({ api: vi.fn(async () => ({ operations: [operation('op-1', 'step of the first'), operation('op-2', 'step of the second')] })) }));

describe('Operations view', () => {
  it('opens the operation a link names, with its steps', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/operations', component: OperationsView }] });
    await router.push('/operations?id=op-2');
    const wrapper = mount(OperationsView, { global: { plugins: [createVuetify({ components }), pinia, router] } });
    await flushPromises();
    expect(wrapper.text()).toContain('step of the second');
    expect(wrapper.text()).not.toContain('step of the first');
    wrapper.unmount();
  });
});
