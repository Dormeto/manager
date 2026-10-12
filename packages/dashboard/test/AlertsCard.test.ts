import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createRouter, createMemoryHistory } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import AlertsCard from '../src/components/AlertsCard.vue';
import type { AlertsInfo } from '../src/types';

const NOW = Date.UTC(2026, 9, 8, 12, 0);
const since = new Date(NOW - 20 * 60_000).toISOString();
const ALERTS: AlertsInfo = {
  alarms: [
    { id: 'list#ipsum', kind: 'list', name: 'ipsum', level: 'warning', since, problems: [{ code: 'error', level: 'warning', text: 'last download failed: HTTP 503', since }] },
    { id: 'router#1#eu-west-1', kind: 'router', name: 'dmt-dev', account: '1', region: 'eu-west-1', level: 'error', since, problems: [{ code: 'silent', level: 'error', text: 'no report for 22 minutes', since }] },
  ],
  notifications: { topicArn: 'arn:aws:sns:eu-west-1:1:dmt-dev-manager-alerts', confirmed: 1, pending: 1 },
};

function mountCard(alerts: AlertsInfo | null) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] });
  return mount(AlertsCard, { props: { alerts, now: NOW }, global: { plugins: [createVuetify({ components }), router] } });
}

describe('AlertsCard', () => {
  it('lists the open alarms, errors first, with their first problem and since when', () => {
    const items = mountCard(ALERTS).findAll('.v-list-item');
    expect(items.map((i) => i.text())).toEqual([
      expect.stringMatching(/^dmt-dev.*no report for 22 minutes · since 20 min ago/),
      expect.stringMatching(/^IP list ipsum.*last download failed: HTTP 503/),
    ]);
  });

  it('names a failed wake by its workload and account, and links to the workload (R7b)', () => {
    const wrapper = mountCard({
      alarms: [{ id: 'workload#2#eu-west-3#f1e2', kind: 'workload', name: 'shop', account: '2', region: 'eu-west-3', router: 'dmtr-dev-2-eu-west-3', workloadId: 'f1e2', level: 'error', since,
        problems: [{ code: 'wake-failed:capacity', level: 'error', text: 'wake failed: no capacity for db.t4g.micro', since }] }],
      notifications: { topicArn: 'arn', confirmed: 1, pending: 0 },
    });
    const item = wrapper.find('.v-list-item');
    expect(item.text()).toMatch(/^shop \(2 · eu-west-3\)wake failed: no capacity for db.t4g.micro/);
    expect(item.attributes('href')).toBe('/workloads/dmtr-dev-2-eu-west-3/f1e2');
  });

  it('says where alerts are sent, and that a subscription waits for its confirmation', () => {
    expect(mountCard(ALERTS).text()).toContain('Alerts are sent to 2 subscriptions (1 pending confirmation)');
    const none = mountCard({ alarms: [], notifications: { topicArn: 'arn', confirmed: 0, pending: 0 } }).text();
    expect(none).toContain('No open alert');
    expect(none).toContain('No subscription: alerts show here only (alert_emails in the manager\'s Terraform)');
  });

  it('shows nothing when the manager has no watchdog', () => {
    expect(mountCard({ alarms: [], notifications: null }).find('.v-card').exists()).toBe(false);
  });
});
