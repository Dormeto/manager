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
let operations: Record<string, unknown>[] = [operation('op-1', 'step of the first'), operation('op-2', 'step of the second')];
vi.mock('../src/api', () => ({ api: vi.fn(async () => ({ operations: structuredClone(operations) })) }));

async function mountView() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/operations', component: OperationsView }] });
  await router.push('/operations');
  const wrapper = mount(OperationsView, { global: { plugins: [createVuetify({ components }), pinia, router] } });
  await flushPromises();
  return wrapper;
}
const ids = (wrapper: Awaited<ReturnType<typeof mountView>>) => wrapper.findAll('.dm-op__id').map((e) => e.text());

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

  it('sorts by status, by whom and when it started, as the table did: ascending, descending, then newest first again (PR #1)', async () => {
    const saved = operations;
    // Newest first, as the API lists them.
    operations = [
      { ...operation('op-c', 'x'), status: 'running', by: 'bea@example.com', createdAt: '2026-10-07T08:00:00.000Z' },
      { ...operation('op-b', 'x'), status: 'failed', by: 'carl@example.com', createdAt: '2026-10-07T07:00:00.000Z' },
      { ...operation('op-a', 'x'), status: 'succeeded', by: 'ann@example.com', createdAt: '2026-10-07T06:00:00.000Z' },
    ];
    const wrapper = await mountView();
    const sort = async (title: string) => {
      await wrapper.findAll('[data-test="sort"]').find((b) => b.text().startsWith(title))!.trigger('click');
      await flushPromises();
    };
    expect(ids(wrapper)).toEqual(['op-c', 'op-b', 'op-a']);
    await sort('By');
    expect(ids(wrapper)).toEqual(['op-a', 'op-c', 'op-b']);
    await sort('By');
    expect(ids(wrapper)).toEqual(['op-b', 'op-c', 'op-a']);
    await sort('By');
    expect(ids(wrapper)).toEqual(['op-c', 'op-b', 'op-a']);
    await sort('Started');
    expect(ids(wrapper)).toEqual(['op-a', 'op-b', 'op-c']);
    await sort('Status');
    expect(ids(wrapper)).toEqual(['op-b', 'op-c', 'op-a']);
    expect(wrapper.find('[data-test="sort"][aria-pressed="true"]').text()).toContain('Status');
    operations = saved;
    wrapper.unmount();
  });

  it('shows 25 operations a page by default, and as many as chosen (PR #1)', async () => {
    const saved = operations;
    operations = Array.from({ length: 30 }, (_, i) => operation(`op-${String(i).padStart(2, '0')}`, 'x'));
    const wrapper = await mountView();
    expect(ids(wrapper)).toHaveLength(25);
    expect(wrapper.find('.v-pagination').exists()).toBe(true);
    const perPage = wrapper.findComponent({ name: 'VSelect' });
    await perPage.setValue(10);
    await flushPromises();
    expect(ids(wrapper)).toHaveLength(10);
    await perPage.setValue(-1);
    await flushPromises();
    expect(ids(wrapper)).toHaveLength(30);
    expect(wrapper.find('.v-pagination').exists()).toBe(false);
    operations = saved;
    wrapper.unmount();
  });
});
