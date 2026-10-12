import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import WorkloadsView from '../src/views/WorkloadsView.vue';

const paths: string[] = [];
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
vi.mock('../src/api', () => ({ api: vi.fn(async (path: string) => { paths.push(path); return { workloads: [], total: 0, errors: [] }; }) }));

describe('Workloads view', () => {
  it('lists the workloads of one router in one state when the address names them, and shows the filter', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/workloads', component: WorkloadsView }] });
    await router.push('/workloads?router=dmt-dev&state=ASLEEP');
    const wrapper = mount(WorkloadsView, { global: { plugins: [createVuetify({ components }), pinia, router] } });
    await flushPromises();
    const query = new URLSearchParams(paths[0]!.split('?')[1]);
    expect(query.get('router')).toBe('dmt-dev');
    expect(query.get('state')).toBe('ASLEEP');
    expect(wrapper.text()).toContain('dmt-dev');
    expect(wrapper.text().toLowerCase()).toContain('asleep');
    wrapper.unmount();
  });
});
