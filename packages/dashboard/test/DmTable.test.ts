// The dashboard's table (tables design §5): search on what the columns say, sort, pages, the Actions column (a row's menu,
// the table's menu with the exports), a server table's export over every page.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, nextTick, type Component } from 'vue';
import { mdiDeleteOutline, mdiPauseCircleOutline, mdiRefresh } from '@mdi/js';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import DmTable from '../src/components/DmTable.vue';
import type { DmAction, DmHeader } from '../src/table';
import { download, fileName, pdf } from '../src/table-export';

vi.mock('../src/table-export', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/table-export')>()),
  download: vi.fn(),
  pdf: vi.fn(async () => new Blob(['%PDF-1.3'], { type: 'application/pdf' })),
}));
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Row { name: string; state: string; n: number; note: string }
const rows = (count: number, from = 0): Row[] => Array.from({ length: count }, (_, i) => ({
  name: `w${String(from + i).padStart(4, '0')}`, state: (from + i) % 2 ? 'AWAKE' : 'ASLEEP', n: from + i, note: (from + i) === 3 ? '=cmd()' : '',
}));
// The state is shown as an icon: its word is the column's text, which search reads and an export prints.
const headers: DmHeader<Row>[] = [
  { title: 'Name', key: 'name' },
  { title: 'State', key: 'state', text: (r) => (r.state === 'ASLEEP' ? 'napping' : 'awake') },
  { title: 'N', key: 'n', align: 'end' },
  { title: 'Note', key: 'note', sortable: false },
  { title: 'Internal', key: 'internal', export: false, text: () => 'never exported' },
];
const exported = { name: 'tests', title: 'Tests', filters: ['Router: dmtr-a'] };

let wrapper: VueWrapper | undefined;
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.mocked(download).mockClear();
  vi.mocked(pdf).mockClear();
});
function render(props: Record<string, unknown>, slots: Record<string, unknown> = {}) {
  wrapper = mount(DmTable as unknown as Component, {
    props: { headers, items: rows(6), itemValue: 'name', exported, ...props },
    slots,
    attachTo: document.body,
    global: { plugins: [createVuetify({ components })] },
  });
  return wrapper;
}
const names = (w: VueWrapper) => w.findAll('tbody tr').map((r) => r.find('td').text());
const overlay = () => document.querySelector('.v-overlay--active') as HTMLElement | null;
async function openTableMenu(w: VueWrapper) {
  await w.find('[data-test="dm-table-menu"]').trigger('click');
  await flushPromises();
}
// An item of the open menu, chosen; the menu then closes (a click during its closing would be lost).
async function press(selector: string) {
  (document.querySelector(`.v-overlay--active ${selector}`) as HTMLElement).click();
  await flushPromises();
  await sleep(350);
}
// The CSV handed to download, as its lines.
const csvLines = () => {
  const call = vi.mocked(download).mock.calls.find(([, mime]) => mime.startsWith('text/csv'))!;
  return (call[2] as string).split('\r\n').slice(0, -1);
};

describe('DmTable', () => {
  it('searches what the columns say (a status\'s word), not the raw values', async () => {
    const w = render({});
    await w.find('[data-test="dm-table-search"] input').setValue('napping');
    await flushPromises();
    expect(w.emitted('update:search')!.at(-1)).toEqual(['napping']);
    expect(names(w)).toEqual(['w0000', 'w0002', 'w0004']);
    await w.setProps({ search: 'ASLEEP' });
    await flushPromises();
    expect(w.findAll('tbody tr')).toHaveLength(1);
    expect(w.find('tbody').text()).toContain('No row matches “ASLEEP”.');
    // Cleared, the search is empty text (a view sends it to its API), never null.
    w.findComponent({ name: 'VTextField' }).vm.$emit('update:modelValue', null);
    await flushPromises();
    expect(w.emitted('update:search')!.at(-1)).toEqual(['']);
  });

  it('sorts on a column\'s header, its default sort a prop', async () => {
    const w = render({ sortBy: [{ key: 'n', order: 'desc' }] });
    expect(names(w)).toEqual(['w0005', 'w0004', 'w0003', 'w0002', 'w0001', 'w0000']);
    const name = w.findAll('thead th').find((th) => th.text() === 'Name')!;
    await name.find('.v-data-table-header__content').trigger('click');
    await flushPromises();
    expect(names(w)).toEqual(['w0000', 'w0001', 'w0002', 'w0003', 'w0004', 'w0005']);
    await name.find('.v-data-table-header__content').trigger('click');
    await flushPromises();
    expect(names(w)[0]).toBe('w0005');
  });

  it('pages 50 rows by default (25, 50, 100 or all), its footer hidden while one page holds every row', async () => {
    const w = render({ items: rows(120) });
    expect(w.findAll('tbody tr')).toHaveLength(50);
    expect(w.find('.v-data-table-footer').exists()).toBe(true);
    expect(w.findComponent({ name: 'VDataTableFooter' }).props('itemsPerPageOptions')).toEqual([
      { value: 25, title: '25' }, { value: 50, title: '50' }, { value: 100, title: '100' }, { value: -1, title: 'All' },
    ]);
    await w.find('.v-data-table-footer [aria-label="Next page"], .v-data-table-footer .v-pagination__next button').trigger('click');
    await flushPromises();
    expect(names(w)[0]).toBe('w0050');
    await w.setProps({ items: rows(30) });
    await flushPromises();
    expect(w.findAll('tbody tr')).toHaveLength(30);
    expect(w.find('.v-data-table-footer').exists()).toBe(false);
  });

  it('exports the rows matching the search, in the order shown, every page, without the Actions column and the columns kept out', async () => {
    const w = render({ items: rows(60), perPage: 25, search: 'napping', sortBy: [{ key: 'n', order: 'desc' }], actions: () => [] });
    expect(w.findAll('tbody tr')).toHaveLength(25);
    await openTableMenu(w);
    expect(overlay()!.textContent).toContain('Export CSV');
    expect(overlay()!.textContent).toContain('Export PDF');
    await press('[data-test="dm-table-export-csv"]');
    const [name, mime] = vi.mocked(download).mock.calls[0]!;
    expect(name).toBe(fileName('tests', 'csv'));
    expect(mime).toBe('text/csv;charset=utf-8');
    const lines = csvLines();
    expect(lines[0]).toBe('Name,State,N,Note');
    expect(lines.slice(1)).toEqual(Array.from({ length: 30 }, (_, i) => `w${String(58 - 2 * i).padStart(4, '0')},napping,${58 - 2 * i},`));

    await openTableMenu(w);
    await press('[data-test="dm-table-export-pdf"]');
    expect(pdf).toHaveBeenCalledTimes(1);
    const doc = vi.mocked(pdf).mock.calls[0]![0];
    expect(doc.title).toBe('Tests');
    expect(doc.headers).toEqual(['Name', 'State', 'N', 'Note']);
    expect(doc.rows).toHaveLength(30);
    expect(doc.rows[0]).toEqual(['w0058', 'napping', '58', '']);
    expect(doc.lines[0]).toMatch(/^Exported .+ · 30 rows$/);
    expect(doc.lines.slice(1)).toEqual(['Search: “napping”', 'Router: dmtr-a']);
    expect(vi.mocked(download).mock.calls.at(-1)!.slice(0, 2)).toEqual([fileName('tests', 'pdf'), 'application/pdf']);
  });

  it('guards a cell a spreadsheet would run as a formula', async () => {
    const w = render({});
    await openTableMenu(w);
    await press('[data-test="dm-table-export-csv"]');
    expect(csvLines()[4]).toBe('w0003,awake,3,\'=cmd()');
  });

  it('gives the header\'s "⋮" the table\'s own actions after the exports', async () => {
    const refresh = vi.fn();
    const w = render({ tableActions: [{ title: 'Refresh the list', icon: mdiRefresh, run: refresh }] satisfies DmAction[] });
    const menu = w.find('[data-test="dm-table-menu"]');
    expect(menu.element.closest('th')).not.toBeNull();
    await openTableMenu(w);
    expect([...overlay()!.querySelectorAll('.v-list-item-title')].map((t) => t.textContent)).toEqual(['Export CSV', 'Export PDF', 'Refresh the list']);
    await press('.v-list-item:last-child');
    expect(refresh).toHaveBeenCalledTimes(1);
    // Named with the table's title, as its search: two tables on one page (Routers and its IP lists) told apart.
    expect(menu.attributes('aria-label')).toBe('Table actions: Tests');
    expect(w.find('[data-test="dm-table-search"] input').attributes('aria-label')).toBe('Search tests');
    w.unmount();
    wrapper = render({ exported: { name: 'ip-lists', title: 'IP lists' } });
    expect([wrapper.find('[data-test="dm-table-menu"]').attributes('aria-label'), wrapper.find('[data-test="dm-table-search"] input').attributes('aria-label')])
      .toEqual(['Table actions: IP lists', 'Search IP lists']);
  });

  it('offers no "All" page size on a client table of more than 1,000 rows (rendering them all would freeze the page)', async () => {
    const sizes = (w: VueWrapper) => (w.findComponent({ name: 'VDataTableFooter' }).props('itemsPerPageOptions') as { title: string }[]).map((o) => o.title);
    const w = render({ items: rows(1000) });
    expect(sizes(w)).toEqual(['25', '50', '100', 'All']);
    await w.setProps({ items: rows(1001) });
    await flushPromises();
    expect(sizes(w)).toEqual(['25', '50', '100']);
  });

  it('says the time zone of the export\'s time in the PDF', async () => {
    const w = render({});
    await openTableMenu(w);
    await press('[data-test="dm-table-export-pdf"]');
    expect(vi.mocked(pdf).mock.calls[0]![0].lines[0]).toMatch(/^Exported \w{3} \d+, \d{4}, \d+:\d{2} [AP]M (UTC|GMT([+-]\d{1,2}(:\d{2})?)?|[A-Z]{2,5}) · 6 rows$/);
  });

  it('shows a row\'s "⋮" only when the row has actions; a destructive one in its color, a disabled one saying why', async () => {
    const ran: string[] = [];
    const actions = (r: Row): DmAction[] => (r.n === 0 ? [] : [
      { title: 'Pause', icon: mdiPauseCircleOutline, run: () => ran.push(`pause ${r.name}`) },
      { title: 'Uninstall', icon: mdiDeleteOutline, color: 'error', disabled: r.n === 2, help: 'Pause it first: it is running an operation.', run: () => ran.push(`uninstall ${r.name}`) },
    ]);
    const w = render({ actions });
    const row = (name: string) => w.findAll('tbody tr').find((r) => r.text().includes(name))!;
    expect(row('w0000').find('[data-test="dm-row-menu"]').exists()).toBe(false);
    const button = row('w0001').find('[data-test="dm-row-menu"]');
    expect(button.attributes('aria-label')).toBe('Actions for w0001');
    await button.trigger('click');
    await flushPromises();
    expect([...overlay()!.querySelectorAll('.v-list-item-title')].map((t) => t.textContent)).toEqual(['Pause', 'Uninstall']);
    expect(overlay()!.querySelector('.v-list-item:last-child')!.classList).toContain('text-error');
    await press('.v-list-item:first-child');
    expect(ran).toEqual(['pause w0001']);

    await row('w0002').find('[data-test="dm-row-menu"]').trigger('click');
    await flushPromises();
    const uninstall = [...overlay()!.querySelectorAll<HTMLElement>('.v-list-item')].find((i) => i.textContent?.includes('Uninstall'))!;
    expect(uninstall.getAttribute('aria-disabled')).toBe('true');
    uninstall.click();
    await flushPromises();
    expect(ran).toEqual(['pause w0001']);
    // Focusable as the others (the list's arrow keys reach it), its reason in a tooltip that a keyboard opens too.
    const pause = [...overlay()!.querySelectorAll<HTMLElement>('.v-list-item')].find((i) => i.textContent?.includes('Pause'))!;
    expect(uninstall.getAttribute('tabindex')).toBe(pause.getAttribute('tabindex'));
    expect(uninstall.getAttribute('tabindex')).not.toBe('-1');
    uninstall.dispatchEvent(new Event('mouseenter'));
    await nextTick();
    await sleep(300);
    expect(document.querySelector('.v-overlay-container')!.textContent).toContain('Pause it first: it is running an operation.');
  });

  it('names a row\'s "⋮" by the view\'s rowName when it gives one, apart from the first column\'s export text', async () => {
    const actions = (): DmAction[] => [{ title: 'Pause', icon: mdiPauseCircleOutline, run: () => {} }];
    const where: DmHeader<Row>[] = [{ title: 'Name', key: 'name', text: (r) => `${r.name} (AWS, eu-west-3)` }, ...headers.slice(1)];
    const named = render({ headers: where, actions, rowName: (r: Row) => r.name });
    expect(named.findAll('[data-test="dm-row-menu"]').slice(0, 2).map((b) => b.attributes('aria-label'))).toEqual(['Actions for w0000', 'Actions for w0001']);
    named.unmount();
    const plain = render({ headers: where, actions });
    expect(plain.find('[data-test="dm-row-menu"]').attributes('aria-label')).toBe('Actions for w0000 (AWS, eu-west-3)');
  });

  it('a server table: its options go to the view, the search is the view\'s, an export reads every row through server.all, 5,000 at most, saying it was cut', async () => {
    const all = vi.fn(async (limit: number) => rows(Math.min(limit, 7200)));
    const w = render({ items: rows(50), server: { total: 7200, all }, search: 'w0001' });
    await flushPromises();
    expect(w.emitted('update:options')![0]).toEqual([expect.objectContaining({ page: 1, itemsPerPage: 50 })]);
    // Not filtered here: the view sends the search to the API.
    expect(w.findAll('tbody tr')).toHaveLength(50);
    expect(w.find('.v-data-table-footer').exists()).toBe(true);
    // A server table pages; it has no "All".
    expect(w.findComponent({ name: 'VDataTableFooter' }).props('itemsPerPageOptions')).toEqual([{ value: 25, title: '25' }, { value: 50, title: '50' }, { value: 100, title: '100' }]);
    await openTableMenu(w);
    await press('[data-test="dm-table-export-csv"]');
    expect(all).toHaveBeenCalledWith(5000);
    const lines = csvLines();
    expect(lines).toHaveLength(1 + 5000 + 1);
    expect(lines[5000]).toBe('w4999,awake,4999,');
    expect(lines[5001]).toBe('"The first 5,000 rows of 7,200: narrow the search or the filters to export the others.",,,');

    await openTableMenu(w);
    await press('[data-test="dm-table-export-pdf"]');
    const doc = vi.mocked(pdf).mock.calls[0]![0];
    expect(doc.rows).toHaveLength(5000);
    expect(doc.lines).toContain('The first 5,000 rows of 7,200: narrow the search or the filters to export the others.');
    expect(doc.lines[0]).toMatch(/· 5,000 rows$/);
  });

  it('a server table whose total is not known (a list read by cursor): an export reads one row more than it keeps, to say when it was cut', async () => {
    const all = vi.fn(async (limit: number) => rows(Math.min(limit, 6000)));
    const w = render({ items: rows(50), server: { total: null, all } });
    // Vuetify's count is the page's: the view pages it.
    expect(w.findAll('tbody tr')).toHaveLength(50);
    await openTableMenu(w);
    await press('[data-test="dm-table-export-csv"]');
    expect(all).toHaveBeenCalledWith(5001);
    let lines = csvLines();
    expect(lines).toHaveLength(1 + 5000 + 1);
    expect(lines[5000]).toBe('w4999,awake,4999,');
    expect(lines[5001]).toBe('"The first 5,000 rows: narrow the search or the filters to export the others.",,,');
    // Exactly 5,000: nothing was cut.
    all.mockImplementation(async () => rows(5000));
    vi.mocked(download).mockClear();
    await openTableMenu(w);
    await press('[data-test="dm-table-export-csv"]');
    lines = csvLines();
    expect(lines).toHaveLength(1 + 5000);
    expect(lines.at(-1)).toBe('w4999,awake,4999,');
  });

  it('ends an export with the line a server table\'s reading gives when it stopped before the list\'s end, in the CSV and the PDF', async () => {
    const stopped = '12 rows read in 51 requests, the most an export makes: narrow the search or the filters to export the others.';
    const all = vi.fn(async () => ({ rows: rows(12), note: stopped }));
    const w = render({ items: rows(12), server: { total: null, all } });
    await openTableMenu(w);
    await press('[data-test="dm-table-export-csv"]');
    const lines = csvLines();
    expect(lines).toHaveLength(1 + 12 + 1);
    expect(lines.at(-1)).toBe(`"${stopped}",,,`);
    await openTableMenu(w);
    await press('[data-test="dm-table-export-pdf"]');
    const doc = vi.mocked(pdf).mock.calls[0]![0];
    expect(doc.rows).toHaveLength(12);
    expect(doc.lines).toContain(stopped);
  });

  it('ends a client table\'s export with the view\'s note when it gives one (the rows it holds are a part of a list)', async () => {
    const note = 'Searched among the first 5,000 candidates of this status: narrow the filters to search the others.';
    const w = render({ items: rows(6), exported: { ...exported, note } });
    await openTableMenu(w);
    await press('[data-test="dm-table-export-csv"]');
    expect(csvLines().at(-1)).toBe(`"${note}",,,`);
    await openTableMenu(w);
    await press('[data-test="dm-table-export-pdf"]');
    expect(vi.mocked(pdf).mock.calls[0]![0].lines).toContain(note);
  });

  it('says when an export fails, and the table stays', async () => {
    const all = vi.fn(async () => { throw new Error('throttled'); });
    const w = render({ items: rows(50), server: { total: 120, all } });
    await openTableMenu(w);
    await press('[data-test="dm-table-export-csv"]');
    expect(download).not.toHaveBeenCalled();
    expect(w.text()).toContain('The export failed: throttled');
    expect(w.findAll('tbody tr')).toHaveLength(50);
  });

  it('shows its rows while loading again: a view\'s loading slot given only before the first rows is no longer used', async () => {
    // As Users and Audit: `<template v-if="!users.length" #loading>`.
    const Host = defineComponent({
      props: { items: { type: Array, required: true }, loading: Boolean },
      setup: (p) => () => h(DmTable as unknown as Component, { headers, items: p.items, itemValue: 'name', exported, loading: p.loading },
        p.items.length ? {} : { loading: () => h('div', { class: 'reading' }, 'Reading…') }),
    });
    wrapper = mount(Host, { props: { items: [], loading: true }, attachTo: document.body, global: { plugins: [createVuetify({ components })] } });
    await flushPromises();
    expect(wrapper.find('.reading').exists()).toBe(true);
    await wrapper.setProps({ items: rows(3), loading: false });
    await flushPromises();
    expect(names(wrapper)).toEqual(['w0000', 'w0001', 'w0002']);
    await wrapper.setProps({ loading: true });
    await flushPromises();
    expect(names(wrapper)).toEqual(['w0000', 'w0001', 'w0002']);
    expect(wrapper.find('.v-data-table-rows-loading').exists()).toBe(false);
  });

  it('warns in development of a column with a cell of its own but no text and no field: search and exports would read nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render({ headers: [...headers, { title: 'Health', key: 'health' }] }, { 'item.health': () => h('span', '✓'), 'item.name': ({ item }: { item: Row }) => h('b', item.name) });
    await flushPromises();
    const said = warn.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();
    expect(said.filter((m) => m.includes('DmTable'))).toEqual([expect.stringContaining('"Health" (health)')]);
  });

  it('says in the PDF the search in force when the export was asked, though it changed while the rows were read', async () => {
    let release: (rows: Row[]) => void = () => {};
    const all = vi.fn(() => new Promise<Row[]>((r) => { release = r; }));
    const w = render({ items: rows(50), server: { total: 120, all }, search: 'napping', exported: { ...exported, filters: ['Router: dmtr-a'] } });
    await openTableMenu(w);
    (document.querySelector('.v-overlay--active [data-test="dm-table-export-pdf"]') as HTMLElement).click();
    await flushPromises();
    await w.setProps({ search: 'awake', exported: { ...exported, filters: ['Router: dmtr-b'] } });
    release(rows(120));
    await flushPromises();
    expect(vi.mocked(pdf).mock.calls[0]![0].lines.slice(1)).toEqual(['Search: “napping”', 'Router: dmtr-a']);
  });

  it('a selectable table: the rows chosen, kept as their values', async () => {
    const w = render({ selectable: true, selected: [] });
    await w.findAll('tbody tr')[1]!.find('input[type="checkbox"]').trigger('click');
    expect(w.emitted('update:selected')!.at(-1)).toEqual([['w0001']]);
  });

  it('an expandable table: a row opens its part under it', async () => {
    const w = render({ expandable: true, expanded: ['w0002'] }, { 'expanded-row': ({ item, columns }: { item: Row; columns: unknown[] }) => h('tr', h('td', { colspan: columns.length, class: 'steps' }, `steps of ${item.name}`)) });
    expect(w.findAll('.steps').map((s) => s.text())).toEqual(['steps of w0002']);
  });

  it('an expandable table: each row\'s toggle, before the Actions column, named by what it opens and the row, says whether it is open', async () => {
    const w = render({ expandable: true, expandTitle: 'Steps', expanded: [] }, { 'expanded-row': ({ item, columns }: { item: Row; columns: unknown[] }) => h('tr', h('td', { colspan: columns.length, class: 'steps' }, `steps of ${item.name}`)) });
    // The Actions column stays last; the toggles' column is named for screen readers.
    expect(w.findAll('thead th').map((th) => th.text()).slice(-2)).toEqual(['Steps', 'Actions']);
    const toggle = () => w.findAll('tbody tr').find((r) => r.text().includes('w0002'))!.find('[data-test="dm-row-expand"]');
    expect(toggle().attributes()).toMatchObject({ 'aria-label': 'Steps of w0002', 'aria-expanded': 'false' });
    await toggle().trigger('click');
    await flushPromises();
    expect(w.emitted('update:expanded')!.at(-1)).toEqual([['w0002']]);
    expect(w.findAll('.steps').map((s) => s.text())).toEqual(['steps of w0002']);
    expect(toggle().attributes('aria-expanded')).toBe('true');
    await toggle().trigger('click');
    await flushPromises();
    expect(w.emitted('update:expanded')!.at(-1)).toEqual([[]]);
    expect(w.find('.steps').exists()).toBe(false);
    w.unmount();
    // Without a title: "Details".
    const plain = render({ expandable: true });
    expect(plain.find('[data-test="dm-row-expand"]').attributes('aria-label')).toBe('Details of w0000');
  });

  it('an expandable table: each toggle names the part it opens (aria-controls), the id the expanded-row slot puts on it, one per row and per table', async () => {
    const part = { 'expanded-row': ({ item, columns, expandedId }: { item: Row; columns: unknown[]; expandedId: string }) => h('tr', h('td', { colspan: columns.length, id: expandedId, class: 'steps' }, `steps of ${item.name}`)) };
    const w = render({ expandable: true, expandTitle: 'Steps', expanded: ['w0002'] }, part);
    const toggles = w.findAll('[data-test="dm-row-expand"]');
    const ids = toggles.map((t) => t.attributes('aria-controls'));
    expect(new Set(ids).size).toBe(6);
    expect(ids.every(Boolean)).toBe(true);
    expect(w.find('.steps').attributes('id')).toBe(ids[2]);
    expect(document.getElementById(ids[2]!)!.textContent).toBe('steps of w0002');
    w.unmount();
    // Two tables of the same rows on a page: other ids.
    const two = defineComponent({ render: () => [1, 2].map((n) => h(DmTable as unknown as Component, { key: n, headers, items: rows(6), itemValue: 'name', exported, expandable: true }, part)) });
    wrapper = mount(two, { attachTo: document.body, global: { plugins: [createVuetify({ components })] } });
    const both = wrapper.findAll('[data-test="dm-row-expand"]').map((t) => t.attributes('aria-controls'));
    expect(both).toHaveLength(12);
    expect(new Set(both).size).toBe(12);
  });

  it('brings a row into view (reveal): the page holding it in the sort shown; a search that hides it is cleared', async () => {
    const w = render({ items: rows(120), sortBy: [{ key: 'name', order: 'desc' }] });
    const table = w.vm as unknown as { reveal: (value: unknown) => Promise<boolean> };
    expect(names(w)[0]).toBe('w0119');
    // w0010 is the 110th row going down: page 3 of 50.
    expect(await table.reveal('w0010')).toBe(true);
    await flushPromises();
    expect(names(w)).toContain('w0010');
    expect(w.emitted('update:page')!.at(-1)).toEqual([3]);
    // A search that hides it is cleared, then its page (w0050 is the 70th: page 2).
    await w.setProps({ search: 'w011' });
    await flushPromises();
    expect(await table.reveal('w0050')).toBe(true);
    await flushPromises();
    expect(w.emitted('update:search')!.at(-1)).toEqual(['']);
    expect(names(w)).toContain('w0050');
    expect(w.emitted('update:page')!.at(-1)).toEqual([2]);
    // A row the table does not hold: nothing moves.
    expect(await table.reveal('nope')).toBe(false);
  });

  it('keeps its Actions column in view when the table must scroll sideways: the column marked, the table said to scroll', async () => {
    // The observers the table watches its width with, called as a browser would.
    const observers: (() => void)[] = [];
    const Before = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class { constructor(run: () => void) { observers.push(run); } observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
    try {
      const w = render({ actions: () => [{ title: 'Pause…', icon: mdiPauseCircleOutline, run: () => {} }] });
      await flushPromises();
      expect(w.find('thead th:last-child').classes()).toContain('dm-table__actions');
      expect(w.find('tbody tr td:last-child').classes()).toContain('dm-table__actions');
      const wrapper = w.find('.v-table__wrapper').element as HTMLElement;
      const size = (scroll: number, client: number) => {
        Object.defineProperty(wrapper, 'scrollWidth', { configurable: true, value: scroll });
        Object.defineProperty(wrapper, 'clientWidth', { configurable: true, value: client });
        for (const run of observers) run();
      };
      size(950, 950);
      await nextTick();
      expect(w.find('.dm-table').classes()).not.toContain('dm-table--scrolls');
      size(1240, 950);
      await nextTick();
      expect(w.find('.dm-table').classes()).toContain('dm-table--scrolls');
      size(1200, 1214);
      await nextTick();
      expect(w.find('.dm-table').classes()).not.toContain('dm-table--scrolls');
      // No row with an action (Workloads): nothing to keep in view, the column scrolls with the others.
      await w.setProps({ actions: () => [] });
      size(1240, 950);
      await nextTick();
      expect(w.find('.dm-table').classes()).not.toContain('dm-table--scrolls');
    } finally {
      globalThis.ResizeObserver = Before;
    }
  });

  // Workloads at 1280 px with the drawer open: its rows have no action, so its Actions column scrolls with the others, and
  // the header's "⋮" (the exports) with it out of view.
  it('puts the table\'s "⋮" in its toolbar while the table scrolls sideways and no row has an action, in its header again once it fits', async () => {
    const observers: (() => void)[] = [];
    const Before = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class { constructor(run: () => void) { observers.push(run); } observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
    try {
      const w = render({ noSearch: true });
      await flushPromises();
      const wrapper = w.find('.v-table__wrapper').element as HTMLElement;
      const size = async (scroll: number, client: number) => {
        Object.defineProperty(wrapper, 'scrollWidth', { configurable: true, value: scroll });
        Object.defineProperty(wrapper, 'clientWidth', { configurable: true, value: client });
        for (const run of observers) run();
        await nextTick();
      };
      const where = () => w.findAll('[data-test="dm-table-menu"]').map((m) => (m.element.closest('th') ? 'header' : m.element.closest('.dm-table__toolbar') ? 'toolbar' : 'elsewhere'));
      await size(950, 950);
      expect([where(), w.find('.dm-table__toolbar').exists()]).toEqual([['header'], false]);
      await size(1240, 950);
      expect(where()).toEqual(['toolbar']);
      expect(w.find('[data-test="dm-table-menu"]').attributes('aria-label')).toBe('Table actions: Tests');
      expect(w.find('.dm-table').classes()).not.toContain('dm-table--scrolls');
      // The header narrower without its "⋮": the table fitting by those few pixels keeps it in the toolbar (no flip-flop).
      await size(946, 950);
      expect(where()).toEqual(['toolbar']);
      await size(900, 950);
      expect(where()).toEqual(['header']);
      // A row with an action: the Actions column is kept in view, its header's "⋮" with it.
      await size(1240, 950);
      await w.setProps({ actions: () => [{ title: 'Pause…', icon: mdiPauseCircleOutline, run: () => {} }] });
      await nextTick();
      expect(where()).toEqual(['header']);
      expect(w.find('.dm-table').classes()).toContain('dm-table--scrolls');
    } finally {
      globalThis.ResizeObserver = Before;
    }
  });

  it('calls a server\'s all as its method (a view\'s server object may read its own fields)', async () => {
    const server = { total: 3, rows: rows(3), async all(this: { rows: Row[] }, limit: number) { return this.rows.slice(0, limit); } };
    const w = render({ items: rows(3), server });
    await openTableMenu(w);
    await press('[data-test="dm-table-export-csv"]');
    expect(w.find('.v-alert').exists()).toBe(false);
    expect(csvLines()).toHaveLength(1 + 3);
  });

  it('puts a view\'s filters in the toolbar, left of the search; a view\'s cell where it gives one, the column\'s text elsewhere', async () => {
    const w = render({}, { toolbar: () => h('span', { class: 'my-filter' }, 'Needing attention'), 'item.name': ({ item }: { item: Row }) => h('a', { class: 'my-name' }, item.name) });
    const toolbar = w.find('.dm-table__toolbar');
    expect(toolbar.find('.my-filter').exists()).toBe(true);
    expect(toolbar.html().indexOf('my-filter')).toBeLessThan(toolbar.html().indexOf('dm-table-search'));
    expect(w.findAll('.my-name')).toHaveLength(6);
    expect(w.findAll('tbody tr')[0]!.findAll('td')[1]!.text()).toBe('napping');
  });
});
