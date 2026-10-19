import { describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import ScheduleCard from '../src/components/ScheduleCard.vue';
import ScheduleDialog from '../src/components/ScheduleDialog.vue';
import type { Schedule } from '../src/schedule';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});

const schedule: Schedule = {
  timeZone: 'Europe/Paris',
  windows: [
    { kind: 'awake', days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '08:30', end: '19:00' },
    { kind: 'nap', days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '20:00', end: '07:00', wake: 'header' },
  ],
  exceptions: ['2026-12-25'],
  maxNapDays: 7,
  by: 'ops@example.com', at: '2026-10-01T10:00:00.000Z',
};
const next = [{ at: '2026-10-20T05:00:00.000Z', kind: 'nap-end' as const, window: 1 }, { at: '2026-10-20T06:30:00.000Z', kind: 'awake-start' as const, window: 0 }];

function mountCard(props: Record<string, unknown>) {
  return mount(ScheduleCard, { props: { schedule, next, maintenanceDue: '2026-10-26T20:00:00.000Z', canEdit: true, ...props }, attachTo: document.body, global: { plugins: [createVuetify({ components, directives })] } });
}

describe('ScheduleCard', () => {
  it('shows the zone, the windows, the exceptions, the maximum nap and the next events', () => {
    const wrapper = mountCard({});
    const text = wrapper.text();
    expect(text).toContain('Europe/Paris');
    const rows = wrapper.findAll('[data-test="window"]').map((r) => r.text());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Awake');
    expect(rows[0]).toContain('Mon–Fri');
    expect(rows[0]).toContain('08:30–19:00');
    expect(rows[1]).toContain('Nap');
    expect(rows[1]).toContain('20:00–07:00 next day');
    expect(rows[1]).toContain('wakes with the header');
    expect(text).toContain('2026-12-25');
    expect(text).toContain('7 days');
    expect(wrapper.findAll('[data-test="next"]').map((r) => r.text())).toEqual(['Tue 20 Oct, 07:00 · nap window ends', 'Tue 20 Oct, 08:30 · awake window starts']);
    wrapper.unmount();
  });

  it('hides Edit and Clear without the permission', () => {
    const wrapper = mountCard({ canEdit: false });
    expect(wrapper.find('[data-test="edit-schedule"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="clear-schedule"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Europe/Paris');
    wrapper.unmount();
  });

  it('offers to add a schedule when there is none, and says an older router has none to give', async () => {
    const none = mountCard({ schedule: null, next: [], maintenanceDue: null });
    expect(none.text()).toContain('No schedule');
    await none.find('[data-test="edit-schedule"]').trigger('click');
    expect(none.emitted('edit')).toHaveLength(1);
    expect(none.find('[data-test="clear-schedule"]').exists()).toBe(false);
    none.unmount();
    const old = mountCard({ schedule: undefined });
    expect(old.text()).toContain('router 0.31.0');
    expect(old.find('[data-test="edit-schedule"]').exists()).toBe(false);
    old.unmount();
  });

  it('shows a maximum-nap-only schedule, with or without a windows list, and the maintenance due date', () => {
    for (const only of [{ maxNapDays: 7, by: 'ops@example.com', at: '2026-10-01T10:00:00.000Z' }, { windows: [], maxNapDays: 7, by: 'ops@example.com', at: '2026-10-01T10:00:00.000Z' }]) {
      const wrapper = mountCard({ schedule: only as Schedule, next: [] });
      const text = wrapper.text();
      expect(text).toContain('Maximum nap 7 days');
      expect(text).toContain('maintenance wake due');
      expect(text).not.toContain('Time zone');
      expect(wrapper.findAll('[data-test="window"]')).toHaveLength(0);
      wrapper.unmount();
    }
  });

  it('asks before clearing', async () => {
    const wrapper = mountCard({});
    await wrapper.find('[data-test="clear-schedule"]').trigger('click');
    await flushPromises();
    expect(wrapper.emitted('clear')).toBeUndefined();
    ([...document.querySelectorAll('.v-dialog button')].find((b) => b.textContent?.trim() === 'Clear') as HTMLElement).click();
    await flushPromises();
    expect(wrapper.emitted('clear')).toHaveLength(1);
    wrapper.unmount();
  });
});

describe('ScheduleDialog', () => {
  const dialogOf = () => document.querySelector('.v-dialog')!;
  const click = (label: string) => ([...dialogOf().querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLElement).click();

  it('sends the body of two windows, the zone in its canonical case', async () => {
    const wrapper = mount(ScheduleDialog, { props: { modelValue: false, schedule: { ...schedule, timeZone: 'europe/paris' }, name: 'demo', error: '' }, attachTo: document.body, global: { plugins: [createVuetify({ components, directives })] } });
    await wrapper.setProps({ modelValue: true });
    await flushPromises();
    expect(dialogOf().querySelectorAll('[data-test="window"]')).toHaveLength(2);
    click('Save');
    await flushPromises();
    expect(wrapper.emitted('submit')![0]).toEqual([{
      timeZone: 'Europe/Paris',
      windows: [
        { kind: 'awake', days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '08:30', end: '19:00' },
        { kind: 'nap', days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '20:00', end: '07:00', wake: 'header' },
      ],
      exceptions: ['2026-12-25'],
      maxNapDays: 7,
    }]);
    wrapper.unmount();
  });

  it('adds and removes windows, and starts a new schedule in the browser\'s zone', async () => {
    const wrapper = mount(ScheduleDialog, { props: { modelValue: false, schedule: null, name: 'demo', error: '' }, attachTo: document.body, global: { plugins: [createVuetify({ components, directives })] } });
    await wrapper.setProps({ modelValue: true });
    await flushPromises();
    expect(dialogOf().querySelectorAll('[data-test="window"]')).toHaveLength(0);
    click('Add awake window');
    click('Add nap window');
    await flushPromises();
    expect(dialogOf().querySelectorAll('[data-test="window"]')).toHaveLength(2);
    (dialogOf().querySelector('[data-test="remove-window"]') as HTMLElement).click();
    await flushPromises();
    expect(dialogOf().querySelectorAll('[data-test="window"]')).toHaveLength(1);
    click('Save');
    await flushPromises();
    const body = wrapper.emitted('submit')![0]![0] as Schedule;
    expect(body.windows).toHaveLength(1);
    expect(body.windows![0]!.kind).toBe('nap');
    expect(body.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    wrapper.unmount();
  });

  it('shows the API\'s refusal as it words it', async () => {
    const wrapper = mount(ScheduleDialog, { props: { modelValue: true, schedule, name: 'demo', error: 'windows[1].end: overlaps windows[0]' }, attachTo: document.body, global: { plugins: [createVuetify({ components, directives })] } });
    await flushPromises();
    expect(dialogOf().textContent).toContain('windows[1].end: overlaps windows[0]');
    wrapper.unmount();
  });

  it('survives a cleared time zone: it says the zone is required and cannot save', async () => {
    const wrapper = mount(ScheduleDialog, { props: { modelValue: true, schedule, name: 'demo', error: '' }, attachTo: document.body, global: { plugins: [createVuetify({ components, directives })] } });
    await flushPromises();
    wrapper.findComponent({ name: 'VCombobox' }).vm.$emit('update:modelValue', null);
    await flushPromises();
    expect(dialogOf().textContent).toContain('timeZone');
    expect((([...dialogOf().querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save')) as HTMLButtonElement).disabled).toBe(true);
    wrapper.unmount();
  });

  it('opens on a maximum-nap-only schedule: no window, the maximum nap filled', async () => {
    const only = { maxNapDays: 7 } as Schedule;
    const wrapper = mount(ScheduleDialog, { props: { modelValue: true, schedule: only, name: 'demo', error: '' }, attachTo: document.body, global: { plugins: [createVuetify({ components, directives })] } });
    await flushPromises();
    expect(dialogOf().querySelectorAll('[data-test="window"]')).toHaveLength(0);
    const input = dialogOf().querySelector('input[type="number"], [data-test="max-nap"] input') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input!.value).toBe('7');
    wrapper.unmount();
  });

  it('keeps an exception date typed but not committed with Enter, when the field loses focus', async () => {
    const wrapper = mount(ScheduleDialog, { props: { modelValue: true, schedule, name: 'demo', error: '' }, attachTo: document.body, global: { plugins: [createVuetify({ components, directives })] } });
    await flushPromises();
    const box = wrapper.findAllComponents({ name: 'VCombobox' })[1]!;
    box.vm.$emit('update:search', '2026-12-31');
    await flushPromises();
    box.vm.$emit('blur');
    await flushPromises();
    click('Save');
    await flushPromises();
    expect((wrapper.emitted('submit')![0]![0] as Schedule).exceptions).toEqual(['2026-12-25', '2026-12-31']);
    wrapper.unmount();
  });
});
