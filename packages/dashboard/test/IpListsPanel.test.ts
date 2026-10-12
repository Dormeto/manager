import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import IpListsPanel from '../src/components/IpListsPanel.vue';

const answer: { value: unknown } = { value: null };
vi.mock('../src/api', () => ({ api: vi.fn(async () => answer.value) }));
const NOW = Date.now();
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

async function mountPanel(value: unknown) {
  answer.value = value;
  const wrapper = mount(IpListsPanel, { global: { plugins: [createVuetify({ components })] } });
  await flushPromises();
  return wrapper;
}

describe('IpListsPanel', () => {
  it('lists the manager\'s lists: action, entries, last download, and what went wrong', async () => {
    const wrapper = await mountPanel({
      catalog: 's3://b/catalog.json',
      lists: [
        { name: 'ipsum', url: 'https://raw.githubusercontent.com/stamparm/ipsum/master/ipsum.txt', action: 'defer', refreshHours: 24, version: '1', entries: 21_345, fetchedAt: ago(2) },
        { name: 'gcp', url: 'https://www.gstatic.com/ipranges/cloud.json', action: 'defer', refreshHours: 24, version: '1', entries: 900, fetchedAt: ago(30), error: 'HTTP 503' },
        { name: 'aws', url: 'https://ip-ranges.amazonaws.com/ip-ranges.json', action: 'ignore', refreshHours: 24 },
      ],
    });
    const rows = wrapper.findAll('tbody tr').map((r) => r.text());
    expect(rows[0]).toMatch(/^ipsum.*defer.*21,345.*2 h ago/);
    expect(rows[1]).toMatch(/gcp.*900.*1 d ago.*last download failed: HTTP 503/);
    expect(rows[2]).toMatch(/aws.*ignore.*not downloaded yet/);
    expect(wrapper.text()).toContain('Downloaded once for every router by the manager');
  });

  it('says how to add lists when the catalog is empty, and hides itself without the manager\'s lists', async () => {
    expect((await mountPanel({ catalog: 's3://b/catalog.json', lists: [] })).text()).toContain('No list: set ip_lists in the manager\'s Terraform');
    expect((await mountPanel({ catalog: null, lists: [] })).find('.v-card').exists()).toBe(false);
  });
});
