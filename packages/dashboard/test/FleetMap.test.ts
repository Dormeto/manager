// The fleet at a glance (FleetMap.vue, PR #1's review): the logos of the first workloads only, one request capped, each
// router's count from the routers the Overview already has, "+N more" to the router's workloads; the dots out of the tab
// order.
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import FleetMap from '../src/components/FleetMap.vue';
import type { RouterInfo } from '../src/types';

const paths: string[] = [];
// dmtr-a: 150 workloads (100 asleep, 49 awake, 1 failed), the first 96 listed; dmtr-b: 3, none listed.
const listed = Array.from({ length: 96 }, (_, i) => ({ router: 'dmtr-a', workloadId: `w${String(i).padStart(3, '0')}`, name: `app-${String(i).padStart(3, '0')}`, state: i < 60 ? 'ASLEEP' : 'AWAKE' }));
vi.mock('../src/api', () => ({
  api: vi.fn(async (path: string) => {
    paths.push(path);
    const limit = Number(new URLSearchParams(path.split('?')[1]).get('limit') || 1000);
    return { workloads: listed.slice(0, limit), total: 153 };
  }),
}));
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
const ROUTERS: RouterInfo[] = [
  { name: 'dmtr-a', region: 'eu-west-1', workloads: 150, workloadStates: { ASLEEP: 100, AWAKE: 49, FAILED: 1 } },
  { name: 'dmtr-b', region: 'eu-west-3', workloads: 3, workloadStates: { ASLEEP: 3 } },
];

async function mountMap(routers = ROUTERS) {
  setActivePinia(createPinia());
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] });
  const wrapper = mount(FleetMap, { props: { routers }, attachTo: document.body, global: { plugins: [createVuetify({ components, directives }), router] } });
  await flushPromises();
  return wrapper;
}

describe('FleetMap', () => {
  it('asks the API for the logos it shows only, never every workload', async () => {
    paths.length = 0;
    const wrapper = await mountMap();
    expect(paths).toEqual(['/workloads?limit=96']);
    expect(wrapper.findAll('a.dm-map__icon')).toHaveLength(96);
    wrapper.unmount();
  });

  it('counts each router\'s workloads from the routers, "+N more" linking to its workloads', async () => {
    const wrapper = await mountMap();
    const rows = wrapper.findAll('.dm-map__router');
    expect(rows.map((r) => r.find('.dm-map__n').text())).toEqual(['150', '3']);
    const more = wrapper.findAll('a.dm-map__all');
    expect(more.map((a) => [a.text(), a.attributes('href')])).toEqual([['+54 more', '/workloads?router=dmtr-a'], ['+3 more', '/workloads?router=dmtr-b']]);
    expect(more[0]!.attributes('aria-label')).toBe('54 more workloads of dmtr-a');
    wrapper.unmount();
  });

  it('keeps the dots out of the tab order and of assistive technologies: one link per router stays', async () => {
    const wrapper = await mountMap();
    const dots = wrapper.findAll('.dm-map__more');
    // dmtr-a's 54 not shown (40 asleep, 13 awake, 1 failed, from its counts less its logos), dmtr-b's 3.
    expect(dots).toHaveLength(57);
    expect(dots.filter((d) => d.classes('bg-error'))).toHaveLength(1);
    for (const dot of dots) {
      expect(dot.element.tagName).toBe('SPAN');
      expect(dot.element.closest('[aria-hidden="true"]')).not.toBeNull();
      expect(dot.attributes('tabindex')).toBeUndefined();
    }
    wrapper.unmount();
  });
});
