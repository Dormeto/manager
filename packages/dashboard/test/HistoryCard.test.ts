import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import HistoryCard from '../src/components/HistoryCard.vue';
import { api } from '../src/api';
import { download } from '../src/table-export';

const local = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString();
const history = {
  from: local(7, 12), to: local(8, 12), truncated: false,
  phases: [
    { state: 'ASLEEP', from: local(7, 12), to: local(8, 9), cause: 'idle' },
    { state: 'WAKING', from: local(8, 9), to: local(8, 9, 1), cause: 'manager', by: 'ops@example.com' },
    { state: 'AWAKE', from: local(8, 9, 1), to: local(8, 12) },
  ],
  totals: { ASLEEP: 21 * 3600, WAKING: 60, AWAKE: 179 * 60 },
  wakes: { count: 1, failed: 0, medianMs: 41_000, maxMs: 41_000 },
  before: null,
  entries: [
    { from: 'NAPPING', to: 'ASLEEP', at: local(7, 11), cause: 'idle' },
    { from: 'ASLEEP', to: 'WAKING', at: local(8, 9), cause: 'manager', by: 'ops@example.com' },
    { from: 'WAKING', to: 'AWAKE', at: local(8, 9, 1), durationMs: 41_000 },
  ],
};
vi.mock('../src/api', () => ({ api: vi.fn(async () => structuredClone(history)) }));
vi.mock('../src/table-export', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/table-export')>()), download: vi.fn() }));
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});
// The changes' table: its rows, a row's cells by the column's title, a cell's state marks by their names.
const changes = (w: Awaited<ReturnType<typeof mountCard>>) => w.findAll('.dm-history__changes tbody tr');
const titles = (w: Awaited<ReturnType<typeof mountCard>>) => w.findAll('.dm-history__changes thead th').map((th) => th.text());
const cell = (w: Awaited<ReturnType<typeof mountCard>>, row: number, column: string) => changes(w)[row]!.findAll('td')[titles(w).indexOf(column)]!;
const marks = (el: ReturnType<typeof cell>) => el.findAll('[data-test="status-mark"]').map((m) => m.attributes('aria-label'));

async function mountCard() {
  setActivePinia(createPinia());
  const wrapper = mount(HistoryCard, { props: { router: 'dmt-dev', id: 'demo', now: Date.parse(local(8, 12)) }, attachTo: document.body, global: { plugins: [createVuetify({ components, directives })] } });
  await flushPromises();
  return wrapper;
}

describe('HistoryCard', () => {
  it('draws a row per day, says the totals, and explains each phase', async () => {
    const wrapper = await mountCard();
    expect(vi.mocked(api)).toHaveBeenCalledWith('/workloads/dmt-dev/demo/history?days=7');
    expect(wrapper.findAll('[data-test="day"]')).toHaveLength(2);
    expect(wrapper.text()).toContain('Asleep 88%');
    expect(wrapper.text()).toContain('1 wake, median 41 s, longest 41 s');
    const waking = wrapper.findAll('[data-test="segment"]').find((s) => s.attributes('aria-label')?.startsWith('Waking'))!;
    expect(waking.attributes('aria-label')).toMatch(/Waking .*1 min.*woken from the manager by ops@example\.com/);
    // Each day a wave: the wake as a dot on it.
    expect(wrapper.findAll('.wave__line')).toHaveLength(2);
    expect(wrapper.findAll('.wave__dot')).toHaveLength(1);
    wrapper.unmount();
  });

  // The user's "all tables" (the controller's ruling): the list of changes is a table of the component.
  it('lists the changes as a table, newest first: when, the states as their icons, why, the wake\'s duration; sorted, searched, paged by 25, exported', async () => {
    const wrapper = await mountCard();
    expect(titles(wrapper)).toEqual(['When', 'Change', 'Why', 'Wake', 'Actions']);
    expect(changes(wrapper)).toHaveLength(3);
    // The states as marks named by them, no word beside them.
    expect(marks(cell(wrapper, 0, 'Change'))).toEqual(['Waking', 'Awake']);
    expect(cell(wrapper, 0, 'Change').text()).toBe('→');
    expect(cell(wrapper, 0, 'Wake').text()).toBe('41 s');
    expect(marks(cell(wrapper, 1, 'Change'))).toEqual(['Asleep', 'Waking']);
    expect(cell(wrapper, 1, 'Why').text()).toMatch(/woken from the manager by ops@example\.com/);
    // On When's header: no sort (the history's order, newest first), then oldest first.
    const when = () => wrapper.findAll('.dm-history__changes thead th').find((th) => th.text() === 'When')!;
    expect(when().attributes('aria-sort')).toBe('descending');
    await when().find('.v-data-table-header__content').trigger('click');
    await when().find('.v-data-table-header__content').trigger('click');
    await flushPromises();
    expect(when().attributes('aria-sort')).toBe('ascending');
    expect(marks(cell(wrapper, 0, 'Change'))).toEqual(['Napping', 'Asleep']);
    // Searched on what the columns say: a state's word.
    await wrapper.find('.dm-history__changes [data-test="dm-table-search"] input').setValue('awake');
    await flushPromises();
    expect(changes(wrapper)).toHaveLength(1);
    // Exported: each change in words, its date as ISO 8601.
    await wrapper.find('.dm-history__changes [data-test="dm-table-search"] input').setValue('');
    await flushPromises();
    await wrapper.find('.dm-history__changes thead [data-test="dm-table-menu"]').trigger('click');
    await flushPromises();
    (document.querySelector('.v-overlay--active [data-test="dm-table-export-csv"]') as HTMLElement).click();
    await flushPromises();
    const [name, , body] = vi.mocked(download).mock.calls.at(-1)!;
    expect(name).toMatch(/^dormeto-history-demo-\d{4}-\d{2}-\d{2}\.csv$/);
    expect((body as string).split('\r\n')[0]).toBe('When,Change,Why,Wake (s)');
    expect((body as string).split('\r\n')).toContain(`${local(8, 9, 1)},Waking → Awake,,41`);
    wrapper.unmount();
  });

  it('pages its changes by 25', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ from: 'ASLEEP', to: 'WAKING', at: new Date(Date.parse(local(7, 12)) + i * 60_000).toISOString(), cause: 'request' }));
    vi.mocked(api).mockResolvedValueOnce({ ...structuredClone(history), entries: many });
    const wrapper = await mountCard();
    expect(changes(wrapper)).toHaveLength(25);
    expect(wrapper.find('.dm-history__changes .v-data-table-footer').exists()).toBe(true);
    wrapper.unmount();
  });

  it('the asleep share is of the time with history; napping is told apart from waking (found live)', async () => {
    vi.mocked(api).mockResolvedValueOnce({ ...structuredClone(history), totals: { UNKNOWN: 86_000, ASLEEP: 300, AWAKE: 100 },
      phases: [{ state: 'UNKNOWN', from: local(7, 12), to: local(8, 11, 53) }, { state: 'NAPPING', from: local(8, 11, 53), to: local(8, 11, 54) }, { state: 'ASLEEP', from: local(8, 11, 54), to: local(8, 12) }] });
    const wrapper = await mountCard();
    expect(wrapper.text()).toContain('Asleep 75% of the time with history');
    expect(wrapper.find('[data-test="gap"]').exists()).toBe(true);
    const napping = wrapper.findAll('[data-test="segment"]').find((x) => x.attributes('aria-label')?.startsWith('Napping'))!;
    expect(napping.attributes('data-state')).toBe('NAPPING');
    wrapper.unmount();
  });

  it('says a capped period keeps its latest changes, and a first entry is first seen (review I2, M7)', async () => {
    vi.mocked(api).mockResolvedValueOnce({ ...structuredClone(history), truncated: true, entries: [{ from: null, to: 'ASLEEP', at: local(7, 11), inferred: true }] });
    const wrapper = await mountCard();
    expect(wrapper.text()).toContain('More than 5,000 changes in this period: only the latest are drawn');
    expect(cell(wrapper, 0, 'Change').text()).toMatch(/^first seen\s*→$/);
    expect(marks(cell(wrapper, 0, 'Change'))).toEqual(['Asleep']);
    expect(cell(wrapper, 0, 'Why').text()).toMatch(/first seen by the manager/);
    wrapper.unmount();
  });

  it('estimates the period\'s savings when the history has them (R9)', async () => {
    vi.mocked(api).mockResolvedValueOnce({ ...structuredClone(history), savings: { usd: 0.957, hours: 21, items: [{ item: { kind: 'ec2', type: 't3.medium', count: 1, os: 'Linux' }, hourly: 0.0456, hours: 21, usd: 0.957 }], unpriced: [], baseline: { kind: 'always' } } });
    const wrapper = await mountCard();
    expect(wrapper.text()).toContain('saved about $0.957 (estimate)');
    wrapper.unmount();
  });

  it('says the period\'s savings are after discounts when some are set (R9.5)', async () => {
    vi.mocked(api).mockResolvedValueOnce({ ...structuredClone(history), savings: { usd: 0.766, hours: 21, items: [{ item: { kind: 'ec2', type: 't3.medium', count: 1, os: 'Linux' }, hourly: 0.0365, hours: 21, usd: 0.766 }], unpriced: [], baseline: { kind: 'always' }, discounts: { compute: 20, databases: 30 } } });
    const wrapper = await mountCard();
    expect(wrapper.text()).toContain('saved about $0.766 (estimate, after discounts)');
    wrapper.unmount();
  });

  it('says the savings are not priced yet rather than $0 when nothing could be priced (review I6)', async () => {
    vi.mocked(api).mockResolvedValueOnce({ ...structuredClone(history), savings: { usd: 0, hours: 21, items: [], unpriced: [{ reason: 'not described (a router before 0.27.0)', hours: 21 }], baseline: { kind: 'always' } } });
    const wrapper = await mountCard();
    expect(wrapper.text()).toContain('savings not priced yet');
    expect(wrapper.text()).not.toMatch(/\$0(?![.\d])/);
    wrapper.unmount();
  });

  it('reloads for another period', async () => {
    const wrapper = await mountCard();
    await wrapper.findAll('button').find((b) => b.text() === '30 days')!.trigger('click');
    await flushPromises();
    expect(vi.mocked(api)).toHaveBeenLastCalledWith('/workloads/dmt-dev/demo/history?days=30');
    wrapper.unmount();
  });
});
