// The calendars panel with an organization's worth of workloads (the user, 2026-11-02: 1,000 workloads, 500 scheduled): it draws
// the rows in sight only, in name order, and stays where it is when a tick is refused.
import { describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import CalendarsPanel from '../src/components/CalendarsPanel.vue';
import { MAX_CALENDARS, type PanelRow } from '../src/calendars';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const rows: PanelRow[] = Array.from({ length: 1000 }, (_, i) => ({ key: `r/w-${i}`, id: `w-${i}`, router: 'r', name: `w-${i}`, scheduled: i % 2 === 0, supported: true, locked: false }));
const enabledOf = (n: number) => Object.fromEntries(rows.slice(0, n).map((r, i) => [r.key, i]));
const mountPanel = (enabled: Record<string, number> = {}) => mount(CalendarsPanel, { props: { rows, enabled, status: {} }, attachTo: document.body, global: { plugins: [createVuetify({ components, directives })] } });
const drawn = (w: ReturnType<typeof mountPanel>) => w.findAll('[data-test^="calendar-r/"]').map((r) => r.attributes('data-test')!.slice('calendar-r/'.length));

describe('Calendars panel: many workloads', () => {
  it('draws the rows in sight only, of 500 scheduled ones, in name order', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    expect(drawn(wrapper).length).toBeGreaterThan(0);
    expect(drawn(wrapper).length).toBeLessThan(40);
    expect(drawn(wrapper).slice(0, 3)).toEqual(['w-0', 'w-2', 'w-4']);
    wrapper.unmount();
  });

  it('a short list draws every row; a search finds a workload far down the long one', async () => {
    const wrapper = mountPanel();
    await wrapper.find('[data-test="panel-search"] input').setValue('w-998');
    await flushPromises();
    expect(drawn(wrapper)).toEqual(['w-998']);
    wrapper.unmount();
  });

  it('a tick refused past the limit is drawn again in its row, the list where it was', async () => {
    const wrapper = mountPanel(Object.fromEntries(rows.slice(-MAX_CALENDARS).map((r, i) => [r.key, i])));
    await flushPromises();
    const list = wrapper.findComponent({ name: 'VVirtualScroll' });
    expect(list.exists()).toBe(true);
    await wrapper.find('[data-test="calendar-r/w-0"] input').setValue(true);
    await flushPromises();
    expect(wrapper.emitted('toggle')).toEqual([['r/w-0']]);
    expect((wrapper.find('[data-test="calendar-r/w-0"] input').element as HTMLInputElement).checked).toBe(false);
    expect(wrapper.findComponent({ name: 'VVirtualScroll' }).vm.$.uid).toBe(list.vm.$.uid);
    wrapper.unmount();
  });
});
