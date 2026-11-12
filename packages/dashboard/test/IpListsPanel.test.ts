import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import IpListsPanel from '../src/components/IpListsPanel.vue';
import { download } from '../src/table-export';
import { expectEveryColumnSaid } from './table-columns';

const answer: { value: unknown } = { value: null };
vi.mock('../src/api', () => ({ api: vi.fn(async () => answer.value) }));
vi.mock('../src/table-export', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/table-export')>()), download: vi.fn() }));
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});
const NOW = Date.now();
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

const mounted: VueWrapper[] = [];
afterEach(() => { for (const w of mounted.splice(0)) w.unmount(); });
async function mountPanel(value: unknown) {
  answer.value = value;
  const wrapper = mount(IpListsPanel, { attachTo: document.body, global: { plugins: [createVuetify({ components })] } });
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}

const LISTS = {
  catalog: 's3://b/catalog.json',
  lists: [
    { name: 'ipsum', url: 'https://raw.githubusercontent.com/stamparm/ipsum/master/ipsum.txt', action: 'defer', refreshHours: 24, version: '1', entries: 21_345, fetchedAt: ago(2) },
    { name: 'gcp', url: 'https://www.gstatic.com/ipranges/cloud.json', action: 'defer', refreshHours: 24, version: '1', entries: 900, fetchedAt: ago(30), error: 'HTTP 503' },
    { name: 'aws', url: 'https://ip-ranges.amazonaws.com/ip-ranges.json', action: 'ignore', refreshHours: 24 },
  ],
};

describe('IpListsPanel', () => {
  it('lists the manager\'s lists: action, entries, last download, and what went wrong', async () => {
    const wrapper = await mountPanel(LISTS);
    const rows = wrapper.findAll('tbody tr').map((r) => r.text());
    expect(rows[0]).toMatch(/^ipsum.*defer.*21,345.*2 h ago/);
    expect(rows[1]).toMatch(/gcp.*900.*1 d ago/);
    expect(rows[2]).toMatch(/aws.*ignore/);
    // The status as an icon (tables design §3), what went wrong its name and tooltip; no word in the cell.
    const marks = wrapper.findAll('tbody [data-test="status-mark"]');
    expect(marks.map((m) => m.attributes('aria-label'))).toEqual(['ok', 'last download failed: HTTP 503', 'not downloaded yet']);
    expect(marks.map((m) => m.text())).toEqual(['', '', '']);
    expect(marks[1]!.classes()).toContain('text-warning');
    expect(wrapper.text()).toContain('Downloaded once for every router by the manager');
    // What they are and do (user request) is in the tooltip beside the title (the user, 2026-11-02): RoutersView.test.ts reads it.
    expect(wrapper.text()).not.toContain('Lists of addresses');
    expect(wrapper.find('[data-test="ip-lists-more"]').exists()).toBe(true);
  });

  it('says how to add lists when the catalog is empty, and hides itself without the manager\'s lists', async () => {
    expect((await mountPanel({ catalog: 's3://b/catalog.json', lists: [] })).text()).toContain('No list: set ip_lists in the manager\'s Terraform');
    expect((await mountPanel({ catalog: null, lists: [] })).find('.v-card').exists()).toBe(false);
  });

  it('exports its lists: each status in words, a list never downloaded with no count nor date', async () => {
    const wrapper = await mountPanel(LISTS);
    await wrapper.find('[data-test="dm-table-menu"]').trigger('click');
    await flushPromises();
    (document.querySelector('.v-overlay--active [data-test="dm-table-export-csv"]') as HTMLElement).click();
    await flushPromises();
    const [name, , body] = vi.mocked(download).mock.calls.at(-1)!;
    expect(name).toMatch(/^dormeto-ip-lists-\d{4}-\d{2}-\d{2}\.csv$/);
    expect((body as string).split('\r\n')).toEqual([
      'List,Action,Entries,Last download,Status',
      `ipsum,defer,21345,${ago(2)},ok`,
      `gcp,defer,900,${ago(30)},last download failed: HTTP 503`,
      'aws,ignore,,,not downloaded yet',
      '',
    ]);
    expectEveryColumnSaid(wrapper, 'ip-lists', (lists: { name: string }[]) => lists.find((l) => l.name === 'ipsum')!);
  });
});
