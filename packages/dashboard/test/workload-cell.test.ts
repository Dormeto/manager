// The Workloads view's Workload cell (the user, 2026-11-21): every icon it can show has a tooltip in plain words and an
// accessible name; the kind's from the one definition of the kinds; the schedule's explains it. The Kind filter shows each
// kind's icon, in the list and in the selected value, in Workloads and Discovery.
import { describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import { VTooltip } from 'vuetify/components';
import { mdiServerOutline, mdiWeb } from '@mdi/js';
import { aliases, mdi } from 'vuetify/iconsets/mdi-svg';
import WorkloadCell from '../src/components/WorkloadCell.vue';
import KindSelect from '../src/components/KindSelect.vue';
import { KINDS } from '../src/kinds';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});
const router = () => createRouter({ history: createMemoryHistory(), routes: [{ path: '/:rest(.*)', component: { render: () => null } }] });
// The dashboard's icon set (SVG paths), as main.ts sets it.
const plugins = () => [createVuetify({ components, directives, icons: { defaultSet: 'mdi', aliases, sets: { mdi } } }), router()];
// A row that shows every icon the cell can show.
const EVERY = { router: 'dmt-dev', workloadId: 'a1b2', name: 'build-agent', kind: 'standalone', scheduled: true, summary: 'CI agent', state: 'AWAKE' };

describe('the Workload cell', () => {
  it('gives every icon it shows a tooltip and an accessible name', () => {
    const w = mount(WorkloadCell, { props: { item: EVERY as never }, global: { plugins: plugins() } });
    const icons = w.findAll('.v-icon');
    expect(icons.length).toBe(2);
    const tips = w.findAllComponents(VTooltip);
    // Each icon is a tooltip's activator: as many tooltips as icons, each with its text, each icon named.
    expect(tips.length).toBe(icons.length);
    for (const tip of tips) expect(String(tip.props('text'))).toMatch(/\w+: /);
    for (const icon of icons) expect(icon.attributes('aria-label'), icon.html()).toBeTruthy();
    expect(tips.map((t) => t.props('text'))).toEqual([
      'Standalone: a resource with no load balancer. A schedule, a person or a start made in AWS wakes it.',
      'Has a schedule: it naps and wakes at set hours (its Schedule card says when).',
    ]);
    expect(w.find('[data-test="scheduled"]').attributes('aria-label')).toBe('Has a schedule');
  });

  it('is quiet for an HTTP workload without a schedule: no icon', () => {
    const w = mount(WorkloadCell, { props: { item: { router: 'dmt-dev', workloadId: 'w1', name: 'shop', state: 'AWAKE' } as never }, global: { plugins: plugins() } });
    expect(w.findAll('.v-icon')).toHaveLength(0);
  });
});

describe('the Kind filter', () => {
  it('shows each kind\'s icon in its list and in the selected value, the web for HTTP, the server for standalone', async () => {
    expect(KINDS.map((k) => [k.value, k.icon])).toEqual([['http', mdiWeb], ['standalone', mdiServerOutline]]);
    const w = mount(KindSelect, { props: { modelValue: 'standalone' }, attachTo: document.body, global: { plugins: plugins() } });
    expect(w.find('[data-test="kind-selected"]').attributes('aria-label')).toBe('Standalone');
    expect(w.find('[data-test="kind-selected"] path').attributes('d')).toBe(mdiServerOutline);
    await w.find('.v-field').trigger('mousedown');
    await flushPromises();
    const items = [...document.querySelectorAll('[data-test="kind-item"]')];
    expect(items.map((i) => [i.textContent!.trim(), i.querySelector('path')?.getAttribute('d')])).toEqual([['HTTP', mdiWeb], ['Standalone', mdiServerOutline]]);
    w.unmount();
  });
});
