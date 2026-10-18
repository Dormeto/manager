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

  it('shows a manager update as such: its kind, "manager <version>", and the link to its build in CodeBuild', async () => {
    const saved = operations;
    const url = 'https://eu-west-1.console.aws.amazon.com/codesuite/codebuild/121014831971/projects/dmt-dev-install/build/dmt-dev-install%3Ab2/?region=eu-west-1';
    const update = (id: string, context: Record<string, unknown>) => ({
      id, type: 'update-manager', target: { account: '121014831971', region: 'eu-west-1', version: '0.13.0' }, input: { action: 'apply', version: '0.13.0', request: 'r', planBuild: 'p' },
      status: 'succeeded', cursor: 0, by: 'admin@example.com', createdAt: '2026-10-18T10:00:00.000Z', updatedAt: '2026-10-18T10:09:00.000Z', finishedAt: '2026-10-18T10:09:00.000Z',
      steps: [{ name: 'Apply manager 0.13.0', status: 'done' }], context,
    });
    operations = [update('op-u', { build: 'dmt-dev-install:b2', consoleUrl: url })];
    const wrapper = await mountView();
    expect(wrapper.find('.dm-op__kind').text()).toBe('Manager update');
    expect(wrapper.find('.dm-op__title').text()).toBe('Update the manager to 0.13.0');
    expect(wrapper.find('.dm-op__target').text()).toContain('manager 0.13.0');
    const link = wrapper.findAll('a').find((a) => a.text() === 'View the build in CodeBuild')!;
    expect(link.attributes()).toMatchObject({ href: url, target: '_blank', rel: 'noopener' });
    wrapper.unmount();
    // None before its build is known, nor for a link that is not https.
    operations = [update('op-a', {}), update('op-b', { build: 'b', consoleUrl: 'javascript:alert(1)' })];
    const without = await mountView();
    expect(without.text()).not.toContain('View the build in CodeBuild');
    without.unmount();
    operations = saved;
  });

  it('links no other operation to CodeBuild', async () => {
    const saved = operations;
    operations = [{ ...operation('op-1', 'x'), context: { consoleUrl: 'https://eu-west-1.console.aws.amazon.com/x' } }];
    const wrapper = await mountView();
    expect(wrapper.text()).not.toContain('View the build in CodeBuild');
    expect(wrapper.find('.dm-op__kind').text()).toBe('upgrade router');
    wrapper.unmount();
    operations = saved;
  });
});
