import { afterEach, describe, expect, it } from 'vitest';
import { h as vh } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import ScheduleDialog from '../src/components/ScheduleDialog.vue';
import type { Schedule } from '../src/schedule';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});

const schedule: Schedule = { timeZone: 'Europe/Paris', windows: [{ kind: 'awake', days: ['mon'], start: '08:00', end: '19:00' }] };
const mounted: VueWrapper[] = [];
const emitted: string[] = [];
let submitted: Schedule | null = null;
async function open(s: Schedule | null, error = '') {
  emitted.length = 0;
  submitted = null;
  const wrapper = mount({ render: () => vh(components.VApp, null, () => vh(ScheduleDialog, { modelValue: true, schedule: s, name: 'Shop', error, onClear: () => emitted.push('clear'), onSubmit: (body: Schedule) => { emitted.push('submit'); submitted = body; } })) }, { attachTo: document.body, global: { plugins: [createVuetify({ components, directives })] } });
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}
afterEach(() => { mounted.splice(0).forEach((w) => w.unmount()); document.body.innerHTML = ''; });
const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
const click = async (label: string) => { button(label)!.click(); await flushPromises(); };

describe('Schedule dialog: clearing', () => {
  it('has a Clear schedule action that asks first, then emits a clear', async () => {
    await open(schedule);
    expect(button('Clear schedule')).toBeDefined();
    await click('Clear schedule');
    expect(emitted).toEqual([]);
    expect(document.body.textContent).toContain('Clear the schedule?');
    await click('Cancel');
    expect(emitted).toEqual([]);
    await click('Clear schedule');
    await click('Clear');
    expect(emitted).toEqual(['clear']);
  });

  it('has no Clear schedule action for a workload with no schedule', async () => {
    await open(null);
    expect(button('Clear schedule')).toBeUndefined();
  });

  it('turns Save into Clear schedule when every window is removed and there is no maximum nap', async () => {
    await open(schedule);
    expect(button('Save')).toBeDefined();
    (document.querySelector('[data-test="remove-window"]') as HTMLElement).click();
    await flushPromises();
    expect(button('Save')).toBeUndefined();
    expect(button('Clear schedule')!.disabled).toBe(false);
    await click('Clear schedule');
    await click('Clear');
    expect(emitted).toEqual(['clear']);
  });
});

describe('Schedule dialog: recurrences', () => {
  const paris = (...windows: Schedule['windows'] & object): Schedule => ({ timeZone: 'Europe/Paris', windows });
  const STORED: NonNullable<Schedule['windows']> = [
    { kind: 'awake', days: ['mon', 'fri'], start: '08:30', end: '09:00' },
    { kind: 'awake', start: '10:00', end: '11:00', repeat: { pattern: 'daily', interval: 3 }, from: '2027-01-04' },
    { kind: 'nap', start: '20:00', end: '07:00', repeat: { pattern: 'weekly', interval: 2, days: ['mon', 'thu'] }, from: '2027-01-04', until: '2027-06-30', wake: 'header' },
    { kind: 'awake', start: '12:00', end: '13:00', repeat: { pattern: 'monthly', interval: 1, day: 15 } },
    { kind: 'awake', start: '13:00', end: '14:00', repeat: { pattern: 'monthly', interval: 3, nth: 1, weekday: 'mon' }, from: '2027-01-01' },
    { kind: 'nap', start: '00:00', end: '00:00', repeat: { pattern: 'monthly', interval: 12, day: 25 }, from: '2026-12-01', wake: 'never' },
    { kind: 'awake', repeat: { pattern: 'cron', cron: '30 8 * * 1-5', minutes: 630 } },
  ];
  const q = (name: string) => document.querySelector(`[data-test="${name}"]`);
  const text = (name: string) => q(name)?.textContent?.trim();
  const fields = (wrapper: VueWrapper) => wrapper.findAllComponents({ name: 'WindowRecurrence' })[0]!;
  // A field of the first window, by its data-test name: its value set as the user would.
  const set = async (wrapper: VueWrapper, name: string, value: unknown) => {
    (fields(wrapper).findComponent(`[data-test="${name}"]`) as unknown as { vm: { $emit(...a: unknown[]): void } }).vm.$emit('update:modelValue', value);
    await flushPromises();
  };
  const saved = () => button('Save');

  it('saves a stored schedule of every pattern as it was', async () => {
    await open(paris(...STORED));
    expect(document.querySelectorAll('[data-test="window"]')).toHaveLength(7);
    expect(saved()!.disabled).toBe(false);
    await click('Save');
    expect(submitted!.windows).toEqual(STORED);
  });

  it('reads each stored window back in the sentence, and opens on its pattern', async () => {
    const wrapper = await open(paris(STORED[2]!));
    expect(text('w-sentence')).toBe('Every 2 weeks on Mon, Thu, 20:00–07:00 next day, from 4 Jan 2027 to 30 Jun 2027');
    expect((fields(wrapper).findComponent('[data-test="w-pattern"]') as unknown as { props(n: string): unknown }).props('modelValue')).toBe('weekly');
  });

  it('offers what each pattern needs', async () => {
    const wrapper = await open(paris({ kind: 'awake', days: ['mon'], start: '08:00', end: '09:00' }));
    expect(q('w-day-mon')).not.toBeNull();
    expect(q('w-start')).not.toBeNull();
    await set(wrapper, 'w-pattern', 'daily');
    expect(q('w-day-mon')).toBeNull();
    expect(q('w-interval')).not.toBeNull();
    expect(q('w-start')).not.toBeNull();
    await set(wrapper, 'w-pattern', 'monthly');
    expect(q('w-month-day')).not.toBeNull();
    expect(q('w-nth')).not.toBeNull();
    await set(wrapper, 'w-pattern', 'yearly');
    expect(q('w-interval')).toBeNull();
    expect(text('w-year-hint')).toContain('start date');
    await set(wrapper, 'w-pattern', 'cron');
    expect(q('w-start')).toBeNull();
    expect(q('w-cron')).not.toBeNull();
    expect(q('w-hours')).not.toBeNull();
  });

  it('writes a monthly window on a weekday, then back on a day', async () => {
    const wrapper = await open(paris({ kind: 'awake', start: '08:00', end: '09:00', repeat: { pattern: 'monthly', day: 15 } }));
    await set(wrapper, 'w-monthly', 'nth');
    await set(wrapper, 'w-nth', -1);
    await set(wrapper, 'w-weekday', 'fri');
    expect(text('w-sentence')).toBe('Monthly on the last Fri, 08:00–09:00');
    await click('Save');
    expect(submitted!.windows![0]!.repeat).toEqual({ pattern: 'monthly', nth: -1, weekday: 'fri' });
  });

  it('asks for a start date where the pattern counts from it, and sets today', async () => {
    const wrapper = await open(paris({ kind: 'awake', start: '08:00', end: '09:00', repeat: { pattern: 'daily' } }));
    expect((fields(wrapper).findComponent('[data-test="w-from"]') as unknown as { props(n: string): unknown }).props('modelValue')).toBeFalsy();
    await set(wrapper, 'w-interval', '2');
    const from = (fields(wrapper).findComponent('[data-test="w-from"]') as unknown as { props(n: string): unknown }).props('modelValue') as string;
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await set(wrapper, 'w-from', '');
    expect(document.body.textContent).toContain('required when repeat.interval is above 1');
    expect(saved()!.disabled).toBe(true);
  });

  it('takes an end date or none, and refuses one before the start', async () => {
    const wrapper = await open(paris({ kind: 'awake', days: ['mon'], start: '08:00', end: '09:00', from: '2027-01-04' }));
    expect(text('w-sentence')).toBe('Mon, 08:00–09:00, from 4 Jan 2027, no end date');
    expect(q('w-until')).toBeNull();
    await set(wrapper, 'w-end-kind', 'date');
    await set(wrapper, 'w-until', '2027-01-01');
    expect(document.body.textContent).toContain('not before from');
    expect(saved()!.disabled).toBe(true);
    await set(wrapper, 'w-until', '2027-02-01');
    expect(saved()!.disabled).toBe(false);
    expect(text('w-sentence')).toBe('Mon, 08:00–09:00, from 4 Jan 2027 to 1 Feb 2027');
    await set(wrapper, 'w-end-kind', 'none');
    await click('Save');
    expect(submitted!.windows![0]).toEqual({ kind: 'awake', days: ['mon'], start: '08:00', end: '09:00', from: '2027-01-04' });
  });

  it('says why a cron expression does not read, under its field, and keeps Save off', async () => {
    const wrapper = await open(paris({ kind: 'awake', repeat: { pattern: 'cron', cron: '0 8 * * *', minutes: 60 } }));
    expect(saved()!.disabled).toBe(false);
    for (const [expression, why] of [
      ['* 8 * * *', 'minutes must be multiples of 5'],
      ['cron(0 8 * * ? *)', 'five fields: minute hour day-of-month month day-of-week'],
      ['0 8 31 2 *', 'never matches'],
      ['0 25 * * *', 'the hour field takes'],
    ] as const) {
      await set(wrapper, 'w-cron', expression);
      expect(q('w-cron')!.closest('.v-input')!.textContent).toContain(why);
      expect(saved()!.disabled, expression).toBe(true);
      expect(q('w-next')).toBeNull();
    }
    await set(wrapper, 'w-cron', '30 8 * * 1-5');
    expect(saved()!.disabled).toBe(false);
    expect(text('w-sentence')).toBe('Cron 30 8 * * 1-5, 1 h');
  });

  it('keeps Save off on a duration it refuses, and reads the one it takes', async () => {
    const wrapper = await open(paris({ kind: 'awake', repeat: { pattern: 'cron', cron: '0 8 * * *', minutes: 60 } }));
    await set(wrapper, 'w-hours', '200');
    expect(document.body.textContent).toContain('a multiple of 5 from 5 to 10080');
    expect(saved()!.disabled).toBe(true);
    await set(wrapper, 'w-hours', '10');
    await set(wrapper, 'w-minutes', 30);
    expect(text('w-sentence')).toBe('Cron 0 8 * * *, 10 h 30 min');
    await click('Save');
    expect(submitted!.windows![0]!.repeat).toEqual({ pattern: 'cron', cron: '0 8 * * *', minutes: 630 });
  });

  it('warns about a start as often as every 5 to 15 minutes, not less', async () => {
    const wrapper = await open(paris({ kind: 'awake', repeat: { pattern: 'cron', cron: '0 8 * * *', minutes: 60 } }));
    expect(q('w-cron-warning')).toBeNull();
    for (const expression of ['*/5 8 * * *', '*/15 * * * *', '0,10 8 * * *']) {
      await set(wrapper, 'w-cron', expression);
      expect(text('w-cron-warning'), expression).toContain('a manual Nap or Wake lasts until the next start');
      expect(text('w-cron-warning')).toContain('blocks naps');
      expect(saved()!.disabled).toBe(false);
    }
    await set(wrapper, 'w-cron', '*/20 8 * * *');
    expect(q('w-cron-warning')).toBeNull();
  });

  it('shows the next 5 occurrences in the schedule\'s zone, the exceptions applied', async () => {
    await open({ ...paris({ kind: 'awake', start: '08:00', end: '12:00', repeat: { pattern: 'daily', interval: 3 }, from: '2099-01-04' }), exceptions: ['2099-01-07'] });
    const rows = [...document.querySelectorAll('[data-test="w-next"] li')].map((r) => r.textContent?.trim());
    expect(rows).toEqual(['Sun 4 Jan 2099, 08:00–12:00', 'Sat 10 Jan 2099, 08:00–12:00', 'Tue 13 Jan 2099, 08:00–12:00', 'Fri 16 Jan 2099, 08:00–12:00', 'Mon 19 Jan 2099, 08:00–12:00']);
  });

  it('shows 5 occurrences of a yearly window, and the months of a Monthly one are a month for 1', async () => {
    const wrapper = await open(paris({ kind: 'nap', start: '00:00', end: '00:00', repeat: { pattern: 'monthly', interval: 12, day: 25 }, from: '2099-12-01' }));
    expect(document.querySelectorAll('[data-test="w-next"] li')).toHaveLength(5);
    await set(wrapper, 'w-pattern', 'monthly');
    expect(q('w-interval')!.textContent).toContain('month');
    expect(q('w-interval')!.textContent).not.toContain('months');
    await set(wrapper, 'w-interval', '2');
    expect(q('w-interval')!.textContent).toContain('months');
  });

  it('says when no occurrence comes', async () => {
    await open(paris({ kind: 'awake', days: ['mon'], start: '08:00', end: '09:00', until: '2020-01-01' }));
    expect(text('w-next')).toContain('No occurrence in the next 10 years');
  });

  it('adds the hint to the refusal of a router that does not know recurrences', async () => {
    await open(paris(STORED[1]!), 'windows[0].repeat: unknown field');
    expect(q('schedule-error')!.textContent).toContain('windows[0].repeat: unknown field');
    expect(q('schedule-error')!.textContent).toContain('Recurrences need router 0.36.0');
  });

  it('a plain window with every day off says so and keeps Save off', async () => {
    const wrapper = await open(paris({ kind: 'awake', days: ['mon'], start: '08:00', end: '09:00' }));
    (fields(wrapper).findComponent('[data-test="w-days"]') as unknown as { vm: { $emit(...a: unknown[]): void } }).vm.$emit('update:modelValue', []);
    await flushPromises();
    expect(text('w-days-hint')).toBe('Choose at least one day.');
    expect(saved()!.disabled).toBe(true);
  });
});
