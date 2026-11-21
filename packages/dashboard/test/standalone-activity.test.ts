// A standalone workload's Activity history (vision standalone workloads design §6, §7): a line per signal over 7 days against
// its threshold, its hours asleep shaded, and the idle window advice from 5 minutes to 24 hours with the replay's assumption;
// a read that failed says so, with the card's rows and no advice.
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import ActivityCard from '../src/components/ActivityCard.vue';
import IdleWindowCard from '../src/components/IdleWindowCard.vue';

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const FROM = '2026-11-14T11:55:00.000Z';
const TO = '2026-11-21T11:55:00.000Z';
const STATUS = {
  workloadId: 'sa', name: 'build-agent', kind: 'standalone', state: 'AWAKE', pauses: [], type: { name: 'instance', from: 'backends' },
  idle: [
    { signal: 'cpu', below: 5, value: 1.2, underSince: minutesAgo(40), applies: true, from: 'default' },
    { signal: 'network', below: null, value: null, underSince: null, applies: false, reason: 'off', from: 'default' },
  ],
  nap: null, settings: { idleMinutes: 120, wakeTimeoutSeconds: 600, idleCpuPercent: 5, idleNetworkBytes: 'off', idleMetric: 'off' },
};
const WINDOWS = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720, 1440];
const ADVICE = {
  computedAt: TO, from: FROM, to: TO, current: 120, recommended: 60, checkMinutes: 5, wakeSeconds: 70, priced: false, wakerTargetGroup: false, estimated: false,
  actual: { wakes: 6, replayedWakes: 6, noisy: false },
  windows: WINDOWS.map((minutes) => ({ minutes, asleepHours: minutes >= 1440 ? 0 : 24 - minutes / 30, usdMonth: null, wakesPerDay: minutes >= 1440 ? 0 : 1, waitSecondsPerDay: 70 })),
};
const ACTIVITY = {
  from: FROM, to: TO, asleep: [{ from: '2026-11-15T00:00:00.000Z', to: '2026-11-15T08:00:00.000Z' }],
  signals: [
    { signal: 'cpu', below: 5, applies: true, from: 'default', values: Array.from({ length: 2016 }, (_, p) => (p % 288 < 12 ? 80 : p % 7 === 0 ? null : 1)) },
    { signal: 'network', below: null, applies: false, reason: 'off', from: 'default', values: [] },
  ],
  advice: ADVICE,
};
let answer: () => unknown = () => ACTIVITY;
vi.mock('../src/api', () => ({ api: vi.fn(async () => answer()) }));
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
const mountCard = async () => {
  const w = mount(ActivityCard, { props: { status: STATUS as never, now: Date.now(), router: 'dmt-dev', id: 'sa', canApply: true, source: 'manager' }, global: { plugins: [createVuetify({ components, directives })] } });
  await flushPromises();
  return w;
};

describe('the Activity card\'s history', () => {
  it('draws each applying signal over 7 days against its threshold, its hours asleep shaded', async () => {
    answer = () => ACTIVITY;
    const w = await mountCard();
    const charts = w.findAll('[data-test="signal-chart"]');
    expect(charts).toHaveLength(1);
    expect(charts[0]!.attributes('aria-label')).toBe('CPU over 7 days: under 5 % is idle');
    expect(charts[0]!.findAll('[data-test="threshold"]')).toHaveLength(1);
    expect(charts[0]!.findAll('[data-test="asleep"]')).toHaveLength(1);
    // A missing point breaks the line.
    expect(charts[0]!.findAll('path[data-test="line"]').length).toBeGreaterThan(0);
  });

  it('gives the idle window advice from 5 minutes to 24 hours, with the replay\'s assumption, the recommendation one click away', async () => {
    answer = () => ACTIVITY;
    const w = await mountCard();
    const card = w.findComponent(IdleWindowCard);
    expect(card.findAll('[data-test="idle-row"]').map((r) => r.find('td').text().split(' ')[0])).toEqual(['5', '10', '15', '20', '30', '45', '60', '90', '120', '180', '240', '360', '480', '720', '1440']);
    expect(card.text()).toContain('After a nap, it is started again when its history next shows activity, by a schedule or a person.');
    expect(card.text()).not.toContain('request');
    // A stop and a start wait for nobody: stops a day, no wait.
    expect(card.findAll('th').map((t) => t.text())).toEqual(['Window', 'Asleep a day', 'Stops a day']);
    expect(card.text()).toContain('Recommended: 60 minutes, about 2 more hours asleep a day, with the same stops.');
    await card.find('[data-test="use-window"]').trigger('click');
    expect(w.emitted('apply')).toEqual([[60]]);
  });

  it('says why when its metrics could not be read: its rows, no chart and no advice', async () => {
    answer = () => { throw new Error('the metrics could not be read: CloudWatch could not read the metrics (Forbidden)'); };
    const w = await mountCard();
    expect(w.find('[data-test="activity-error"]').text()).toContain('the metrics could not be read');
    expect(w.findAll('[data-test="signal"]')).toHaveLength(2);
    expect(w.findAll('[data-test="signal-chart"]')).toHaveLength(0);
    expect(w.findComponent(IdleWindowCard).exists()).toBe(false);
  });

  it('says when no signal applies: no chart, no advice', async () => {
    answer = () => ({ signals: ACTIVITY.signals.map((s) => ({ ...s, applies: false, values: [] })), asleep: [], advice: null, reason: 'no idle signal applies: it naps on its schedule and on people\'s word only' });
    const w = await mountCard();
    expect(w.find('[data-test="activity-none"]').text()).toBe('No idle signal applies: it naps on its schedule and on people\'s word only.');
    expect(w.findComponent(IdleWindowCard).exists()).toBe(false);
  });
});
