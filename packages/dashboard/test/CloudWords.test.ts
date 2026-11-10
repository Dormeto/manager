import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import GroupsCard from '../src/components/GroupsCard.vue';
import RenameDialog from '../src/components/RenameDialog.vue';
import OperationsView from '../src/views/OperationsView.vue';
import RoutersView from '../src/views/RoutersView.vue';

// The words of the places that don't switch on a row's cloud (a page, a card) name both clouds, and a dialog about one workload
// names its own cloud's (M28, design 6.5).
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});
vi.mock('../src/api', () => ({ api: vi.fn(async (path: string) => (path.startsWith('/operations') ? { operations: [] } : { routers: [], ipLists: [] })) }));

const mounted: ReturnType<typeof mount>[] = [];
afterEach(() => { while (mounted.length) mounted.pop()!.unmount(); });
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
const vuetify = () => createVuetify({ components, directives });

describe('RenameDialog', () => {
  const open = (cloud?: 'aws' | 'gcp') => {
    const w = mount(RenameDialog, { props: { modelValue: true, name: 'shop', ...(cloud ? { cloud } : {}) }, attachTo: document.body, global: { plugins: [vuetify()] } });
    mounted.push(w);
    return squash(document.body.textContent ?? '');
  };

  it('says nothing changes in Google Cloud for a Google Cloud workload', () => {
    const text = open('gcp');
    expect(text).toContain('Nothing changes in Google Cloud.');
    expect(text).not.toContain('Nothing changes in AWS');
  });

  it('keeps AWS\'s sentence for an AWS workload', () => {
    expect(open('aws')).toContain('Nothing changes in AWS.');
  });
});

describe('GroupsCard', () => {
  it('says the tags are set on the workloads, in neither cloud', async () => {
    const w = mount(GroupsCard, { props: { groups: [], users: [] }, attachTo: document.body, global: { plugins: [vuetify()] } });
    mounted.push(w);
    await w.find('[data-test="new-group"]').trigger('click');
    await flushPromises();
    expect(squash(document.body.textContent ?? '')).toContain('Tags are set on the workloads, not in AWS or Google Cloud.');
  });
});

async function mountView(view: typeof OperationsView | typeof RoutersView, path: string) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path, component: view }] });
  await router.push(path);
  const w = mount(view, { attachTo: document.body, global: { plugins: [vuetify(), pinia, router] } });
  mounted.push(w);
  await flushPromises();
  return w;
}

describe('the Operations view', () => {
  it('says its steps are AWS or Google Cloud API calls', async () => {
    const w = await mountView(OperationsView, '/operations');
    const lead = squash(w.find('.dm-lead').text());
    expect(lead).toContain('in the target account or project and region by AWS or Google Cloud API calls');
  });
});

describe('the Routers view', () => {
  it('names an AWS account and a Google Cloud project in what a router is', async () => {
    const w = await mountView(RoutersView, '/routers');
    const more = w.find('[data-test="routers-more"]');
    await more.trigger('mouseenter');
    await flushPromises();
    const tip = squash(document.querySelector('[data-test="routers-tip"]')?.textContent ?? '');
    expect(tip).toContain('One router per AWS account and region, or per Google Cloud project and region, naps and wakes its workloads.');
    expect(tip).toContain('health comes from its idle check and, on AWS, its Lambda functions and its failure queues.');
  });
});
