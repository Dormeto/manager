process.env.TZ = 'Europe/Paris';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h as vh } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { mdiWeatherNight, mdiWeatherSunny } from '@mdi/js';
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
  errors: [] as { router: string; message: string }[],
  // Reads held until released, with how many are in flight at most.
  hold: null as null | Promise<void>,
  // Run once, while a read is out: what lands in that gap.
  duringRead: null as null | (() => Promise<void>),
  active: 0,
  peak: 0,
}));
vi.mock('../src/api', () => ({
  api: vi.fn(async (path: string, init: RequestInit = {}) => {
    h.calls.push({ path, method: init.method ?? 'GET', ...(init.body ? { body: String(init.body) } : {}) });
    if (path.startsWith('/workloads?')) {
      const q = new URLSearchParams(path.slice('/workloads?'.length));
      const [limit, offset] = [Number(q.get('limit') ?? 50), Number(q.get('offset') ?? 0)];
      return { workloads: h.list.slice(offset, offset + limit), total: h.list.length, errors: h.errors, routers: h.routers };
    }
    if (h.hold && !init.method) {
      h.active++;
      h.peak = Math.max(h.peak, h.active);
      try { await h.hold; } finally { h.active--; }
    }
    if (!init.method && h.duringRead) {
      const during = h.duringRead;
      h.duringRead = null;
      await during();
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
const toast = () => document.querySelector('.dm-toast .v-snackbar__content')?.textContent?.trim();
const eventTitles = (w: VueWrapper) => w.findAll('.fc-event').map((e) => e.text());

beforeEach(() => { h.calls.length = 0; h.fail.clear(); h.errors = []; h.hold = null; h.duringRead = null; h.active = 0; h.peak = 0; seed(); window.localStorage.clear(); });
afterEach(() => { mounted.splice(0).forEach((w) => w.unmount()); document.body.innerHTML = ''; });

describe('Schedules view: the calendars panel', () => {
  it('lists the scheduled workloads by default, the others when "Scheduled only" is off, and searches by name, id and router', async () => {
    const { wrapper } = await open();
    const names = () => wrapper.findAll('[data-test^="calendar-"]').map((r) => r.attributes('data-test')!.replace('calendar-', ''));
    expect(names()).toEqual(['dmt-dev/b', 'old/d', 'dmt-dev/a']);
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

  it('keeps the enabled calendars of a router that failed to list, drops those gone from a router that listed, and shows the error', async () => {
    saveSaved('ops@example.com', { enabled: [{ key: 'dmt-dev/a', color: 0 }, { key: 'down/x', color: 1 }, { key: 'dmt-dev/gone', color: 2 }] });
    h.errors = [{ router: 'down', message: 'timed out' }];
    const { wrapper } = await open();
    const keys = () => (wrapper.findComponent(SchedulesView).vm as unknown as { enabled: { key: string }[] }).enabled.map((e) => e.key);
    expect(keys()).toEqual(['dmt-dev/a', 'down/x']);
    expect(wrapper.find('[data-test="router-error"]').text()).toContain('down');
    expect(wrapper.find('[data-test="router-error"]').text()).toContain('timed out');
    expect(JSON.parse(window.localStorage.getItem('dm-schedules:ops@example.com')!).enabled.map((e: { key: string }) => e.key)).toContain('down/x');
  });

  it('says "router 0.31.0 needed" for a workload whose own answer has no schedule, when the list gave no router versions', async () => {
    h.list = [row('old', 'd', 'Legacy', { scheduled: undefined })];
    h.routers = [];
    h.status = { '/workloads/old/d': { name: 'Legacy', state: 'AWAKE', router: { version: '0.30.2' }, can: { wake: true, nap: true } } };
    const { wrapper } = await open();
    await wrapper.find('[data-test="scheduled-only"] input').setValue(false);
    expect(wrapper.find('[data-test="calendar-old/d"]').text()).not.toContain('router 0.31.0 needed');
    await enable(wrapper, 'old/d');
    expect(wrapper.find('[data-test="calendar-old/d"]').text()).toContain('router 0.31.0 needed');
    // Still unticked from the panel.
    expect(wrapper.find('[data-test="calendar-old/d"] input').attributes('disabled')).toBeUndefined();
  });

  it('keeps only the latest read of a calendar unticked and ticked again while the first was in flight', async () => {
    const api = (await import('../src/api')).api as unknown as ReturnType<typeof vi.fn>;
    const impl = api.getMockImplementation()! as (p: string, i?: RequestInit) => Promise<unknown>;
    let first = true;
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/workloads/dmt-dev/a' && !init?.method) {
        if (first) { first = false; await slow; return status('Stale', shopSchedule); }
        return status('Fresh', shopSchedule);
      }
      return impl(path, init);
    });
    try {
      const { wrapper } = await open();
      const vm = () => wrapper.findComponent(SchedulesView).vm as unknown as { reads: Record<string, { data?: { name: string } }> };
      await wrapper.find('[data-test="calendar-dmt-dev/a"] input').setValue(true);
      await wrapper.find('[data-test="calendar-dmt-dev/a"] input').setValue(false);
      await wrapper.find('[data-test="calendar-dmt-dev/a"] input').setValue(true);
      await flushPromises();
      expect(vm().reads['dmt-dev/a']!.data!.name).toBe('Fresh');
      release();
      await flushPromises();
      expect(vm().reads['dmt-dev/a']!.data!.name).toBe('Fresh');
    } finally {
      api.mockImplementation(impl);
    }
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
    await ev.trigger('mouseover');
    await vi.waitFor(() => expect(document.querySelector('.v-overlay--active [data-test="event-tip"]')?.textContent).toContain('America/New_York'));
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
    h.list[0] = row('dmt-dev', 'a', 'Shop', { backends: ['ecs', 'rds-instance'] });
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    expect(wrapper.findComponent(ScheduleDialog).props('modelValue')).toBe(false);
    await wrapper.find('.fc-event.dm-ev--awake').trigger('click');
    await flushPromises();
    const dialog = wrapper.findComponent(ScheduleDialog);
    expect(dialog.props('modelValue')).toBe(true);
    expect(dialog.props('name')).toBe('Shop');
    expect(dialog.props('kinds')).toEqual(['ecs', 'rds-instance']);
    expect(dialog.props('schedule')).toEqual(shopSchedule);
    dialog.vm.$emit('submit', { ...shopSchedule, windows: [shopSchedule.windows![0]] });
    await flushPromises();
    const put = h.calls.find((c) => c.method === 'PUT')!;
    expect(put.path).toBe('/workloads/dmt-dev/a/schedule');
    expect(JSON.parse(put.body!).windows).toHaveLength(1);
    expect(h.calls.filter((c) => c.path === '/workloads/dmt-dev/a' && c.method === 'GET')).toHaveLength(2);
    expect(wrapper.findComponent(ScheduleDialog).props('modelValue')).toBe(false);
    expect(toast()).toBe('Schedule of Shop saved');
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
    const push = vi.spyOn(router, 'push');
    await enable(wrapper, 'dmt-dev/a b');
    await wrapper.find('.fc-event.dm-ev--awake').trigger('click');
    await flushPromises();
    expect(push).toHaveBeenCalledWith({ name: 'workload', params: { router: 'dmt-dev', id: 'a b' } });
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
const field = (w: VueWrapper, name: string) => dialog(w).findComponent(`[data-test="${name}"]`) as unknown as { props(n: string): unknown; vm: { $emit(...a: unknown[]): void } };
const times = (w: VueWrapper) => `${field(w, 'nw-start').props('modelValue')}–${field(w, 'nw-end').props('modelValue')}`;
const puts = () => h.calls.filter((c) => c.method === 'PUT');
let recorded: Schedule | null = null;

describe('Schedules view: creating a window', () => {
  it('opens the dialog prefilled from a week selection and saves the existing windows plus the new one', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    await select(wrapper, at('2026-10-19', '08:00'), at('2026-10-19', '10:00'));
    expect(dialog(wrapper).props('modelValue')).toBe(true);
    expect(text('[data-test="nw-repeats"]')).toBe('Mon');
    expect(times(wrapper)).toBe('08:00–10:00');
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
    await field(wrapper, 'nw-wake').vm.$emit('update:modelValue', 'header');
    await flushPromises();
    await click('[data-test="nw-save"]');
    expect(JSON.parse(puts()[0]!.body!).windows.at(-1)).toEqual({ kind: 'nap', days: ['mon'], start: '23:30', end: '23:45', wake: 'header' });
  });

  it('makes an overnight window of a selection across midnight', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    await select(wrapper, at('2026-10-19', '22:00'), at('2026-10-20', '06:00'));
    expect(times(wrapper)).toBe('22:00–06:00');
    expect(text('[data-test="nw-sentence"]')).toBe('Mon, 22:00–06:00 next day');
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
    expect(times(wrapper)).toBe('20:00–22:00');
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
    await field(wrapper, 'nw-workload').vm.$emit('update:modelValue', 'dmt-dev/a');
    await flushPromises();
    expect(times(wrapper)).toBe('02:00–04:00');
    await field(wrapper, 'nw-workload').vm.$emit('update:modelValue', 'dmt-dev/b');
    await flushPromises();
    expect(times(wrapper)).toBe('20:00–22:00');
  });

  it('says when a repeated hour moves the window from the selected instants', async () => {
    // FullCalendar (local time) reads a repeated hour as its first instance: a real drag cannot reach the second 02:30, so the dialog is given its instants directly.
    const wrapper = mount({ render: () => vh(components.VApp, null, () => vh(NewWindowDialog, { modelValue: true, candidates: [{ key: 'r/a', name: 'Shop', schedule: shopSchedule }], selection: { start: new Date('2026-10-25T01:30:00Z'), end: new Date('2026-10-25T03:00:00Z'), month: false } })) }, { attachTo: document.body, global: { plugins: [createVuetify({ components, directives })] } });
    mounted.push(wrapper);
    await flushPromises();
    // The clocks of Paris go back on Sun 25 Oct at 03:00: this 02:30 is the second; the weekly window starts at the first.
    expect(text('[data-test="nw-clock"]')).toBe('On Sun 25 Oct the clock change moves this window to 02:30–04:00 (Europe/Paris).');
    wrapper.unmount();
    mounted.length = 0;
    const plain = mount({ render: () => vh(components.VApp, null, () => vh(NewWindowDialog, { modelValue: true, candidates: [{ key: 'r/a', name: 'Shop', schedule: shopSchedule }], selection: { start: at('2026-10-21', '08:00'), end: at('2026-10-21', '10:00'), month: false } })) }, { attachTo: document.body, global: { plugins: [createVuetify({ components, directives })] } });
    mounted.push(plain);
    await flushPromises();
    expect(body().querySelector('[data-test="nw-clock"]')).toBeNull();
  });

  it('keeps top padding on the dialog body so the workload field\'s floating label is not clipped', async () => {
    const wrapper = mount({ render: () => vh(components.VApp, null, () => vh(NewWindowDialog, { modelValue: true, candidates: [{ key: 'r/a', name: 'Shop', schedule: shopSchedule }], selection: { start: at('2026-10-21', '08:00'), end: at('2026-10-21', '10:00'), month: false } })) }, { attachTo: document.body, global: { plugins: [createVuetify({ components, directives })] } });
    mounted.push(wrapper);
    await flushPromises();
    expect(body().querySelector('[data-test="nw-body"]')?.classList.contains('pt-3')).toBe(true);
  });

  it('saves the days and times edited in the dialog, and keeps them when the workload changes', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    await enable(wrapper, 'dmt-dev/b');
    await select(wrapper, at('2026-10-19', '08:00'), at('2026-10-19', '10:00'));
    await field(wrapper, 'nw-workload').vm.$emit('update:modelValue', 'dmt-dev/a');
    await flushPromises();
    await click('[data-test="nw-day-tue"]');
    await field(wrapper, 'nw-start').vm.$emit('update:modelValue', '09:15');
    await field(wrapper, 'nw-end').vm.$emit('update:modelValue', '09:15');
    await flushPromises();
    expect(text('[data-test="nw-sentence"]')).toContain('09:15–09:15 next day');
    expect(text('[data-test="nw-repeats"]')).toContain('Mon, Tue');
    await field(wrapper, 'nw-workload').vm.$emit('update:modelValue', 'dmt-dev/b');
    await flushPromises();
    expect(times(wrapper)).toBe('09:15–09:15');
    expect(text('[data-test="nw-zone"]')).toContain('America/New_York');
    await click('[data-test="nw-save"]');
    expect(puts()[0]!.path).toBe('/workloads/dmt-dev/b/schedule');
    expect(JSON.parse(puts()[0]!.body!).windows.at(-1)).toEqual({ kind: 'awake', days: ['mon', 'tue'], start: '09:15', end: '09:15' });
  });

  it('stops reading the list when the server ignores the offset, and says the list is incomplete', async () => {
    h.list = Array.from({ length: 3 }, (_, i) => row('dmt-dev', `w${i}`, `W${i}`));
    const api = (await import('../src/api')).api as unknown as ReturnType<typeof vi.fn>;
    const impl = api.getMockImplementation()! as (p: string, i?: RequestInit) => Promise<unknown>;
    api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith('/workloads?')) { h.calls.push({ path, method: 'GET' }); return { workloads: h.list.slice(0, 2), total: 5000, errors: [], routers: h.routers }; }
      return impl(path, init);
    });
    try {
      const { wrapper } = await open();
      expect(h.calls.filter((c) => c.path.startsWith('/workloads?'))).toHaveLength(2);
      expect(wrapper.findAll('[data-test^="calendar-"]')).toHaveLength(2);
      expect(wrapper.find('[data-test="list-incomplete"]').exists()).toBe(true);
    } finally {
      api.mockImplementation(impl);
    }
  });

  it('sends the whole schedule it read: the exceptions and the maximum nap kept, the windows normalized, no by, at or next', async () => {
    const full = {
      timeZone: 'Europe/Paris',
      windows: [{ kind: 'awake', days: ['fri', 'mon'], start: '08:00', end: '19:00', by: 'x' }, { kind: 'nap', days: ['sat'], start: '20:00', end: '23:00' }],
      exceptions: ['2026-12-25'], maxNapDays: 7, by: 'ops@example.com', at: '2026-10-01T00:00:00.000Z',
    } as unknown as Schedule;
    h.status['/workloads/dmt-dev/a'] = { ...status('Shop', full), next: [{ at: '2026-10-20T06:00:00.000Z', kind: 'awake-start', window: 0 }] };
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    await select(wrapper, at('2026-10-19', '08:00'), at('2026-10-19', '10:00'));
    await click('[data-test="nw-save"]');
    const sent = JSON.parse(puts()[0]!.body!);
    expect(sent).toEqual({
      timeZone: 'Europe/Paris',
      windows: [{ kind: 'awake', days: ['mon', 'fri'], start: '08:00', end: '19:00' }, { kind: 'nap', days: ['sat'], start: '20:00', end: '23:00', wake: 'never' }, { kind: 'awake', days: ['mon'], start: '08:00', end: '10:00' }],
      exceptions: ['2026-12-25'], maxNapDays: 7,
    });
    expect(Object.keys(sent)).toEqual(['timeZone', 'windows', 'exceptions', 'maxNapDays']);
  });

  it('saves what the dialog read when it opened, not a later read of the workload', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    await select(wrapper, at('2026-10-19', '08:00'), at('2026-10-19', '10:00'));
    h.status['/workloads/dmt-dev/a'] = status('Shop', { timeZone: 'Europe/Paris', windows: [{ kind: 'awake', days: ['sun'], start: '01:00', end: '02:00' }] });
    await wrapper.find('[data-test="refresh"]').trigger('click');
    await flushPromises();
    expect(dialog(wrapper).props('candidates')[0]!.schedule!.windows).toHaveLength(1);
    await click('[data-test="nw-save"]');
    expect(JSON.parse(puts()[0]!.body!).windows).toEqual([...shopSchedule.windows!, { kind: 'awake', days: ['mon'], start: '08:00', end: '10:00' }]);
  });

  it('keeps the days edited alone when the workload is changed', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    await enable(wrapper, 'dmt-dev/b');
    await select(wrapper, at('2026-10-19', '08:00'), at('2026-10-19', '10:00'));
    await field(wrapper, 'nw-workload').vm.$emit('update:modelValue', 'dmt-dev/a');
    await flushPromises();
    await click('[data-test="nw-day-tue"]');
    await field(wrapper, 'nw-workload').vm.$emit('update:modelValue', 'dmt-dev/b');
    await flushPromises();
    expect(text('[data-test="nw-repeats"]')).toContain('Mon, Tue');
  });

  it('says why Save is disabled when every day is off, and shows no empty "Repeats every"', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    await select(wrapper, at('2026-10-19', '08:00'), at('2026-10-19', '10:00'));
    await click('[data-test="nw-day-mon"]');
    expect(body().querySelector('[data-test="nw-repeats"]')).toBeNull();
    expect(text('[data-test="nw-days-hint"]')).toBe('Choose at least one day.');
    expect((body().querySelector('[data-test="nw-save"]') as HTMLButtonElement).disabled).toBe(true);
    await click('[data-test="nw-day-wed"]');
    expect(text('[data-test="nw-repeats"]')).toBe('Wed');
    expect(body().querySelector('[data-test="nw-days-hint"]')).toBeNull();
  });

  it('a calendar selection starts a weekly window, which the helper can turn into another pattern', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    await select(wrapper, at('2026-10-19', '12:00'), at('2026-10-19', '13:00'));
    expect(field(wrapper, 'nw-pattern').props('modelValue')).toBe('weekly');
    await field(wrapper, 'nw-pattern').vm.$emit('update:modelValue', 'monthly');
    await flushPromises();
    await field(wrapper, 'nw-month-day').vm.$emit('update:modelValue', '15');
    await flushPromises();
    await field(wrapper, 'nw-from').vm.$emit('update:modelValue', '2099-01-01');
    await flushPromises();
    expect(text('[data-test="nw-sentence"]')).toBe('Monthly on day 15, 12:00–13:00, from 1 Jan 2099, no end date');
    expect(body().querySelectorAll('[data-test="nw-next-list"] li')).toHaveLength(5);
    await click('[data-test="nw-save"]');
    expect(JSON.parse(puts()[0]!.body!).windows.at(-1)).toEqual({ kind: 'awake', start: '12:00', end: '13:00', repeat: { pattern: 'monthly', day: 15 }, from: '2099-01-01' });
  });

  it('keeps Save off on a cron expression it cannot read, and says why', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    await select(wrapper, at('2026-10-19', '12:00'), at('2026-10-19', '13:00'));
    await field(wrapper, 'nw-pattern').vm.$emit('update:modelValue', 'cron');
    await flushPromises();
    await field(wrapper, 'nw-cron').vm.$emit('update:modelValue', '* 8 * * *');
    await flushPromises();
    expect(body().querySelector('[data-test="nw-cron"]')!.closest('.v-input')!.textContent).toContain('minutes must be multiples of 5');
    expect((body().querySelector('[data-test="nw-save"]') as HTMLButtonElement).disabled).toBe(true);
    await field(wrapper, 'nw-cron').vm.$emit('update:modelValue', '30 8 * * 1-5');
    await flushPromises();
    await click('[data-test="nw-save"]');
    expect(JSON.parse(puts()[0]!.body!).windows.at(-1)).toEqual({ kind: 'awake', repeat: { pattern: 'cron', cron: '30 8 * * 1-5', minutes: 60 } });
  });

  it('keeps Save off on an end date left blank', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    await select(wrapper, at('2026-10-19', '12:00'), at('2026-10-19', '13:00'));
    await field(wrapper, 'nw-end-kind').vm.$emit('update:modelValue', 'date');
    await flushPromises();
    expect((body().querySelector('[data-test="nw-save"]') as HTMLButtonElement).disabled).toBe(false);
    await field(wrapper, 'nw-until').vm.$emit('update:modelValue', '');
    await flushPromises();
    expect((body().querySelector('[data-test="nw-save"]') as HTMLButtonElement).disabled).toBe(true);
    expect(body().querySelector('[data-test="nw-until"]')!.closest('.v-input')!.textContent).toContain('choose a date');
  });

  it('shows a note when a calendar has more occurrences than it draws', async () => {
    const dense = Array.from({ length: 20 }, () => ({ kind: 'awake', repeat: { pattern: 'cron', cron: '0,10,20,30,40,50 * * * *', minutes: 5 } }));
    h.status['/workloads/dmt-dev/a'] = { ...(h.status['/workloads/dmt-dev/a'] as object), schedule: { timeZone: 'Europe/Paris', windows: dense } };
    const { wrapper } = await open();
    expect(body().querySelector('[data-test="calendar-capped"]')).toBeNull();
    await enable(wrapper, 'dmt-dev/a');
    expect(text('[data-test="calendar-capped"]')).toMatch(/^Shop: only the first [\d,]+ occurrences are drawn here, up to \d+ \w+\./);
    expect(text('[data-test="calendar-capped"]')).toContain('the schedule applies in full');
  });

  it('saves a recurring window already in the schedule as it was, beside the new one', async () => {
    const stored = { kind: 'awake', start: '10:00', end: '11:00', repeat: { pattern: 'monthly', nth: -1, weekday: 'fri' }, from: '2099-01-01' };
    const wrapper = mount({ render: () => vh(components.VApp, null, () => vh(NewWindowDialog, { modelValue: true, candidates: [{ key: 'r/a', name: 'Shop', schedule: { timeZone: 'UTC', windows: [stored as never] } }], selection: { start: new Date(), end: new Date(Date.now() + 3_600_000), month: false }, last: 'r/a', onSubmit: (arg: { schedule: Schedule }) => { recorded = arg.schedule; } })) }, { attachTo: document.body, global: { plugins: [createVuetify({ components, directives })] } });
    await flushPromises();
    await click('[data-test="nw-save"]');
    expect(recorded!.windows![0]).toEqual(stored);
    wrapper.unmount();
  });

  it('adds the hint to the refusal of a router that does not know recurrences', async () => {
    const wrapper = mount({ render: () => vh(components.VApp, null, () => vh(NewWindowDialog, { modelValue: true, candidates: [{ key: 'r/a', name: 'Shop', schedule: null }], selection: { start: new Date(), end: new Date(Date.now() + 3_600_000), month: false }, last: 'r/a', error: 'windows[0].from: unknown field' })) }, { attachTo: document.body, global: { plugins: [createVuetify({ components, directives })] } });
    await flushPromises();
    expect(text('[data-test="nw-error"]')).toBe('windows[0].from: unknown field. Recurrences need router 0.36.0 or later.');
    wrapper.unmount();
  });

  it('does not offer a calendar whose last read failed', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    await enable(wrapper, 'dmt-dev/b');
    h.fail.add('/workloads/dmt-dev/b');
    await wrapper.find('[data-test="refresh"]').trigger('click');
    await flushPromises();
    await select(wrapper, at('2026-10-19', '08:00'), at('2026-10-19', '10:00'));
    expect(dialog(wrapper).props('candidates').map((c: { key: string }) => c.key)).toEqual(['dmt-dev/a']);
  });

  it('does not offer a calendar that is being read again', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    await enable(wrapper, 'dmt-dev/b');
    let release!: () => void;
    h.hold = new Promise<void>((r) => { release = r; });
    await wrapper.find('[data-test="refresh"]').trigger('click');
    await vi.waitFor(() => expect(h.active).toBe(2));
    await select(wrapper, at('2026-10-19', '08:00'), at('2026-10-19', '10:00'));
    expect(dialog(wrapper).props('candidates')).toEqual([]);
    release();
    await flushPromises();
  });

  it('stops at 50 pages of a list that always has new rows, and says it is incomplete', async () => {
    const api = (await import('../src/api')).api as unknown as ReturnType<typeof vi.fn>;
    const impl = api.getMockImplementation()! as (p: string, i?: RequestInit) => Promise<unknown>;
    api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith('/workloads?')) {
        h.calls.push({ path, method: 'GET' });
        const offset = Number(new URLSearchParams(path.split('?')[1]).get('offset'));
        return { workloads: [row('dmt-dev', `n${offset}`, `N${offset}`)], total: 1_000_000, errors: [], routers: h.routers };
      }
      return impl(path, init);
    });
    try {
      const { wrapper } = await open();
      expect(h.calls.filter((c) => c.path.startsWith('/workloads?'))).toHaveLength(50);
      expect(wrapper.find('[data-test="list-incomplete"]').exists()).toBe(true);
    } finally {
      api.mockImplementation(impl);
    }
  });

  it('clears a schedule from its dialog: DELETE, then the workload is read again', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    await wrapper.find('.fc-event.dm-ev--awake').trigger('click');
    await flushPromises();
    h.calls.length = 0;
    wrapper.findComponent(ScheduleDialog).vm.$emit('clear');
    await flushPromises();
    expect(h.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE /workloads/dmt-dev/a/schedule', 'GET /workloads/dmt-dev/a']);
    expect(wrapper.findComponent(ScheduleDialog).props('modelValue')).toBe(false);
  });

  it('keeps the dialog open and shows the refusal when clearing fails', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    await wrapper.find('.fc-event.dm-ev--awake').trigger('click');
    await flushPromises();
    h.fail.add('/workloads/dmt-dev/a/schedule');
    wrapper.findComponent(ScheduleDialog).vm.$emit('clear');
    await flushPromises();
    expect(wrapper.findComponent(ScheduleDialog).props('modelValue')).toBe(true);
    expect(wrapper.findComponent(ScheduleDialog).props('error')).toBe('boom');
  });

  it('hints at touch and hold at phone width only', async () => {
    const wide = await open();
    expect(wide.wrapper.find('[data-test="touch-hint"]').exists()).toBe(false);
    wide.wrapper.unmount();
    const { wrapper } = await open('?view=week&date=2026-10-21', 420);
    expect(wrapper.find('[data-test="touch-hint"]').text()).toContain('Touch and hold');
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

describe('SchedulesView styles', () => {
  it('overrides the FullCalendar icon font (the CSP refuses its data: font), keeps titles on one line, caps the stacking and themes the popover', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(process.cwd(), 'src/views/SchedulesView.vue'), 'utf8');
    expect(src).toMatch(/:deep\(\.fc-icon\)\s*\{\s*font-family:\s*inherit\s*!important/);
    expect(src).not.toMatch(/font-family:\s*fcicons/);
    for (const c of ['fc-icon-x', 'fc-icon-chevron-left', 'fc-icon-chevron-right']) expect(src).toContain(`:deep(.${c}::before)`);
    expect(src).not.toMatch(/white-space:\s*normal/);
    expect(src).toMatch(/text-overflow:\s*ellipsis/);
    expect(src).toMatch(/--fc-page-bg-color:\s*rgb\(var\(--v-theme-surface\)\)/);
    expect(src).toMatch(/:deep\(\.fc-popover\)\s*\{[^}]*box-shadow/);
    expect(src).toContain('eventMaxStack: 3');
    expect(src).toMatch(/dayGridMonth:\s*\{\s*eventDisplay:\s*'list-item',\s*dayMaxEvents:\s*true/);
    // A night's nap (20:00–07:00) shows on its start day only, not again at 00:00 on the next day.
    expect(src).toMatch(/dayGridMonth:\s*\{[^}]*nextDayThreshold:\s*'12:00'/);
    expect(src).toMatch(/\.dm-past\)\s*\{\s*opacity/);
  });
});

describe('Schedules view: notifications', () => {
  it('names the workload on a clear, and says when a write fails while the dialog stays open', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    await wrapper.find('.fc-event.dm-ev--awake').trigger('click');
    await flushPromises();
    h.fail.add('/workloads/dmt-dev/a/schedule');
    wrapper.findComponent(ScheduleDialog).vm.$emit('submit', shopSchedule);
    await flushPromises();
    expect(wrapper.findComponent(ScheduleDialog).props('modelValue')).toBe(true);
    expect(toast()).toBe('Schedule of Shop not saved: boom');
    wrapper.findComponent(ScheduleDialog).vm.$emit('clear');
    await flushPromises();
    expect(wrapper.findComponent(ScheduleDialog).props('modelValue')).toBe(true);
    expect(toast()).toBe('Schedule of Shop not cleared: boom');
    h.fail.clear();
    wrapper.findComponent(ScheduleDialog).vm.$emit('clear');
    await flushPromises();
    expect(wrapper.findComponent(ScheduleDialog).props('modelValue')).toBe(false);
    expect(toast()).toBe('Schedule of Shop cleared');
  });

  const JOINED: Schedule = { timeZone: 'Europe/Paris', windows: [{ kind: 'awake', days: ['mon'], start: '08:00', end: '12:00' }, { kind: 'awake', days: ['mon'], start: '12:10', end: '18:00' }] };
  it('draws at the value the status answers, one bar for a joined gap; two on a router that answers none', async () => {
    h.status['/workloads/dmt-dev/a'] = { ...status('Shop', JOINED), joinMinutes: 15, joinFrom: 'default', joinInherited: { joinMinutes: 15, joinFrom: 'default' } };
    const { wrapper } = await open('?view=week&date=2026-10-19');
    await enable(wrapper, 'dmt-dev/a');
    expect(eventTitles(wrapper).filter((t) => t.includes('Shop'))).toHaveLength(1);
    wrapper.unmount();
    h.status['/workloads/dmt-dev/a'] = status('Shop', JOINED);
    const older = await open('?view=week&date=2026-10-19');
    await enable(older.wrapper, 'dmt-dev/a');
    expect(eventTitles(older.wrapper).filter((t) => t.includes('Shop'))).toHaveLength(2);
  });

  it('a new window keeps the schedule\'s own value, 0 included', async () => {
    h.status['/workloads/dmt-dev/a'] = { ...status('Shop', { ...shopSchedule, joinMinutes: 0 }), joinMinutes: 0, joinFrom: 'workload', joinInherited: { joinMinutes: 15, joinFrom: 'default' } };
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    await select(wrapper, at('2026-10-24', '12:00'), at('2026-10-24', '13:00'));
    await click('[data-test="nw-save"]');
    expect(JSON.parse(h.calls.find((c) => c.method === 'PUT')!.body!).joinMinutes).toBe(0);
  });

  it('names the workload after a new window', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    await select(wrapper, at('2026-10-19', '12:00'), at('2026-10-19', '13:00'));
    await click('[data-test="nw-save"]');
    expect(toast()).toBe('Schedule of Shop saved');
  });
});

describe('Schedules view: the shared tooltip of the calendar items', () => {
  it('replaces the title attribute, follows the hovered or focused item, and goes on leaving', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/b');
    const ev = wrapper.find('.fc-event.dm-ev--awake');
    expect(ev.attributes('title')).toBeUndefined();
    const tip = () => document.querySelector('.v-overlay--active [data-test="event-tip"]')?.textContent;
    expect(tip()).toBeUndefined();
    await ev.trigger('mouseover');
    await vi.waitFor(() => expect(tip()).toContain('Wed, 09:00–12:00'));
    expect(tip()).toContain('America/New_York');
    expect(tip()).toContain('Drag it, or its top or bottom edge');
    await ev.trigger('mouseout');
    await vi.waitFor(() => expect(tip()).toBeUndefined());
    await ev.trigger('focusin');
    await vi.waitFor(() => expect(tip()).toContain('Wed, 09:00–12:00'));
    await ev.trigger('focusout');
    await vi.waitFor(() => expect(tip()).toBeUndefined());
    expect(wrapper.findAllComponents({ name: 'VTooltip' }).filter((t) => t.attributes('data-test') === 'event-tooltip' || t.props('activator') !== undefined).length).toBeLessThanOrEqual(1);
  });
});

describe('Schedules view: the title of a calendar item\'s tooltip', () => {
  it('is the workload\'s name and a chip of its kind with its icon: a sun for awake, a moon for a nap', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    const head = () => document.querySelector('.v-overlay--active [data-test="event-tip-head"]');
    const chip = () => wrapper.findAllComponents({ name: 'VChip' }).find((c) => c.attributes('data-test') === 'event-tip-kind')!;
    for (const [kind, label, icon] of [['awake', 'Awake', mdiWeatherSunny], ['nap', 'Nap (wake: header)', mdiWeatherNight]] as const) {
      const ev = wrapper.find(`.fc-event.dm-ev--${kind}`);
      await ev.trigger('mouseover');
      await vi.waitFor(() => expect(head()?.textContent).toContain(label));
      expect(head()!.querySelector('[data-test="event-tip-name"]')!.textContent).toBe('Shop');
      expect(chip().text()).toBe(label);
      expect(chip().props('prependIcon')).toBe(icon);
      await ev.trigger('mouseout');
      await vi.waitFor(() => expect(head()).toBeNull());
    }
  });
});

describe('Schedules view: moving a window by dragging it', () => {
  type Delta = { years: number; months: number; days: number; milliseconds: number };
  type Drawn = { start: Date; end: Date; extendedProps: Record<string, unknown> };
  type Drop = { event: Drawn; oldEvent: Drawn; delta: Delta; revert(): void };
  type Resize = { event: Drawn; oldEvent: Drawn; startDelta: Delta; endDelta: Delta; revert(): void };
  type Options = { events: Drawn[]; eventDrop(arg: Drop): Promise<void>; eventResize(arg: Resize): Promise<void> };
  // FullCalendar's delta between two instants: days and time of day on the calendar's clock, the browser's here (diffDayAndTime).
  const deltaOf = (from: Date, to: Date): Delta => {
    const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
    const time = (d: Date) => (d.getHours() * 60 + d.getMinutes()) * 60_000;
    return { years: 0, months: 0, days: Math.round((day(to) - day(from)) / 86_400_000), milliseconds: time(to) - time(from) };
  };
  const optionsOf = (w: VueWrapper) => w.findComponent(FullCalendar).props('options') as Options;
  // The item as drawn, or one of an hour where the view does not show it.
  const drawnAt = (w: VueWrapper, key: string, window: number, from: string): Drawn => optionsOf(w).events.find((e) => e.extendedProps.key === key && e.start.getTime() === Date.parse(from))
    ?? { start: new Date(from), end: new Date(Date.parse(from) + 3_600_000), extendedProps: { key, window, windows: [window] } };
  const scopeDialog = () => document.querySelector('[data-test="scope-dialog"]');
  // Answers the question when it is asked: a scope, or Cancel (null).
  const answer = async (scope: 'series' | 'occurrence' | null) => {
    if (!scopeDialog()) return;
    (document.querySelector(`[data-test="scope-${scope ?? 'cancel'}"]`) as HTMLButtonElement).click();
    await flushPromises();
  };
  const drop = async (w: VueWrapper, key: string, window: number, from: string, to: string, scope: 'series' | 'occurrence' | null = 'series') => {
    const revert = vi.fn();
    const old = drawnAt(w, key, window, from);
    const shift = Date.parse(to) - Date.parse(from);
    const done = optionsOf(w).eventDrop({ event: { ...old, start: new Date(to), end: new Date(old.end.getTime() + shift) }, oldEvent: old, delta: deltaOf(new Date(from), new Date(to)), revert });
    await flushPromises();
    await answer(scope);
    await done;
    await flushPromises();
    return revert;
  };
  const NONE = { years: 0, months: 0, days: 0, milliseconds: 0 };
  const resize = async (w: VueWrapper, key: string, window: number, from: string, edge: 'start' | 'end', to: string, scope: 'series' | 'occurrence' | null = 'series') => {
    const revert = vi.fn();
    const old = drawnAt(w, key, window, from);
    const moved = edge === 'start' ? { ...old, start: new Date(to) } : { ...old, end: new Date(to) };
    const delta = edge === 'start' ? deltaOf(old.start, new Date(to)) : deltaOf(old.end, new Date(to));
    const done = optionsOf(w).eventResize({ event: moved, oldEvent: old, startDelta: edge === 'start' ? delta : NONE, endDelta: edge === 'end' ? delta : NONE, revert });
    await flushPromises();
    await answer(scope);
    await done;
    await flushPromises();
    return revert;
  };
  const SHOP_MON = '2026-10-19T08:00:00+02:00';
  // A router since 0.36.0: it answers the join levels.
  const recent = (name: string, schedule: Schedule) => ({ ...status(name, schedule), joinMinutes: 15, joinFrom: 'default', joinInherited: { joinMinutes: 15, joinFrom: 'default' } });

  it('moves every occurrence from a fresh read, leaves the others and the exceptions alone, and says so', async () => {
    h.status['/workloads/dmt-dev/a'] = status('Shop', { ...shopSchedule, exceptions: ['2026-12-25'], maxNapDays: 7 });
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    // Someone added a window since the calendar read the schedule: the fresh read has it, and it stays.
    const added = { kind: 'nap' as const, days: ['sat' as const], start: '00:00', end: '00:00', wake: 'never' as const };
    h.status['/workloads/dmt-dev/a'] = status('Shop', { ...shopSchedule, windows: [...shopSchedule.windows!, added], exceptions: ['2026-12-25'], maxNapDays: 7 });
    h.calls.length = 0;
    const revert = await drop(wrapper, 'dmt-dev/a', 0, SHOP_MON, '2026-10-19T09:30:00+02:00');
    expect(revert).not.toHaveBeenCalled();
    expect(h.calls[0]).toMatchObject({ method: 'GET', path: '/workloads/dmt-dev/a' });
    const puts_ = h.calls.filter((c) => c.method === 'PUT');
    expect(puts_).toHaveLength(1);
    expect(puts_[0]!.path).toBe('/workloads/dmt-dev/a/schedule');
    expect(JSON.parse(puts_[0]!.body!)).toEqual({
      timeZone: 'Europe/Paris',
      windows: [{ ...shopSchedule.windows![0], start: '09:30', end: '20:30' }, shopSchedule.windows![1], added],
      exceptions: ['2026-12-25'], maxNapDays: 7,
    });
    expect(toast()).toBe('Window moved: every occurrence of Shop now runs Mon–Fri, 09:30–20:30');
  });

  it('moves by the calendar\'s own delta, whatever the schedule\'s zone', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/b');
    await drop(wrapper, 'dmt-dev/b', 0, '2026-10-21T09:00:00-04:00', '2026-10-22T09:00:00-04:00');
    expect(JSON.parse(puts()[0]!.body!).windows[0]).toEqual({ kind: 'awake', days: ['thu'], start: '09:00', end: '12:00' });
  });

  it('a whole-day drag keeps the clock time across the browser\'s clock change, the schedule in another zone', async () => {
    h.status['/workloads/dmt-dev/a'] = status('Shop', { timeZone: 'UTC', windows: [{ kind: 'awake', days: ['mon'], start: '08:00', end: '12:00' }] });
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    // Mon 22 Mar 2027 to Mon 29 Mar 2027 in a browser in Paris: 7 days on its clock, 167 hours of instants.
    await drop(wrapper, 'dmt-dev/a', 0, '2027-03-22T09:00:00+01:00', '2027-03-29T09:00:00+02:00');
    expect(JSON.parse(puts()[0]!.body!).windows[0]).toEqual({ kind: 'awake', days: ['mon'], start: '08:00', end: '12:00' });
  });

  it('says why the series can\'t move, offers this occurrence alone, and Cancel puts the item back and writes nothing', async () => {
    h.status['/workloads/dmt-dev/a'] = recent('Shop', { timeZone: 'Europe/Paris', windows: [{ kind: 'awake', start: '08:00', end: '09:00', repeat: { pattern: 'monthly', day: 31 } }] });
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    const revert = vi.fn();
    const old = drawnAt(wrapper, 'dmt-dev/a', 0, '2026-10-31T08:00:00+01:00');
    const done = optionsOf(wrapper).eventDrop({ event: { ...old, start: new Date('2026-11-01T08:00:00+01:00'), end: new Date('2026-11-01T09:00:00+01:00') }, oldEvent: old, delta: deltaOf(old.start, new Date('2026-11-01T08:00:00+01:00')), revert });
    await flushPromises();
    expect(document.querySelector('[data-test="scope-change"]')!.textContent).toBe('Shop: Sat 31 Oct 2026, 08:00–09:00 → Sun 1 Nov 2026, 08:00–09:00');
    expect((document.querySelector('[data-test="scope-series"]') as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('[data-test="scope-series-line"]')!.textContent).toContain('would not all move alike');
    expect((document.querySelector('[data-test="scope-occurrence"]') as HTMLButtonElement).disabled).toBe(false);
    expect(document.querySelector('[data-test="scope-occurrence-line"]')!.textContent).toBe('Sun 1 Nov 2026, 08:00–09:00 only; the series skips 31 Oct 2026.');
    await answer(null);
    await done;
    expect(revert).toHaveBeenCalledOnce();
    expect(puts()).toEqual([]);
    expect(scopeDialog()).toBeNull();
  });

  it('moves this occurrence alone: its date skipped on the series, a window of that date at the new times', async () => {
    h.status['/workloads/dmt-dev/a'] = recent('Shop', shopSchedule);
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    const revert = await drop(wrapper, 'dmt-dev/a', 0, SHOP_MON, '2026-10-19T09:30:00+02:00', 'occurrence');
    expect(revert).not.toHaveBeenCalled();
    expect(JSON.parse(puts()[0]!.body!).windows).toEqual([
      { ...shopSchedule.windows![0], exceptions: ['2026-10-19'] }, shopSchedule.windows![1],
      { kind: 'awake', start: '09:30', end: '20:30', repeat: { pattern: 'daily' }, from: '2026-10-19', until: '2026-10-19' },
    ]);
    expect(toast()).toBe('One occurrence of Shop moved: Mon 19 Oct 2026, 09:30–20:30; the series skips 19 Oct 2026');
  });

  it('moves a window of one date without asking', async () => {
    const single = { kind: 'awake' as const, start: '08:00', end: '12:00', repeat: { pattern: 'daily' as const }, from: '2026-10-20', until: '2026-10-20' };
    h.status['/workloads/dmt-dev/a'] = status('Shop', { timeZone: 'Europe/Paris', windows: [single] });
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    const revert = vi.fn();
    const old = drawnAt(wrapper, 'dmt-dev/a', 0, '2026-10-20T08:00:00+02:00');
    await optionsOf(wrapper).eventDrop({ event: { ...old, start: new Date('2026-10-21T08:00:00+02:00'), end: new Date('2026-10-21T12:00:00+02:00') }, oldEvent: old, delta: deltaOf(old.start, new Date('2026-10-21T08:00:00+02:00')), revert });
    await flushPromises();
    expect(scopeDialog()).toBeNull();
    expect(JSON.parse(puts()[0]!.body!).windows).toEqual([{ ...single, from: '2026-10-21', until: '2026-10-21' }]);
    expect(toast()).toBe('Window moved: Shop now runs once on 21 Oct 2026, 08:00–12:00');
  });

  it('changes the end of the series, or the start of this occurrence alone, by its edges', async () => {
    h.status['/workloads/dmt-dev/a'] = recent('Shop', shopSchedule);
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    await resize(wrapper, 'dmt-dev/a', 0, SHOP_MON, 'end', '2026-10-19T19:30:00+02:00');
    expect(JSON.parse(puts()[0]!.body!).windows[0]).toEqual({ ...shopSchedule.windows![0], end: '19:30' });
    expect(toast()).toBe('Window changed: every occurrence of Shop now runs Mon–Fri, 08:00–19:30');
    h.calls.length = 0;
    await resize(wrapper, 'dmt-dev/a', 0, SHOP_MON, 'start', '2026-10-19T07:00:00+02:00', 'occurrence');
    const windows = JSON.parse(puts()[0]!.body!).windows;
    expect(windows.at(-1)).toEqual({ kind: 'awake', start: '07:00', end: '19:00', repeat: { pattern: 'daily' }, from: '2026-10-19', until: '2026-10-19' });
    expect(toast()).toBe('One occurrence of Shop changed: Mon 19 Oct 2026, 07:00–19:00; the series skips 19 Oct 2026');
  });

  it('a router before 0.36.0 moves the series only, and says why not this occurrence', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    const revert = vi.fn();
    const old = drawnAt(wrapper, 'dmt-dev/a', 0, SHOP_MON);
    const done = optionsOf(wrapper).eventDrop({ event: { ...old, start: new Date('2026-10-19T09:00:00+02:00'), end: new Date(old.end.getTime() + 3_600_000) }, oldEvent: old, delta: deltaOf(old.start, new Date('2026-10-19T09:00:00+02:00')), revert });
    await flushPromises();
    expect((document.querySelector('[data-test="scope-occurrence"]') as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('[data-test="scope-occurrence-line"]')!.textContent).toContain('needs router 0.36.0 or later');
    await answer('series');
    await done;
    expect(JSON.parse(puts()[0]!.body!).windows[0]).toEqual({ ...shopSchedule.windows![0], start: '09:00', end: '20:00' });
  });

  it('a bar of two joined windows moves both', async () => {
    const two = [{ kind: 'awake' as const, days: ['mon' as const], start: '08:00', end: '12:00' }, { kind: 'awake' as const, days: ['mon' as const], start: '12:10', end: '18:00' }];
    h.status['/workloads/dmt-dev/a'] = { ...status('Shop', { timeZone: 'Europe/Paris', windows: two }), joinMinutes: 15, joinFrom: 'default', joinInherited: { joinMinutes: 15, joinFrom: 'default' } };
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    expect(drawnAt(wrapper, 'dmt-dev/a', 0, SHOP_MON).extendedProps.windows).toEqual([0, 1]);
    await drop(wrapper, 'dmt-dev/a', 0, SHOP_MON, '2026-10-19T09:00:00+02:00');
    expect(JSON.parse(puts()[0]!.body!).windows).toEqual([{ ...two[0], start: '09:00', end: '13:00' }, { ...two[1], start: '13:10', end: '19:00' }]);
  });

  it('puts back on the router\'s refusal, in its words', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    h.fail.add('/workloads/dmt-dev/a/schedule');
    const revert = await drop(wrapper, 'dmt-dev/a', 0, SHOP_MON, '2026-10-19T09:30:00+02:00');
    expect(revert).toHaveBeenCalledOnce();
    expect(toast()).toBe('boom');
  });

  it('puts back when the window changed since it was drawn, and draws it again', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    h.status['/workloads/dmt-dev/a'] = status('Shop', { ...shopSchedule, windows: [{ ...shopSchedule.windows![0]!, start: '07:00' }, shopSchedule.windows![1]!] });
    const revert = await drop(wrapper, 'dmt-dev/a', 0, SHOP_MON, '2026-10-19T09:30:00+02:00');
    expect(revert).toHaveBeenCalledOnce();
    expect(puts()).toEqual([]);
    expect(toast()).toContain('changed since');
  });

  it('puts back when the zone or the dates without a window changed since it was drawn: the instants read otherwise', async () => {
    for (const changed of [{ ...shopSchedule, timeZone: 'America/New_York' }, { ...shopSchedule, exceptions: ['2026-10-19'] }]) {
      h.status['/workloads/dmt-dev/a'] = recent('Shop', shopSchedule);
      const { wrapper } = await open();
      await enable(wrapper, 'dmt-dev/a');
      h.status['/workloads/dmt-dev/a'] = recent('Shop', changed);
      h.calls.length = 0;
      const revert = await drop(wrapper, 'dmt-dev/a', 0, SHOP_MON, '2026-10-19T09:30:00+02:00', 'occurrence');
      expect(revert, JSON.stringify(changed)).toHaveBeenCalledOnce();
      expect(puts()).toEqual([]);
      expect(toast()).toContain('changed since');
      wrapper.unmount();
    }
  });

  it('a schedule with its own value keeps it through a drag, 0 included', async () => {
    for (const joinMinutes of [0, 30]) {
      h.status['/workloads/dmt-dev/a'] = { ...status('Shop', { ...shopSchedule, joinMinutes }), joinMinutes, joinFrom: 'workload', joinInherited: { joinMinutes: 15, joinFrom: 'default' } };
      const { wrapper } = await open();
      await enable(wrapper, 'dmt-dev/a');
      h.calls.length = 0;
      await drop(wrapper, 'dmt-dev/a', 0, SHOP_MON, '2026-10-19T09:30:00+02:00');
      expect(JSON.parse(h.calls.find((c) => c.method === 'PUT')!.body!).joinMinutes).toBe(joinMinutes);
    }
  });

  it('a schedule without one is sent without it', async () => {
    h.status['/workloads/dmt-dev/a'] = { ...status('Shop', shopSchedule), joinMinutes: 15, joinFrom: 'default', joinInherited: { joinMinutes: 15, joinFrom: 'default' } };
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    h.calls.length = 0;
    await drop(wrapper, 'dmt-dev/a', 0, SHOP_MON, '2026-10-19T09:30:00+02:00');
    expect(JSON.parse(h.calls.find((c) => c.method === 'PUT')!.body!)).not.toHaveProperty('joinMinutes');
  });

  it('puts back when the value in force changed since it was drawn: the bar was drawn with another', async () => {
    h.status['/workloads/dmt-dev/a'] = { ...status('Shop', shopSchedule), joinMinutes: 15, joinFrom: 'default', joinInherited: { joinMinutes: 15, joinFrom: 'default' } };
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    h.status['/workloads/dmt-dev/a'] = { ...status('Shop', shopSchedule), joinMinutes: 60, joinFrom: 'organization', joinInherited: { joinMinutes: 60, joinFrom: 'organization' } };
    h.calls.length = 0;
    const revert = await drop(wrapper, 'dmt-dev/a', 0, SHOP_MON, '2026-10-19T09:30:00+02:00');
    expect(revert).toHaveBeenCalled();
    expect(h.calls.some((c) => c.method === 'PUT')).toBe(false);
    expect(toast()).toContain('changed since it was read');
  });

  it('compares the fresh read with the window as drawn, though another read lands while it is out: the other window never moves', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    // Someone puts a window first, and the user's Refresh answers during the drop's own read.
    const first = { kind: 'awake' as const, days: ['sat' as const], start: '14:00', end: '15:00' };
    h.status['/workloads/dmt-dev/a'] = status('Shop', { ...shopSchedule, windows: [first, ...shopSchedule.windows!] });
    h.duringRead = async () => { await wrapper.find('[data-test="refresh"]').trigger('click'); await flushPromises(); };
    h.calls.length = 0;
    const revert = await drop(wrapper, 'dmt-dev/a', 0, SHOP_MON, '2026-10-19T09:30:00+02:00');
    expect(revert).toHaveBeenCalledOnce();
    expect(puts()).toEqual([]);
    expect(toast()).toContain('changed since');
  });

  describe('with dates without a window', () => {
    const NIGHTLY = { kind: 'nap' as const, start: '23:00', end: '23:30', repeat: { pattern: 'daily' as const }, wake: 'never' as const };
    const WORDS = 'This schedule has dates without a window, and this move would change which occurrence they skip: edit it in the dialog.';
    const seeded = async (exceptions: string[]) => {
      h.status['/workloads/dmt-dev/a'] = status('Shop', { timeZone: 'Europe/Paris', windows: [NIGHTLY], exceptions });
      const { wrapper } = await open();
      await enable(wrapper, 'dmt-dev/a');
      return wrapper;
    };

    it('refuses the series a time crossing midnight, or a day\'s move: the date would skip another occurrence', async () => {
      const wrapper = await seeded(['2099-12-25']);
      for (const to of ['2027-01-05T01:00:00+01:00', '2027-01-05T23:00:00+01:00', '2027-01-03T23:00:00+01:00']) {
        const revert = vi.fn();
        const old = drawnAt(wrapper, 'dmt-dev/a', 0, '2027-01-04T23:00:00+01:00');
        const done = optionsOf(wrapper).eventDrop({ event: { ...old, start: new Date(to), end: new Date(Date.parse(to) + 1_800_000) }, oldEvent: old, delta: deltaOf(old.start, new Date(to)), revert });
        await flushPromises();
        expect((document.querySelector('[data-test="scope-series"]') as HTMLButtonElement).disabled, to).toBe(true);
        expect(document.querySelector('[data-test="scope-series-line"]')!.textContent).toBe(WORDS);
        await answer(null);
        await done;
        expect(revert).toHaveBeenCalledOnce();
      }
      expect(puts()).toEqual([]);
    });

    it('takes a move within the same day', async () => {
      const wrapper = await seeded(['2099-12-25']);
      const revert = await drop(wrapper, 'dmt-dev/a', 0, '2027-01-04T23:00:00+01:00', '2027-01-04T21:00:00+01:00');
      expect(revert).not.toHaveBeenCalled();
      expect(JSON.parse(puts()[0]!.body!)).toMatchObject({ windows: [{ start: '21:00', end: '21:30' }], exceptions: ['2099-12-25'] });
    });

    it('takes a day\'s move when the dates have passed: they skip nothing any more', async () => {
      const wrapper = await seeded(['2020-12-25']);
      const revert = await drop(wrapper, 'dmt-dev/a', 0, '2027-01-04T23:00:00+01:00', '2027-01-05T01:00:00+01:00');
      expect(revert).not.toHaveBeenCalled();
      expect(puts()).toHaveLength(1);
    });
  });

  it('after a router\'s rollback, a drag drops the value it no longer knows', async () => {
    // No joinInherited answered: the router would refuse the stored joinMinutes as unknown, and every save with it.
    h.status['/workloads/dmt-dev/a'] = status('Shop', { ...shopSchedule, joinMinutes: 30 });
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    await drop(wrapper, 'dmt-dev/a', 0, SHOP_MON, '2026-10-19T09:30:00+02:00');
    expect(JSON.parse(puts()[0]!.body!)).not.toHaveProperty('joinMinutes');
  });

  it('puts back a drop that moves nothing, in silence', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    const revert = await drop(wrapper, 'dmt-dev/a', 0, SHOP_MON, SHOP_MON);
    expect(revert).toHaveBeenCalledOnce();
    expect(puts()).toEqual([]);
    expect(toast()).toBeUndefined();
  });

  it('draws the moved window at once and keeps the view and its date', async () => {
    const { wrapper, router } = await open();
    await enable(wrapper, 'dmt-dev/a');
    await drop(wrapper, 'dmt-dev/a', 0, SHOP_MON, '2026-10-19T09:30:00+02:00');
    const awakeTimes = () => wrapper.findAll('.fc-event.dm-ev--awake .fc-event-time').map((t) => t.text());
    // The router's answer is the old window here: what it draws until the next read is the drop.
    expect(puts()).toHaveLength(1);
    expect(awakeTimes().length).toBeGreaterThan(0);
    expect(router.currentRoute.value.query).toMatchObject({ view: 'week', date: '2026-10-21' });
    expect(wrapper.find('.fc-timeGridWeek-view').exists()).toBe(true);
  });

  it('does not let a read-only workload be dragged or resized; a cron window can be', async () => {
    h.status['/workloads/dmt-dev/a'] = { ...status('Shop', shopSchedule), can: { wake: true, nap: false } };
    h.status['/workloads/dmt-dev/b'] = status('Blog', { timeZone: 'Europe/Paris', windows: [{ kind: 'awake', repeat: { pattern: 'cron', cron: '0 8 * * *', minutes: 60 } }] });
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    await enable(wrapper, 'dmt-dev/b');
    const events = (wrapper.findComponent(FullCalendar).props('options') as { events: { startEditable: boolean; durationEditable: boolean; extendedProps: { key: string } }[] }).events;
    const of = (key: string) => events.filter((e) => e.extendedProps.key === key);
    expect(of('dmt-dev/a').length).toBeGreaterThan(0);
    expect(of('dmt-dev/a').every((e) => !e.startEditable && !e.durationEditable)).toBe(true);
    expect(of('dmt-dev/b').length).toBeGreaterThan(0);
    expect(of('dmt-dev/b').every((e) => e.startEditable && e.durationEditable)).toBe(true);
  });
});

describe('Schedules view: picking a workload', () => {
  it('the New window field autocompletes, sorted naturally by name', async () => {
    const candidates = ['w-10', 'W-3', 'alpha', 'w-2'].map((name) => ({ key: `r/${name}`, name, schedule: null }));
    const wrapper = mount({ render: () => vh(components.VApp, null, () => vh(NewWindowDialog, { modelValue: true, candidates, selection: { start: new Date(), end: new Date(Date.now() + 3_600_000), month: false } })) }, { attachTo: document.body, global: { plugins: [createVuetify({ components, directives })] } });
    await flushPromises();
    const field = wrapper.findComponent({ name: 'VAutocomplete' });
    expect(field.attributes('data-test')).toBe('nw-workload');
    expect((field.props('items') as { name: string }[]).map((c) => c.name)).toEqual(['alpha', 'w-2', 'W-3', 'w-10']);
    wrapper.unmount();
  });

  it('the panel lists the workloads the same way', async () => {
    h.list = ['w-10', 'W-3', 'alpha', 'w-2'].map((name) => row('dmt-dev', name, name));
    const { wrapper } = await open();
    expect(wrapper.findAll('[data-test^="calendar-"]').map((r) => r.attributes('data-test')!.replace('calendar-dmt-dev/', ''))).toEqual(['alpha', 'w-2', 'W-3', 'w-10']);
  });

  it('a month cell is a date: a Do not repeat starts on the date clicked, in a schedule of any zone', async () => {
    // Wed 10 Mar 2027 in Paris begins on the 9th in New York: the date clicked is still the 10th, as the weekly default says.
    const { wrapper } = await open('?view=month&date=2027-03-01');
    await enable(wrapper, 'dmt-dev/b');
    await select(wrapper, at('2027-03-10', '00:00'), at('2027-03-11', '00:00'));
    expect(field(wrapper, 'nw-days').props('modelValue')).toEqual(['wed']);
    await field(wrapper, 'nw-pattern').vm.$emit('update:modelValue', 'once');
    await flushPromises();
    expect(text('[data-test="nw-sentence"]')).toContain('Once on 10 Mar 2027');
  });

  it('a time-grid selection stays on the schedule\'s clock', async () => {
    const { wrapper } = await open('?view=week&date=2027-03-10');
    await enable(wrapper, 'dmt-dev/b');
    // 02:00 in Paris on the 10th is the evening of the 9th in New York.
    await select(wrapper, at('2027-03-10', '02:00'), at('2027-03-10', '03:00'));
    await field(wrapper, 'nw-pattern').vm.$emit('update:modelValue', 'once');
    await flushPromises();
    expect(text('[data-test="nw-sentence"]')).toContain('Once on 9 Mar 2027');
  });

  it('after a router\'s rollback, a new window drops the value it no longer knows', async () => {
    h.status['/workloads/dmt-dev/a'] = status('Shop', { ...shopSchedule, joinMinutes: 30 });
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    await select(wrapper, at('2026-10-24', '12:00'), at('2026-10-24', '13:00'));
    await click('[data-test="nw-save"]');
    expect(JSON.parse(puts()[0]!.body!)).not.toHaveProperty('joinMinutes');
  });

  it('dates a Do not repeat from a selection on that day', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    await select(wrapper, at('2026-10-20', '12:00'), at('2026-10-20', '13:00'));
    await field(wrapper, 'nw-pattern').vm.$emit('update:modelValue', 'once');
    await flushPromises();
    expect(text('[data-test="nw-sentence"]')).toBe('Once on 20 Oct 2026, 12:00–13:00');
    await click('[data-test="nw-save"]');
    expect(JSON.parse(puts()[0]!.body!).windows.at(-1)).toEqual({ kind: 'awake', start: '12:00', end: '13:00', repeat: { pattern: 'daily' }, from: '2026-10-20', until: '2026-10-20' });
  });

  it('has an icon on Awake and Nap, and short words with a tooltip for what Save replaces', async () => {
    const { wrapper } = await open();
    await enable(wrapper, 'dmt-dev/a');
    await select(wrapper, at('2026-10-19', '12:00'), at('2026-10-19', '13:00'));
    const toggle = [...body().querySelectorAll('[data-test="nw-kind"] button')];
    for (const b of toggle) expect(b.querySelector('.v-icon')).not.toBeNull();
    expect(text('[data-test="nw-replace-note"]')).toBe('Saving replaces the workload\'s schedule.');
    body().querySelector('[data-test="nw-replace-more"]')!.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.waitFor(() => expect(body().querySelector('.v-overlay--active [data-test="nw-replace-tip"]')?.textContent).toContain('a change made by someone else'));
    expect(body().querySelector('[data-test="schedule-help"]')).not.toBeNull();
    expect(body().querySelector('[data-test="overlap-help"]')).not.toBeNull();
  });

  it('gives its icon-only buttons a tooltip', async () => {
    const { wrapper } = await open();
    for (const [name, words] of [['prev', 'Previous'], ['next', 'Next'], ['refresh', 'Refresh']] as const) {
      await wrapper.find(`[data-test="${name}"]`).trigger('mouseenter');
      await vi.waitFor(() => expect(body().querySelector('.v-overlay--active .v-tooltip__content, .v-overlay--active.v-tooltip')?.textContent, name).toContain(words));
      await wrapper.find(`[data-test="${name}"]`).trigger('mouseleave');
      await vi.waitFor(() => expect(body().querySelector('.v-overlay--active.v-tooltip'), name).toBeNull());
    }
  });
});
