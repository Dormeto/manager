process.env.TZ = 'Europe/Paris';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h as vh } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import SchedulesView from '../src/views/SchedulesView.vue';
import FullCalendar from '@fullcalendar/vue3';
import ScheduleDialog from '../src/components/ScheduleDialog.vue';
import NewWindowDialog from '../src/components/NewWindowDialog.vue';
import { useSession } from '../src/stores/session';
import type { Schedule } from '../src/schedule';
import { colorFor, saveSaved } from '../src/calendars';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});

const shopSchedule: Schedule = {
  timeZone: 'Europe/Paris',
  windows: [
    { kind: 'awake', days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '08:00', end: '19:00' },
    { kind: 'nap', days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '20:00', end: '23:00', wake: 'header' },
  ],
};
const blogSchedule: Schedule = { timeZone: 'America/New_York', windows: [{ kind: 'awake', days: ['wed'], start: '09:00', end: '12:00' }] };

const h = vi.hoisted(() => ({
  calls: [] as { path: string; method: string; body?: string }[],
  list: [] as Record<string, unknown>[],
  routers: [] as Record<string, unknown>[],
  status: {} as Record<string, unknown>,
  fail: new Set<string>(),
  // Reads held until released, with how many are in flight at most.
  hold: null as null | Promise<void>,
  active: 0,
  peak: 0,
}));
vi.mock('../src/api', () => ({
  api: vi.fn(async (path: string, init: RequestInit = {}) => {
    h.calls.push({ path, method: init.method ?? 'GET', ...(init.body ? { body: String(init.body) } : {}) });
    if (path.startsWith('/workloads?')) {
      const q = new URLSearchParams(path.slice('/workloads?'.length));
      const [limit, offset] = [Number(q.get('limit') ?? 50), Number(q.get('offset') ?? 0)];
      return { workloads: h.list.slice(offset, offset + limit), total: h.list.length, errors: [], routers: h.routers };
    }
    if (h.hold && !init.method) {
      h.active++;
      h.peak = Math.max(h.peak, h.active);
      try { await h.hold; } finally { h.active--; }
    }
    if (h.fail.has(path)) throw new Error('boom');
    if (init.method === 'PUT') return {};
    return h.status[path] ?? {};
  }),
}));

const row = (router: string, id: string, name: string, extra: Record<string, unknown> = {}) => ({ router, workloadId: id, name, state: 'AWAKE', scheduled: true, can: { wake: true, nap: true }, ...extra });
const status = (name: string, schedule: Schedule | null) => ({ name, schedule, next: [], maintenanceDue: null, state: 'AWAKE', can: { wake: true, nap: true } });

function seed() {
  h.list = [row('dmt-dev', 'a', 'Shop'), row('dmt-dev', 'b', 'Blog'), row('dmt-dev', 'c', 'Docs', { scheduled: false }), row('old', 'd', 'Legacy', { scheduled: undefined })];
  h.routers = [{ name: 'dmt-dev', version: '0.31.0' }, { name: 'old', version: '0.30.2' }];
  h.status = { '/workloads/dmt-dev/a': status('Shop', shopSchedule), '/workloads/dmt-dev/b': status('Blog', blogSchedule), '/workloads/dmt-dev/c': status('Docs', null) };
}

const mounted: VueWrapper[] = [];
async function open(query = '?view=week&date=2026-10-21', width = 1440, user = 'ops@example.com') {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  const pinia = createPinia();
  setActivePinia(pinia);
  const session = useSession();
  session.email = user;
  session.role = 'admin';
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/schedules', component: SchedulesView }, { path: '/workloads/:router/:id', name: 'workload', component: { render: () => null } }] });
  await router.push(`/schedules${query}`);
  const wrapper = mount({ render: () => vh(components.VApp, null, () => vh(SchedulesView)) }, { attachTo: document.body, global: { plugins: [createVuetify({ components, directives }), pinia, router] } });
  mounted.push(wrapper);
  await flushPromises();
  return { wrapper, router };
}
const enable = async (w: VueWrapper, key: string) => {
  await w.find(`[data-test="calendar-${key}"] input`).setValue(true);
  await flushPromises();
};
const eventTitles = (w: VueWrapper) => w.findAll('.fc-event').map((e) => e.text());

beforeEach(() => { h.calls.length = 0; h.fail.clear(); h.hold = null; h.active = 0; h.peak = 0; seed(); window.localStorage.clear(); });
afterEach(() => { mounted.splice(0).forEach((w) => w.unmount()); document.body.innerHTML = ''; });

describe('Schedules view: the calendars panel', () => {
  it('lists the scheduled workloads by default, the others when "Scheduled only" is off, and searches by name, id and router', async () => {
    const { wrapper } = await open();
    const names = () => wrapper.findAll('[data-test^="calendar-"]').map((r) => r.attributes('data-test')!.replace('calendar-', ''));
    expect(names()).toEqual(['dmt-dev/a', 'dmt-dev/b', 'old/d']);
    await wrapper.find('[data-test="scheduled-only"] input').setValue(false);
    expect(names()).toContain('dmt-dev/c');
    await wrapper.find('[data-test="panel-search"] input').setValue('blog');
    expect(names()).toEqual(['dmt-dev/b']);
    await wrapper.find('[data-test="panel-search"] input').setValue('old');
    expect(names()).toEqual(['old/d']);
    await wrapper.find('[data-test="panel-search"] input').setValue('dmt-dev/c');
    expect(names()).toEqual(['dmt-dev/c']);
    await wrapper.find('[data-test="scheduled-only"] input').setValue(true);
    expect(names()).toEqual([]);
    await wrapper.find('[data-test="scheduled-only"] input').setValue(false);
    await wrapper.find('[data-test="panel-search"] input').setValue('c');
    expect(names()).toContain('dmt-dev/c');
  });

  it('lists a workload on a router before 0.31.0 disabled, saying which router it needs', async () => {
    const { wrapper } = await open();
    const legacy = wrapper.find('[data-test="calendar-old/d"]');
    expect(legacy.find('input').attributes('disabled')).toBeDefined();
    expect(legacy.text()).toContain('router 0.31.0 needed');
  });

  it('refuses a 21st calendar with its message and keeps the twenty', async () => {
    h.list = Array.from({ length: 22 }, (_, i) => row('dmt-dev', `w${i}`, `W${String(i).padStart(2, '0')}`));
    h.status = Object.fromEntries(h.list.map((r) => [`/workloads/dmt-dev/${r.workloadId}`, status(String(r.name), shopSchedule)]));
    const { wrapper } = await open();
    for (let i = 0; i < 20; i++) await enable(wrapper, `dmt-dev/w${i}`);
    expect(wrapper.find('[data-test="limit-message"]').exists()).toBe(false);
    await enable(wrapper, 'dmt-dev/w20');
    expect(wrapper.find('[data-test="limit-message"]').text()).toContain('At most 20 calendars');
    expect((wrapper.find('[data-test="calendar-dmt-dev/w20"] input').element as HTMLInputElement).checked).toBe(false);
    expect(wrapper.findAll('[data-test^="calendar-"] input').filter((i) => (i.element as HTMLInputElement).checked)).toHaveLength(20);
    expect(h.calls.filter((c) => c.path === '/workloads/dmt-dev/w20')).toHaveLength(0);
  });

  it('keeps the enabled calendars, with their colors, across a remount, per user', async () => {
    const first = await open();
    await enable(first.wrapper, 'dmt-dev/a');
    await enable(first.wrapper, 'dmt-dev/b');
    first.wrapper.unmount();
    const second = await open();
    const checked = () => second.wrapper.findAll('[data-test^="calendar-"] input').filter((i) => (i.element as HTMLInputElement).checked).length;
    expect(checked()).toBe(2);
    expect(second.wrapper.find('[data-test="calendar-dmt-dev/a"] [data-test="swatch"]').attributes('style')).toContain(hexToRgb(colorFor(0)));
    expect(second.wrapper.find('[data-test="calendar-dmt-dev/b"] [data-test="swatch"]').attributes('style')).toContain(hexToRgb(colorFor(1)));
    expect(h.calls.filter((c) => c.path === '/workloads/dmt-dev/a')).toHaveLength(2);
    second.wrapper.unmount();
    const other = await open('?view=week&date=2026-10-21', 1440, 'someone@example.com');
    expect(other.wrapper.findAll('[data-test^="calendar-"] input').filter((i) => (i.element as HTMLInputElement).checked)).toHaveLength(0);
  });

  it('shows a lock on a workload the user may not edit', async () => {
    h.list = [row('dmt-dev', 'a', 'Shop', { can: { wake: true, nap: false } })];
    const { wrapper } = await open();
    expect(wrapper.find('[data-test="calendar-dmt-dev/a"] [data-test="locked"]').exists()).toBe(true);
  });
});

function hexToRgb(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
}

describe('Schedules view: the calendar', () => {
  it('draws an awake and a nap occurrence in the week, with their titles and colors', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    const titles = eventTitles(wrapper);
    expect(titles.filter((t) => t.includes('Shop · Awake'))).toHaveLength(5);
    expect(titles.filter((t) => t.includes('Shop · Nap (wake: header)'))).toHaveLength(5);
    const awake = wrapper.find('.fc-event.dm-ev--awake');
    const nap = wrapper.find('.fc-event.dm-ev--nap');
    expect(awake.attributes('style')).toContain(hexToRgb(colorFor(0)));
    expect(nap.attributes('style')).toContain(hexToRgb(colorFor(0)));
    expect(nap.attributes('style')).toContain('background-color: transparent');
    expect(nap.find('[data-test="moon"]').exists()).toBe(true);
    expect(awake.find('[data-test="moon"]').exists()).toBe(false);
  });

  it('draws a schedule of another zone at its own instants and says its zone in the tooltip', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/b');
    const ev = wrapper.find('.fc-event.dm-ev--awake');
    // Wed 09:00-12:00 in New York is 15:00-18:00 in Paris on 21 Oct (the clocks differ by 6 hours that week).
    expect(ev.text()).toContain('Blog · Awake');
    expect(ev.find('.fc-event-time').text()).toContain('15:00');
    expect(ev.attributes('title')).toContain('America/New_York');
  });

  it('switches to Day, Work week and Month, and keeps the view and date in the address', async () => {
    const { wrapper, router } = await open();
    await enable(wrapper, 'dmt-dev/a');
    expect(wrapper.find('.fc-timeGridWeek-view').exists()).toBe(true);
    expect(wrapper.find('[data-test="title"]').text()).toContain('2026');
    await wrapper.find('[data-test="view-month"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('.fc-dayGridMonth-view').exists()).toBe(true);
    await vi.waitFor(() => expect(router.currentRoute.value.query).toMatchObject({ view: 'month', date: '2026-10-21' }));
    await wrapper.find('[data-test="view-day"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('.fc-timeGridDay-view').exists()).toBe(true);
    expect(eventTitles(wrapper).filter((t) => t.includes('Shop'))).toHaveLength(2);
    await wrapper.find('[data-test="view-work"]').trigger('click');
    await flushPromises();
    expect(wrapper.findAll('.fc-col-header-cell')).toHaveLength(5);
    await wrapper.find('[data-test="next"]').trigger('click');
    await flushPromises();
    await vi.waitFor(() => expect(router.currentRoute.value.query.date).toBe('2026-10-26'));
    await wrapper.find('[data-test="today"]').trigger('click');
    await flushPromises();
    await vi.waitFor(() => expect(router.currentRoute.value.query.date).not.toBe('2026-10-26'));
  });

  it('opens the view and date the address names', async () => {
    const { wrapper } = await open('?view=month&date=2027-02-10');
    expect(wrapper.find('.fc-dayGridMonth-view').exists()).toBe(true);
    expect(wrapper.find('[data-test="title"]').text()).toContain('February 2027');
    const day = await open('?view=day&date=2026-03-29');
    expect(day.wrapper.find('.fc-timeGridDay-view').exists()).toBe(true);
    expect(day.wrapper.find('[data-test="title"]').text()).toContain('29');
  });

  it('opens the schedule dialog of a workload from its event, and re-reads the workload after the save', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    expect(wrapper.findComponent(ScheduleDialog).props('modelValue')).toBe(false);
    await wrapper.find('.fc-event.dm-ev--awake').trigger('click');
    await flushPromises();
    const dialog = wrapper.findComponent(ScheduleDialog);
    expect(dialog.props('modelValue')).toBe(true);
    expect(dialog.props('name')).toBe('Shop');
    expect(dialog.props('schedule')).toEqual(shopSchedule);
    dialog.vm.$emit('submit', { ...shopSchedule, windows: [shopSchedule.windows![0]] });
    await flushPromises();
    const put = h.calls.find((c) => c.method === 'PUT')!;
    expect(put.path).toBe('/workloads/dmt-dev/a/schedule');
    expect(JSON.parse(put.body!).windows).toHaveLength(1);
    expect(h.calls.filter((c) => c.path === '/workloads/dmt-dev/a' && c.method === 'GET')).toHaveLength(2);
    expect(wrapper.findComponent(ScheduleDialog).props('modelValue')).toBe(false);
  });

  it('keeps the dialog open and shows the refusal when the save fails', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    await wrapper.find('.fc-event.dm-ev--awake').trigger('click');
    await flushPromises();
    h.fail.add('/workloads/dmt-dev/a/schedule');
    wrapper.findComponent(ScheduleDialog).vm.$emit('submit', shopSchedule);
    await flushPromises();
    expect(wrapper.findComponent(ScheduleDialog).props('modelValue')).toBe(true);
    expect(wrapper.findComponent(ScheduleDialog).props('error')).toBe('boom');
  });

  it('leaves the other calendars drawn and marks the one that failed to load', async () => {
    h.fail.add('/workloads/dmt-dev/b');
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    await enable(wrapper, 'dmt-dev/b');
    expect(eventTitles(wrapper).some((t) => t.includes('Shop · Awake'))).toBe(true);
    expect(eventTitles(wrapper).some((t) => t.includes('Blog'))).toBe(false);
    expect(wrapper.find('[data-test="calendar-dmt-dev/b"] [data-test="failed"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="calendar-dmt-dev/a"] [data-test="failed"]').exists()).toBe(false);
  });

  it('reads the enabled workloads again on refresh, four at a time', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    h.calls.length = 0;
    await wrapper.find('[data-test="refresh"]').trigger('click');
    await flushPromises();
    expect(h.calls.map((c) => c.path)).toEqual(expect.arrayContaining(['/workloads/dmt-dev/a']));
    expect(h.calls.some((c) => c.path.startsWith('/workloads?'))).toBe(true);
  });

  it('reads four workloads at a time and all of them', async () => {
    h.list = Array.from({ length: 9 }, (_, i) => row('dmt-dev', `w${i}`, `W${i}`));
    h.status = Object.fromEntries(h.list.map((r) => [`/workloads/dmt-dev/${r.workloadId}`, status(String(r.name), shopSchedule)]));
    saveSaved('ops@example.com', { enabled: h.list.map((r, i) => ({ key: `dmt-dev/${r.workloadId}`, color: i })) });
    let release!: () => void;
    h.hold = new Promise<void>((r) => { release = r; });
    const opened = open();
    await vi.waitFor(() => expect(h.active).toBe(4));
    await flushPromises();
    expect(h.active).toBe(4);
    release();
    const { wrapper } = await opened;
    await flushPromises();
    expect(h.peak).toBe(4);
    expect(h.calls.filter((c) => /^\/workloads\/dmt-dev\/w\d$/.test(c.path))).toHaveLength(9);
    expect(eventTitles(wrapper).some((t) => t.includes('W8 · Awake'))).toBe(true);
  });

  it('reads every page of the workloads list', async () => {
    h.list = Array.from({ length: 1001 }, (_, i) => row('dmt-dev', `w${i}`, `W${i}`, { scheduled: i === 1000 }));
    const { wrapper } = await open();
    const lists = h.calls.filter((c) => c.path.startsWith('/workloads?'));
    expect(lists.map((c) => new URLSearchParams(c.path.split('?')[1]).get('offset'))).toEqual(['0', '1000']);
    expect(wrapper.find('[data-test="calendar-dmt-dev/w1000"]').exists()).toBe(true);
  });

  it('does not keep the read of a calendar unticked while it was loading', async () => {
    const { wrapper } = await open();
    let release!: () => void;
    h.hold = new Promise<void>((r) => { release = r; });
    await wrapper.find('[data-test="calendar-dmt-dev/a"] input').setValue(true);
    await vi.waitFor(() => expect(h.active).toBe(1));
    await wrapper.find('[data-test="calendar-dmt-dev/a"] input').setValue(false);
    release();
    await flushPromises();
    expect(Object.keys((wrapper.findComponent(SchedulesView).vm as unknown as { reads: object }).reads)).toEqual([]);
  });

  it('opens the workload page, ids encoded, for an event of a workload the user may not edit', async () => {
    h.list = [row('dmt-dev', 'a b', 'Shop', { can: { wake: true, nap: false } })];
    h.status = { '/workloads/dmt-dev/a%20b': { ...status('Shop', shopSchedule), can: { wake: true, nap: false } } };
    const { wrapper, router } = await open();
    await enable(wrapper, 'dmt-dev/a b');
    await wrapper.find('.fc-event.dm-ev--awake').trigger('click');
    await flushPromises();
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('workload'));
    expect(router.currentRoute.value.fullPath).toBe('/workloads/dmt-dev/a%20b');
  });

  it('offers the panel as a drawer at phone width', async () => {
    const wide = await open();
    expect(wide.wrapper.find('[data-test="panel-toggle"]').exists()).toBe(false);
    wide.wrapper.unmount();
    const { wrapper } = await open('?view=week&date=2026-10-21', 420);
    expect(wrapper.find('[data-test="panel-toggle"]').exists()).toBe(true);
  });
});


// Creating a window: a selection of the calendar (FullCalendar's own select, as a drag raises it) opens the dialog.
const at = (d: string, hhmm: string) => new Date(`${d}T${hhmm}:00`);
const select = async (w: VueWrapper, start: Date, end: Date) => {
  (w.findComponent(FullCalendar).vm as unknown as { getApi(): { select(a: Date, b: Date): void } }).getApi().select(start, end);
  await flushPromises();
};
const dialog = (w: VueWrapper) => w.findComponent(NewWindowDialog);
const body = () => document.body;
const text = (sel: string) => body().querySelector(sel)?.textContent?.trim();
const click = async (sel: string) => { (body().querySelector(sel) as HTMLElement).click(); await flushPromises(); };
const puts = () => h.calls.filter((c) => c.method === 'PUT');

describe('Schedules view: creating a window', () => {
  it('opens the dialog prefilled from a week selection and saves the existing windows plus the new one', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    await select(wrapper, at('2026-10-19', '08:00'), at('2026-10-19', '10:00'));
    expect(dialog(wrapper).props('modelValue')).toBe(true);
    expect(text('[data-test="nw-repeats"]')).toBe('Mon');
    expect(text('[data-test="nw-times"]')).toBe('08:00–10:00');
    expect(text('[data-test="nw-zone"]')).toContain('Europe/Paris');
    expect(text('[data-test="nw-replace-note"]')).toContain('replaces the workload\'s schedule');
    await click('[data-test="nw-save"]');
    expect(puts()).toHaveLength(1);
    expect(puts()[0]!.path).toBe('/workloads/dmt-dev/a/schedule');
    expect(JSON.parse(puts()[0]!.body!)).toEqual({ timeZone: 'Europe/Paris', windows: [...shopSchedule.windows!, { kind: 'awake', days: ['mon'], start: '08:00', end: '10:00' }] });
    expect(dialog(wrapper).props('modelValue')).toBe(false);
    expect(h.calls.filter((c) => c.path === '/workloads/dmt-dev/a' && c.method === 'GET')).toHaveLength(2);
    expect(JSON.parse(window.localStorage.getItem('dm-schedules:ops@example.com')!).last).toBe('dmt-dev/a');
  });

  it('saves a nap with its wake mode', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    await select(wrapper, at('2026-10-19', '23:30'), at('2026-10-19', '23:45'));
    await click('[data-test="nw-kind"] button[value="nap"]');
    await dialog(wrapper).findAllComponents({ name: 'VSelect' })[1]!.vm.$emit('update:modelValue', 'header');
    await flushPromises();
    await click('[data-test="nw-save"]');
    expect(JSON.parse(puts()[0]!.body!).windows.at(-1)).toEqual({ kind: 'nap', days: ['mon'], start: '23:30', end: '23:45', wake: 'header' });
  });

  it('makes an overnight window of a selection across midnight', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    await select(wrapper, at('2026-10-19', '22:00'), at('2026-10-20', '06:00'));
    expect(text('[data-test="nw-times"]')).toContain('22:00–06:00');
    await click('[data-test="nw-save"]');
    expect(JSON.parse(puts()[0]!.body!).windows.at(-1)).toEqual({ kind: 'awake', days: ['mon'], start: '22:00', end: '06:00' });
  });

  it('makes a 24-hour nap of the days selected in the month view', async () => {
    const { wrapper } = await open('?view=month&date=2026-10-21');
    await enable(wrapper, 'dmt-dev/a');
    await select(wrapper, at('2026-10-24', '00:00'), at('2026-10-26', '00:00'));
    expect(text('[data-test="nw-repeats"]')).toBe('Sat, Sun');
    await click('[data-test="nw-save"]');
    expect(JSON.parse(puts()[0]!.body!).windows.at(-1)).toEqual({ kind: 'nap', days: ['sat', 'sun'], start: '00:00', end: '00:00', wake: 'never' });
  });

  it('refuses a selection over 24 hours in the week view with a notice, and opens no dialog', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    await select(wrapper, at('2026-10-19', '08:00'), at('2026-10-21', '08:00'));
    expect(dialog(wrapper).props('modelValue')).toBe(false);
    expect(wrapper.find('[data-test="select-notice"]').text()).toContain('month view');
  });

  it('shows the refusal of the router and keeps the dialog open', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    await select(wrapper, at('2026-10-19', '08:00'), at('2026-10-19', '10:00'));
    h.fail.add('/workloads/dmt-dev/a/schedule');
    await click('[data-test="nw-save"]');
    expect(dialog(wrapper).props('modelValue')).toBe(true);
    expect(text('[data-test="nw-error"]')).toBe('boom');
  });

  it('does not offer a workload the user may not edit, and says so when none is left', async () => {
    h.list = [row('dmt-dev', 'a', 'Shop', { can: { wake: true, nap: false } }), row('dmt-dev', 'b', 'Blog')];
    h.status = { '/workloads/dmt-dev/a': { ...status('Shop', shopSchedule), can: { wake: true, nap: false } }, '/workloads/dmt-dev/b': status('Blog', blogSchedule) };
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    await select(wrapper, at('2026-10-19', '08:00'), at('2026-10-19', '10:00'));
    expect(text('[data-test="nw-none"]')).toContain('No enabled calendar may be edited');
    await dialog(wrapper).vm.$emit('update:modelValue', false);
    await enable(wrapper, 'dmt-dev/b');
    await select(wrapper, at('2026-10-19', '08:00'), at('2026-10-19', '10:00'));
    expect(dialog(wrapper).props('candidates').map((c: { key: string }) => c.key)).toEqual(['dmt-dev/b']);
  });

  it('gives a first schedule the browser\'s zone', async () => {
    h.list = [row('dmt-dev', 'c', 'Docs', { scheduled: false })];
    const { wrapper } = await open();
    await wrapper.find('[data-test="scheduled-only"] input').setValue(false);
    await enable(wrapper, 'dmt-dev/c');
    await select(wrapper, at('2026-10-19', '08:00'), at('2026-10-19', '10:00'));
    await click('[data-test="nw-save"]');
    expect(JSON.parse(puts()[0]!.body!)).toEqual({ timeZone: 'Europe/Paris', windows: [{ kind: 'awake', days: ['mon'], start: '08:00', end: '10:00' }] });
  });

  it('writes the window on the clock and weekday of the workload\'s zone, and uses the last workload by default', async () => {
    saveSaved('ops@example.com', { enabled: [], last: 'dmt-dev/b' });
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    await enable(wrapper, 'dmt-dev/b');
    // Tue 02:00-04:00 in Paris is Mon 20:00-22:00 in New York.
    await select(wrapper, at('2026-10-20', '02:00'), at('2026-10-20', '04:00'));
    expect(text('[data-test="nw-zone"]')).toContain('America/New_York');
    expect(text('[data-test="nw-repeats"]')).toBe('Mon');
    expect(text('[data-test="nw-times"]')).toBe('20:00–22:00');
    await click('[data-test="nw-save"]');
    expect(puts()[0]!.path).toBe('/workloads/dmt-dev/b/schedule');
    expect(JSON.parse(puts()[0]!.body!)).toEqual({ timeZone: 'America/New_York', windows: [...blogSchedule.windows!, { kind: 'awake', days: ['mon'], start: '20:00', end: '22:00' }] });
  });

  it('recomputes the window when another workload, in another zone, is chosen', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    await enable(wrapper, 'dmt-dev/b');
    await select(wrapper, at('2026-10-20', '02:00'), at('2026-10-20', '04:00'));
    expect(text('[data-test="nw-save"]')).toBe('Save');
    expect((body().querySelector('[data-test="nw-save"]') as HTMLButtonElement).disabled).toBe(true);
    await dialog(wrapper).findAllComponents({ name: 'VSelect' })[0]!.vm.$emit('update:modelValue', 'dmt-dev/a');
    await flushPromises();
    expect(text('[data-test="nw-times"]')).toBe('02:00–04:00');
    await dialog(wrapper).findAllComponents({ name: 'VSelect' })[0]!.vm.$emit('update:modelValue', 'dmt-dev/b');
    await flushPromises();
    expect(text('[data-test="nw-times"]')).toBe('20:00–22:00');
  });

  it('says when a repeated hour moves the window from the selected instants', async () => {
    // FullCalendar reads the repeated 02:30 of a clock change as its first one, so the dialog is given the second directly.
    const wrapper = mount({ render: () => vh(components.VApp, null, () => vh(NewWindowDialog, { modelValue: true, candidates: [{ key: 'r/a', name: 'Shop', schedule: shopSchedule }], selection: { start: new Date('2026-10-25T01:30:00Z'), end: new Date('2026-10-25T03:00:00Z'), month: false } })) }, { attachTo: document.body, global: { plugins: [createVuetify({ components, directives })] } });
    mounted.push(wrapper);
    await flushPromises();
    // The clocks of Paris go back on Sun 25 Oct at 03:00: this 02:30 is the second; the weekly window starts at the first.
    expect(text('[data-test="nw-clock"]')).toBe('On Sun 25 Oct the clock change moves it to 02:30 CEST–04:00 CET (Europe/Paris).');
    wrapper.unmount();
    mounted.length = 0;
    const plain = mount({ render: () => vh(components.VApp, null, () => vh(NewWindowDialog, { modelValue: true, candidates: [{ key: 'r/a', name: 'Shop', schedule: shopSchedule }], selection: { start: at('2026-10-21', '08:00'), end: at('2026-10-21', '10:00'), month: false } })) }, { attachTo: document.body, global: { plugins: [createVuetify({ components, directives })] } });
    mounted.push(plain);
    await flushPromises();
    expect(body().querySelector('[data-test="nw-clock"]')).toBeNull();
  });

  it('opens from the New window button with the next hour of today', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    const button = wrapper.find('[data-test="new-window"]');
    expect(button.attributes('disabled')).toBeUndefined();
    const before = Date.now();
    await button.trigger('click');
    await flushPromises();
    const sel = dialog(wrapper).props('selection') as { start: Date; end: Date; month: boolean };
    expect(dialog(wrapper).props('modelValue')).toBe(true);
    expect(sel.month).toBe(false);
    expect(sel.start.getMinutes()).toBe(0);
    expect(sel.start.getTime()).toBeGreaterThan(before);
    expect(sel.start.getTime() - before).toBeLessThanOrEqual(3_600_000);
    expect(sel.end.getTime() - sel.start.getTime()).toBe(3_600_000);
  });
});
