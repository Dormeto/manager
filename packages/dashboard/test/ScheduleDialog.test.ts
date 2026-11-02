import { afterEach, describe, expect, it, vi } from 'vitest';
import { h as vh } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import { mdiPlus, mdiWeatherNight, mdiWeatherSunny } from '@mdi/js';
import ScheduleDialog from '../src/components/ScheduleDialog.vue';
import type { JoinAnswer, Schedule } from '../src/schedule';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});

const schedule: Schedule = { timeZone: 'Europe/Paris', windows: [{ kind: 'awake', days: ['mon'], start: '08:00', end: '19:00' }] };
const mounted: VueWrapper[] = [];
const emitted: string[] = [];
let submitted: Schedule | null = null;
async function open(s: Schedule | null, error = '', join?: JoinAnswer) {
  emitted.length = 0;
  submitted = null;
  const wrapper = mount({ render: () => vh(components.VApp, null, () => vh(ScheduleDialog, { modelValue: true, schedule: s, name: 'Shop', error, ...(join ? { join } : {}), onClear: () => emitted.push('clear'), onSubmit: (body: Schedule) => { emitted.push('submit'); submitted = body; } })) }, { attachTo: document.body, global: { plugins: [createVuetify({ components, directives })] } });
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
      ['0 8 */2 * 1', 'a day field starting with * goes alone'],
      ['0 8 * * 1\n', 'one line, without control characters'],
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
    const rows = [...document.querySelectorAll('[data-test="w-next-list"] li')].map((r) => r.textContent?.trim());
    expect(rows).toEqual(['Sun 4 Jan 2099, 08:00–12:00', 'Sat 10 Jan 2099, 08:00–12:00', 'Tue 13 Jan 2099, 08:00–12:00', 'Fri 16 Jan 2099, 08:00–12:00', 'Mon 19 Jan 2099, 08:00–12:00']);
  });

  it('shows 5 occurrences of a yearly window, and the months of a Monthly one are a month for 1', async () => {
    const wrapper = await open(paris({ kind: 'nap', start: '00:00', end: '00:00', repeat: { pattern: 'monthly', interval: 12, day: 25 }, from: '2099-12-01' }));
    expect(document.querySelectorAll('[data-test="w-next-list"] li')).toHaveLength(5);
    await set(wrapper, 'w-pattern', 'monthly');
    expect(q('w-interval')!.textContent).toContain('month');
    expect(q('w-interval')!.textContent).not.toContain('months');
    await set(wrapper, 'w-interval', '2');
    expect(q('w-interval')!.textContent).toContain('months');
  });

  it('restores a pattern after a slip on the select, the stored window included', async () => {
    const stored: NonNullable<Schedule['windows']>[number] = { kind: 'awake', repeat: { pattern: 'cron', cron: '30 8 1 * 1-5', minutes: 630 } };
    const wrapper = await open(paris(stored));
    await set(wrapper, 'w-pattern', 'weekly');
    await set(wrapper, 'w-pattern', 'cron');
    expect(text('w-sentence')).toBe('Cron 30 8 1 * 1-5, 10 h 30 min');
    await click('Save');
    expect(submitted!.windows![0]).toEqual(stored);
  });

  it('keeps each row\'s memory with its row when one is removed', async () => {
    const wrapper = await open(paris(
      { kind: 'nap', days: ['sat'], start: '00:00', end: '00:00', wake: 'never' },
      { kind: 'awake', repeat: { pattern: 'cron', cron: '30 8 * * 1-5', minutes: 630 } },
    ));
    // The first row has held Saturday in its memory.
    await set(wrapper, 'w-pattern', 'daily');
    (document.querySelector('[data-test="remove-window"]') as HTMLElement).click();
    await flushPromises();
    expect(wrapper.findAllComponents({ name: 'WindowRecurrence' })).toHaveLength(1);
    await set(wrapper, 'w-pattern', 'weekly');
    expect(text('w-sentence')).toBe('Mon–Fri, 08:00–19:00');
    await set(wrapper, 'w-pattern', 'cron');
    expect(text('w-sentence')).toBe('Cron 30 8 * * 1-5, 10 h 30 min');
  });

  it('adding a row after removing one gives it a memory of its own', async () => {
    const wrapper = await open(paris({ kind: 'awake', days: ['sat'], start: '10:00', end: '11:00' }));
    await set(wrapper, 'w-pattern', 'daily');
    (document.querySelector('[data-test="remove-window"]') as HTMLElement).click();
    await flushPromises();
    (document.querySelector('[data-test="add-awake"]') as HTMLElement).click();
    await flushPromises();
    await set(wrapper, 'w-pattern', 'daily');
    await set(wrapper, 'w-pattern', 'weekly');
    expect(text('w-sentence')).toBe('Mon–Fri, 08:00–19:00');
  });

  it('a Yearly day the helper filled in follows the start date', async () => {
    const wrapper = await open(paris({ kind: 'nap', days: ['mon'], start: '00:00', end: '00:00', wake: 'never' }));
    await set(wrapper, 'w-pattern', 'yearly');
    await set(wrapper, 'w-from', '2099-12-25');
    expect(text('w-sentence')).toBe('Yearly on 25 Dec, all day (24 hours), from 25 Dec 2099, no end date');
    expect(text('w-next')).toContain('25 Dec 2099');
    await set(wrapper, 'w-month-day', '7');
    await set(wrapper, 'w-from', '2099-11-02');
    expect(text('w-sentence')).toBe('Yearly on 7 Nov, all day (24 hours), from 2 Nov 2099, no end date');
  });

  it('an end date cleared stays On a date, says a date is needed, and keeps Save off', async () => {
    const wrapper = await open(paris({ kind: 'awake', days: ['mon'], start: '08:00', end: '09:00', until: '2099-06-30' }));
    expect(saved()!.disabled).toBe(false);
    await set(wrapper, 'w-until', '');
    expect(q('w-until')).not.toBeNull();
    expect((fields(wrapper).findComponent('[data-test="w-end-kind"]') as unknown as { props(n: string): unknown }).props('modelValue')).toBe('date');
    expect(q('w-until')!.closest('.v-input')!.textContent).toContain('choose a date, or No end date');
    expect(saved()!.disabled).toBe(true);
    expect(q('w-sentence')).toBeNull();
    expect(q('w-next')).toBeNull();
    await set(wrapper, 'w-until', '2099-07-01');
    expect(saved()!.disabled).toBe(false);
    await set(wrapper, 'w-until', '');
    await set(wrapper, 'w-end-kind', 'none');
    expect(q('w-until')).toBeNull();
    expect(saved()!.disabled).toBe(false);
    await click('Save');
    expect(submitted!.windows![0]).toEqual({ kind: 'awake', days: ['mon'], start: '08:00', end: '09:00' });
  });

  it('interval 2 then back to 1 sends a plain window, without the start date it filled in', async () => {
    const wrapper = await open(paris({ kind: 'awake', days: ['mon'], start: '08:00', end: '09:00' }));
    await set(wrapper, 'w-interval', '2');
    await set(wrapper, 'w-interval', '1');
    await click('Save');
    expect(submitted!.windows![0]).toEqual({ kind: 'awake', days: ['mon'], start: '08:00', end: '09:00' });
  });

  it('a blank number reads as none in the sentence', async () => {
    const wrapper = await open(paris({ kind: 'awake', start: '08:00', end: '09:00', repeat: { pattern: 'daily' } }));
    await set(wrapper, 'w-interval', '');
    expect(text('w-sentence')).toBe('Every … days, 08:00–09:00');
    expect(saved()!.disabled).toBe(true);
  });

  it('lists starts a spring clock change brings together, without a key twice', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await open(paris({ kind: 'nap', wake: 'never', repeat: { pattern: 'cron', cron: '*/15 2 * * *', minutes: 60 }, from: '2099-03-29', until: '2099-03-29' }));
    const rows = [...document.querySelectorAll('[data-test="w-next-list"] li')].map((r) => r.textContent?.trim());
    expect(rows.length).toBeGreaterThan(1);
    expect(new Set(rows.map((r) => r!.slice(0, 22))).size).toBe(1);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('Duplicate keys'))).toEqual([]);
    warn.mockRestore();
  });

  it('shows a stored nap without a wake as what it means, and saves the one chosen', async () => {
    const wrapper = await open(paris({ kind: 'nap', days: ['sat'], start: '00:00', end: '00:00' }));
    const wake = wrapper.findAllComponents({ name: 'VSelect' }).find((c) => c.props('label') === 'Wake')!;
    expect(wake.props('modelValue')).toBe('never');
    wake.vm.$emit('update:modelValue', 'header');
    await flushPromises();
    await click('Save');
    expect(submitted!.windows![0]!.wake).toBe('header');
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

describe('Schedule dialog: the next occurrence, on one line', () => {
  const window: Schedule = { timeZone: 'Europe/Paris', windows: [{ kind: 'awake', start: '08:00', end: '12:00', repeat: { pattern: 'daily', interval: 3 }, from: '2099-01-04' }] };

  it('shows the next one, and the next 5 in a tooltip reached by hover and by keyboard', async () => {
    await open(window);
    const line = document.querySelector('[data-test="w-next-line"]') as HTMLElement;
    expect(line.textContent).toContain('Sun 4 Jan 2099, 08:00–12:00');
    expect(document.querySelector('[data-test="w-next"]')!.textContent).not.toContain('7 Jan 2099');
    expect(line.getAttribute('tabindex')).toBe('0');
    const list = () => document.querySelector('.v-overlay--active [data-test="w-next-list"]');
    expect(list()).toBeNull();
    line.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.waitFor(() => expect(list()).not.toBeNull());
    expect([...list()!.querySelectorAll('li')].map((r) => r.textContent?.trim())).toEqual(['Sun 4 Jan 2099, 08:00–12:00', 'Wed 7 Jan 2099, 08:00–12:00', 'Sat 10 Jan 2099, 08:00–12:00', 'Tue 13 Jan 2099, 08:00–12:00', 'Fri 16 Jan 2099, 08:00–12:00']);
  });
});

describe('Schedule dialog: what it says of itself', () => {
  const sample: Schedule = { timeZone: 'Europe/Paris', windows: [{ kind: 'awake', days: ['mon'], start: '08:00', end: '12:00' }, { kind: 'nap', days: ['tue'], start: '08:00', end: '12:00' }] };
  const hover = async (selector: string, content: string) => {
    document.querySelector(selector)!.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.waitFor(() => expect(document.querySelector(`.v-overlay--active ${content}`)).not.toBeNull());
    return document.querySelector(`.v-overlay--active ${content}`)!;
  };

  it('keeps its introduction to one short sentence', async () => {
    await open(sample);
    const intro = document.querySelector('[data-test="schedule-intro"]')!.textContent!.trim();
    expect(intro.split(/[.!?](\s|$)/).filter((x) => x.trim()).length).toBe(1);
    expect(intro.length).toBeLessThan(90);
  });

  it('says in its tooltip that a schedule overrides the idle behaviour, and what wins over it', async () => {
    await open(sample);
    const help = await hover('[data-test="schedule-help"]', '[data-test="schedule-help-text"]');
    const text = help.textContent!;
    for (const words of ['overrides', 'idle naps do not happen', 'requests do not wake it', 'x-dormeto-wake', 'idle rules apply as usual', 'pause', 'Wake', 'Nap']) expect(text, words).toContain(words);
  });

  it('draws samples of the overlaps: one workload, allowed and refused, 400 days', async () => {
    await open(sample);
    const help = await hover('[data-test="overlap-help"]', '[data-test="overlap-samples"]');
    expect(help.textContent).toContain('one workload');
    expect(help.textContent).toContain('400 days');
    const samples = [...help.querySelectorAll('[data-test="overlap-sample"]')];
    expect(samples.length).toBeGreaterThanOrEqual(6);
    expect(samples.filter((x) => x.getAttribute('data-allowed') === 'false')).toHaveLength(1);
    for (const x of samples) {
      expect(x.querySelector('.v-icon'), x.textContent!).not.toBeNull();
      expect(x.querySelectorAll('.dm-bar').length, x.textContent!).toBeGreaterThanOrEqual(2);
      expect(x.querySelector('[role="img"]')!.getAttribute('aria-label')).toBeTruthy();
    }
  });

  it('stays open through the click that follows a tap\'s hover: a tap on a phone is both', async () => {
    await open(sample);
    const help = document.querySelector('[data-test="overlap-help"]') as HTMLElement;
    await hover('[data-test="overlap-help"]', '[data-test="overlap-samples"]');
    help.click();
    await flushPromises();
    await new Promise((r) => setTimeout(r, 100));
    expect(document.querySelector('.v-overlay--active [data-test="overlap-samples"]')).not.toBeNull();
  });

  it('has a tooltip on the delete button', async () => {
    await open(sample);
    const tip = await hover('[data-test="remove-window"]', '[data-test="remove-window-tip"]');
    expect(tip.textContent).toBe('Remove this window');
  });

  it('is wide: the zone, the dates and the maximum nap share a row', async () => {
    const wrapper = await open(sample);
    expect(wrapper.findComponent({ name: 'VDialog' }).props('maxWidth')).toBe('1100');
    const row = document.querySelector('[data-test="time-zone"]')!.parentElement;
    expect(row!.querySelector('[data-test="exceptions"]')).not.toBeNull();
    expect(row!.querySelector('[data-test="max-nap"]')).not.toBeNull();
  });
});

describe('Schedule dialog: a tab per window', () => {
  const sample: Schedule = { timeZone: 'Europe/Paris', windows: [
    { kind: 'awake', days: ['mon'], start: '08:00', end: '12:00' },
    { kind: 'nap', days: ['tue'], start: '08:00', end: '12:00', wake: 'never' },
    { kind: 'awake', repeat: { pattern: 'cron', cron: '30 8 * * 1-5', minutes: 630 } },
  ] };
  const q = (name: string) => document.querySelector(`[data-test="${name}"]`) as HTMLElement | null;
  const tabs = () => [...document.querySelectorAll('[data-test="window-tab"]')] as HTMLElement[];
  const panels = () => [...document.querySelectorAll('[data-test="window"]')] as HTMLElement[];
  const shown = () => panels().map((p) => p.style.display !== 'none');
  const selected = () => tabs().map((t) => t.classList.contains('v-tab--selected'));
  // The icons an element holds, by the path each was given (the tests' Vuetify draws them as font classes).
  const icons = (wrapper: VueWrapper, el: Element) => wrapper.findAllComponents({ name: 'VIcon' }).filter((i) => el.contains(i.element)).map((i) => i.props('icon'));
  const hover = async (name: string, content: string) => {
    q(name)!.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.waitFor(() => expect(document.querySelector(`.v-overlay--active [data-test="${content}"]`)).not.toBeNull());
    return document.querySelector(`.v-overlay--active [data-test="${content}"]`)!;
  };

  it('names each tab with its kind\'s icon and its window in a few words, and has no kind to change', async () => {
    const wrapper = await open(sample);
    expect(tabs().map((t) => t.textContent?.trim())).toEqual(['Mon, 08:00–12:00', 'Tue, 08:00–12:00', 'Cron 30 8 * * 1-5, 10 h 30 min']);
    expect(tabs().map((t) => icons(wrapper, t)[0])).toEqual([mdiWeatherSunny, mdiWeatherNight, mdiWeatherSunny]);
    expect(tabs().map((t) => t.getAttribute('aria-label'))).toEqual(['Awake window: Mon, 08:00–12:00', 'Nap window: Tue, 08:00–12:00', 'Awake window: Cron 30 8 * * 1-5, 10 h 30 min']);
    expect(document.querySelector('.v-dialog .v-btn-toggle')).toBeNull();
  });

  it('shows the selected tab\'s window only, the first at the opening', async () => {
    await open(sample);
    expect(selected()).toEqual([true, false, false]);
    expect(shown()).toEqual([true, false, false]);
    tabs()[1]!.click();
    await flushPromises();
    expect(selected()).toEqual([false, true, false]);
    expect(shown()).toEqual([false, true, false]);
    expect(panels()[1]!.textContent).toContain('Requests never wake it');
  });

  it('adds a nap or an awake window from the buttons after the tabs, and selects it', async () => {
    const wrapper = await open(sample);
    expect(q('window-tabs')!.compareDocumentPosition(q('add-nap')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(q('add-nap')!.compareDocumentPosition(q('add-awake')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(icons(wrapper, q('add-nap')!)).toEqual([mdiPlus, mdiWeatherNight]);
    expect(icons(wrapper, q('add-awake')!)).toEqual([mdiPlus, mdiWeatherSunny]);
    expect((await hover('add-nap', 'add-nap-tip')).textContent).toBe('Add a nap window');
    expect((await hover('add-awake', 'add-awake-tip')).textContent).toBe('Add an awake window');
    q('add-nap')!.click();
    await flushPromises();
    expect(selected()).toEqual([false, false, false, true]);
    expect(shown()).toEqual([false, false, false, true]);
    expect(icons(wrapper, tabs()[3]!)[0]).toBe(mdiWeatherNight);
    q('add-awake')!.click();
    await flushPromises();
    expect(selected()).toEqual([false, false, false, false, true]);
    button('Save')!.click();
    await flushPromises();
    expect(submitted!.windows!.map((w) => w.kind)).toEqual(['awake', 'nap', 'awake', 'nap', 'awake']);
  });

  it('removing the selected window selects the one after it, or the one before the last', async () => {
    await open(sample);
    tabs()[1]!.click();
    await flushPromises();
    (panels()[1]!.querySelector('[data-test="remove-window"]') as HTMLElement).click();
    await flushPromises();
    expect(tabs().map((t) => t.textContent?.trim())).toEqual(['Mon, 08:00–12:00', 'Cron 30 8 * * 1-5, 10 h 30 min']);
    expect(selected()).toEqual([false, true]);
    expect(shown()).toEqual([false, true]);
    (panels()[1]!.querySelector('[data-test="remove-window"]') as HTMLElement).click();
    await flushPromises();
    expect(selected()).toEqual([true]);
    expect(shown()).toEqual([true]);
  });

  it('marks the tab of a window that cannot be saved', async () => {
    const wrapper = await open(sample);
    expect(q('window-tab-problem')).toBeNull();
    (wrapper.findAllComponents({ name: 'WindowRecurrence' })[0]!.findComponent('[data-test="w-days"]') as unknown as { vm: { $emit(...a: unknown[]): void } }).vm.$emit('update:modelValue', []);
    await flushPromises();
    expect(tabs()[0]!.querySelector('[data-test="window-tab-problem"]')).not.toBeNull();
    expect(tabs()[1]!.querySelector('[data-test="window-tab-problem"]')).toBeNull();
  });

  it('says how to add a window when there is none', async () => {
    await open(null);
    expect(tabs()).toEqual([]);
    expect(q('no-window')!.textContent).toContain('No window yet');
    q('add-awake')!.click();
    await flushPromises();
    expect(q('no-window')).toBeNull();
    expect(selected()).toEqual([true]);
  });

  it('keeps the time zone, the dates, the maximum nap and the join outside the tabs', async () => {
    await open(sample, '', { joinMinutes: 15, joinFrom: 'default', joinInherited: { joinMinutes: 15, joinFrom: 'default' } });
    for (const name of ['time-zone', 'exceptions', 'max-nap', 'join']) {
      expect(q(name), name).not.toBeNull();
      expect(q(name)!.closest('[data-test="windows"]'), name).toBeNull();
    }
  });

  it('ends the sentence\'s row with the next occurrence', async () => {
    await open({ timeZone: 'Europe/Paris', windows: [{ kind: 'awake', start: '08:00', end: '12:00', repeat: { pattern: 'daily', interval: 3 }, from: '2099-01-04' }] });
    expect(q('w-next')!.parentElement).toBe(q('w-recap'));
    expect(q('w-sentence')!.parentElement).toBe(q('w-recap'));
    expect(q('w-sentence')!.compareDocumentPosition(q('w-next')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('Schedule dialog: Do not repeat', () => {
  const paris = (...windows: NonNullable<Schedule['windows']>): Schedule => ({ timeZone: 'Europe/Paris', windows });
  const q = (name: string) => document.querySelector(`[data-test="${name}"]`);
  const text = (name: string) => q(name)?.textContent?.trim();
  const set = async (wrapper: VueWrapper, name: string, value: unknown) => {
    (wrapper.findAllComponents({ name: 'WindowRecurrence' })[0]!.findComponent(`[data-test="${name}"]`) as unknown as { vm: { $emit(...a: unknown[]): void } }).vm.$emit('update:modelValue', value);
    await flushPromises();
  };
  const stored: NonNullable<Schedule['windows']>[number] = { kind: 'awake', start: '08:00', end: '12:00', repeat: { pattern: 'daily' }, from: '2099-01-05', until: '2099-01-05' };

  it('reads a window of that shape as Do not repeat, with one date field, and saves it as it was', async () => {
    const wrapper = await open(paris(stored));
    expect((wrapper.findAllComponents({ name: 'WindowRecurrence' })[0]!.findComponent('[data-test="w-pattern"]') as unknown as { props(n: string): unknown; }).props('modelValue')).toBe('once');
    expect(q('w-once-date')).not.toBeNull();
    expect(q('w-from')).toBeNull();
    expect(q('w-end-kind')).toBeNull();
    expect(q('w-interval')).toBeNull();
    expect(q('w-start')).not.toBeNull();
    expect(text('w-sentence')).toBe('Once on 5 Jan 2099, 08:00–12:00');
    await click('Save');
    expect(submitted!.windows![0]).toEqual(stored);
  });

  it('offers it, dated today, and moves both ends with its date', async () => {
    const wrapper = await open(paris({ kind: 'awake', days: ['mon'], start: '08:00', end: '12:00' }));
    await set(wrapper, 'w-pattern', 'once');
    await set(wrapper, 'w-once-date', '2099-02-03');
    expect(text('w-sentence')).toBe('Once on 3 Feb 2099, 08:00–12:00');
    await click('Save');
    expect(submitted!.windows![0]).toEqual({ kind: 'awake', start: '08:00', end: '12:00', repeat: { pattern: 'daily' }, from: '2099-02-03', until: '2099-02-03' });
  });

  it('says a past date will never run, and a blank one keeps Save off', async () => {
    const wrapper = await open(paris({ ...stored, from: '2020-01-05', until: '2020-01-05' }));
    expect(text('w-once-past')).toContain('will never run');
    expect(button('Save')!.disabled).toBe(false);
    await set(wrapper, 'w-once-date', '');
    expect((q('w-once-date')!.closest('.v-input') as HTMLElement).textContent).toContain('choose a date');
    expect(q('w-once-past')).toBeNull();
    expect(button('Save')!.disabled).toBe(true);
    await set(wrapper, 'w-once-date', '2099-01-01');
    expect(q('w-once-past')).toBeNull();
  });
});

describe('Schedule dialog: joined windows', () => {
  const JOIN: JoinAnswer = { joinMinutes: 15, joinFrom: 'organization', joinInherited: { joinMinutes: 15, joinFrom: 'organization' } };
  const field = () => document.querySelector('[data-test="join"]') as HTMLElement | null;
  const number = () => field()!.querySelector('input[type="number"]') as HTMLInputElement;
  const inherit = () => field()!.querySelector('input[type="checkbox"]') as HTMLInputElement;
  const save = async () => { button('Save')!.click(); await flushPromises(); };
  const type = async (value: string) => { number().value = value; number().dispatchEvent(new Event('input')); await flushPromises(); };
  const PAIR: Schedule = { ...schedule, windows: [...schedule.windows!, { kind: 'nap', days: ['tue'], start: '20:00', end: '07:00', wake: 'never' }] };
  const add = async (kind: 'awake' | 'nap') => { (document.querySelector(`[data-test="add-${kind}"]`) as HTMLElement).click(); await flushPromises(); };

  it('says the inherited value and level, with the words asked', async () => {
    await open(PAIR, '', JOIN);
    expect(field()!.textContent).toContain('Join windows of one kind up to');
    expect(field()!.textContent).toContain('minutes apart');
    expect(field()!.textContent).toContain('Inherit (15 min, from the organization)');
    expect(inherit().checked).toBe(true);
    expect(number().disabled).toBe(true);
    expect(number().value).toBe('15');
  });

  it('puts Inherit first, on the row of the words, and why in a tooltip', async () => {
    await open(PAIR, '', JOIN);
    const row = field()!.querySelector('[data-test="join-row"]')!;
    expect(row.contains(inherit()) && row.contains(number())).toBe(true);
    expect(inherit().compareDocumentPosition(number()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(field()!.textContent).not.toContain('neither wakes nor naps');
    document.querySelector('[data-test="join-more"]')!.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.waitFor(() => expect(document.querySelector('.v-overlay--active [data-test="join-tip"]')).not.toBeNull());
    const tip = document.querySelector('.v-overlay--active [data-test="join-tip"]')!.textContent;
    expect(tip).toContain('neither wakes nor naps');
    expect(tip).toContain('0 never joins');
  });

  it('is there for a first schedule from its second window, whose status answers what it would inherit', async () => {
    await open(null, '', { joinMinutes: 30, joinFrom: 'router', joinInherited: { joinMinutes: 30, joinFrom: 'router' } });
    expect(field()).toBeNull();
    await add('awake');
    expect(field()).toBeNull();
    await add('nap');
    expect(field()!.textContent).toContain('Inherit (30 min, from the router)');
  });

  it('is offered from two windows, and for one window only where it matters', async () => {
    await open(schedule, '', JOIN);
    expect(field()).toBeNull();
    await add('nap');
    expect(field()).not.toBeNull();
    (document.querySelectorAll('[data-test="remove-window"]')[1] as HTMLElement).click();
    await flushPromises();
    expect(field()).toBeNull();
    mounted.splice(0).forEach((w) => w.unmount());
    // A value of its own stays in sight, Inherit clicked or not.
    await open({ ...schedule, joinMinutes: 30 }, '', JOIN);
    expect(field()).not.toBeNull();
    inherit().click();
    await flushPromises();
    expect(field()).not.toBeNull();
    mounted.splice(0).forEach((w) => w.unmount());
    // One window that comes back within the largest gap joins itself: a daily nap to 23:45.
    await open({ timeZone: 'UTC', windows: [{ kind: 'nap', start: '00:00', end: '23:45', repeat: { pattern: 'daily' }, wake: 'never' }] }, '', JOIN);
    expect(field()).not.toBeNull();
  });

  it('is not offered on a router that answers no value', async () => {
    await open(PAIR);
    expect(field()).toBeNull();
  });

  it('a schedule without one is sent without it', async () => {
    await open(PAIR, '', JOIN);
    await save();
    expect(submitted).not.toHaveProperty('joinMinutes');
  });

  it('a read-back schedule saved again keeps it, 0 included', async () => {
    for (const joinMinutes of [0, 30]) {
      await open({ ...schedule, joinMinutes }, '', { joinMinutes, joinFrom: 'workload', joinInherited: { joinMinutes: 15, joinFrom: 'default' } });
      expect(inherit().checked).toBe(false);
      expect(number().value).toBe(String(joinMinutes));
      await save();
      expect(submitted!.joinMinutes).toBe(joinMinutes);
      mounted.splice(0).forEach((w) => w.unmount());
      document.body.innerHTML = '';
    }
  });

  it('sets its own from the inherited value, and Inherit removes it', async () => {
    await open(PAIR, '', JOIN);
    inherit().click();
    await flushPromises();
    expect(number().disabled).toBe(false);
    expect(number().value).toBe('15');
    await type('30');
    await save();
    expect(submitted!.joinMinutes).toBe(30);
    mounted.splice(0).forEach((w) => w.unmount());
    document.body.innerHTML = '';
    await open({ ...schedule, joinMinutes: 30 }, '', JOIN);
    inherit().click();
    await flushPromises();
    await save();
    expect(submitted).not.toHaveProperty('joinMinutes');
  });

  it('a value it refuses says so under the field, in the router\'s words, and keeps Save off', async () => {
    await open({ ...schedule, joinMinutes: 30 }, '', JOIN);
    for (const bad of ['7', '125', '']) {
      await type(bad);
      expect(field()!.textContent, bad).toContain('joinMinutes: a whole number from 0 to 120, a multiple of 5');
      expect(button('Save')!.disabled, bad).toBe(true);
    }
    await type('0');
    expect(button('Save')!.disabled).toBe(false);
  });

  const TWO: Schedule = { timeZone: 'UTC', windows: [
    { kind: 'nap', start: '08:00', end: '12:00', repeat: { pattern: 'daily' }, from: '2099-01-04', wake: 'never' },
    { kind: 'nap', start: '12:10', end: '18:00', repeat: { pattern: 'daily' }, from: '2099-01-04', wake: 'never' },
  ] };
  const firstNext = () => document.querySelector('[data-test="w-next-line"]')!.textContent;

  it('the next occurrence in the helper uses the value in force, and the schedule\'s other windows', async () => {
    await open(TWO, '', { joinMinutes: 15, joinFrom: 'default', joinInherited: { joinMinutes: 15, joinFrom: 'default' } });
    expect(firstNext()).toContain('08:00–12:10');
    inherit().click();
    await flushPromises();
    await type('0');
    expect(firstNext()).toContain('08:00–12:00');
  });

  it('an older router does not join: the helper says the window as written', async () => {
    await open(TWO);
    expect(firstNext()).toContain('08:00–12:00');
  });

  it('after a router\'s rollback, drops the stored value it no longer knows', async () => {
    await open({ ...schedule, joinMinutes: 30 });
    expect(field()).toBeNull();
    await save();
    expect(submitted).not.toHaveProperty('joinMinutes');
  });

  it('adds the hint to the refusal of a router that does not know it', async () => {
    await open(schedule, 'joinMinutes: unknown field');
    expect(document.querySelector('[data-test="schedule-error"]')!.textContent).toContain('Joined windows need router 0.36.0 or later.');
  });

  it('explains it in the help, and draws one sample: two nap windows 10 minutes apart', async () => {
    await open(schedule, '', JOIN);
    const hover = async (name: string) => {
      document.querySelector(`[data-test="${name}"]`)!.dispatchEvent(new MouseEvent('mouseenter'));
      await new Promise((r) => setTimeout(r, 300));
      await flushPromises();
    };
    await hover('schedule-help');
    expect(document.querySelector('[data-test="schedule-help-text"]')!.textContent).toContain('Joined windows');
    await hover('overlap-help');
    const sample = [...document.querySelectorAll('[data-test="overlap-sample"]')].find((x) => x.textContent?.includes('Joined'))!;
    expect(sample.textContent).toContain('10 minutes apart');
    expect(sample.querySelectorAll('.dm-bar--nap')).toHaveLength(3);
  });
});
