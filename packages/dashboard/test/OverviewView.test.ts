import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import OverviewView from '../src/views/OverviewView.vue';

const late = new Date(Date.now() - 60 * 60_000).toISOString();
vi.mock('../src/api', () => ({
  api: vi.fn(async (path: string) => {
    if (path === '/alerts') {
      return {
        alarms: [{ id: 'router#1#eu-west-1', kind: 'router', name: 'dmt-dev', account: '1', region: 'eu-west-1', level: 'error', since: late, problems: [{ code: 'check-late', level: 'error', text: 'idle check late', since: late }] }],
        notifications: { topicArn: 'arn', confirmed: 1, pending: 0 },
      };
    }
    return {
      workloads: [], total: 0, byState: { ASLEEP: 2 }, stats7d: { wakes: 0, ignored: 0, deferred: 0 },
      routers: [{ name: 'dmt-dev', region: 'eu-west-1', version: '0.24.0', workloads: 2, checkSchedule: 'rate(5 minutes)', lastScheduledCheckAt: late, health: { status: 'error', problems: [] } }],
    };
  }),
}));
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

describe('Overview', () => {
  it('shows the open alarms in the Alerts card, instead of a banner per late router', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] });
    const wrapper = mount(OverviewView, { global: { plugins: [createVuetify({ components }), pinia, router] } });
    await flushPromises();
    expect(wrapper.text()).toContain('Alerts');
    expect(wrapper.text()).toContain('dmt-dev (1 · eu-west-1)idle check late');
    expect(wrapper.text()).not.toContain('do not nap on their own');
    wrapper.unmount();
  });
});
