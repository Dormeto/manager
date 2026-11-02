// A page's title is one line (the user, 2026-11-02): its section and its name side by side, "FLEET / Schedules", through PageTitle.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createRouter, createMemoryHistory } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import PageTitle from '../src/components/PageTitle.vue';

const views = resolve(import.meta.dirname, '../src/views');
// The workload's page has a hero, its logo beside two lines: not a page title.
const HERO = ['WorkloadView.vue'];

describe('page titles', () => {
  for (const file of readdirSync(views).filter((f) => f.endsWith('.vue') && !HERO.includes(f))) {
    it(`${file} titles its page on one line`, () => {
      const text = readFileSync(resolve(views, file), 'utf8');
      if (!text.includes('<h1') && !text.includes('<PageTitle')) return;
      expect(text).toContain('<PageTitle');
      expect(text).not.toContain('<h1');
    });
  }

  it('puts the section, a separator and the name on one row, the name the page\'s heading, a way back first when given', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p*', component: { render: () => null } }] });
    const wrapper = mount(PageTitle, { props: { eyebrow: 'Fleet', title: 'Schedules', back: '/routers', backLabel: 'Back to the routers' }, global: { plugins: [createVuetify({ components }), router] } });
    const row = wrapper.find('[data-test="page-title"]');
    expect(row.find('.dm-eyebrow').text()).toBe('Fleet');
    expect(row.find('h1').text()).toBe('Schedules');
    expect(row.find('a[aria-label="Back to the routers"]').exists()).toBe(true);
    expect(row.findAll(':scope > span, :scope > h1').map((e) => e.text())).toEqual(['Fleet', '/', 'Schedules']);
    const plain = mount(PageTitle, { props: { eyebrow: 'Administration', title: 'Audit' }, slots: { after: '<span class="chip">2 running</span>' }, global: { plugins: [createVuetify({ components }), router] } });
    expect(plain.find('a').exists()).toBe(false);
    expect(plain.find('[data-test="page-title"] .chip').text()).toBe('2 running');
  });
});
