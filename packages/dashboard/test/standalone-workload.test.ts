// A standalone workload's page (vision standalone workloads design §6; the router's status, task-R27-report.md "The
// status"): no waiting page, rules, targets, wake filtering, request cards or URL; an Activity card with each idle signal,
// the nap estimate and a missing resource; its settings its kind's; its history's idle cause in its words.
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import WorkloadView from '../src/views/WorkloadView.vue';
import ActivityCard from '../src/components/ActivityCard.vue';
import WaitingPageCard from '../src/components/WaitingPageCard.vue';
import RequestHeatmap from '../src/components/RequestHeatmap.vue';
import IdleWindowCard from '../src/components/IdleWindowCard.vue';
import { useSession } from '../src/stores/session';
import { causeText } from '../src/history';
import { standaloneSettingRows, signalName } from '../src/idle-settings';

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const ARN = 'arn:aws:ec2:eu-west-1:111122223333:instance/i-0abc';
const METRIC = { namespace: 'Custom/Jobs', name: 'QueueDepth', dimensions: { Instance: '${resource}' }, statistic: 'Maximum' as const, below: 1 };
// The router's standalone status (its keys; status.mjs standaloneStatus), with what the API adds.
const STATUS = {
  workloadId: 'a1b2c3d4e5f60718', name: 'build-agent', kind: 'standalone', resourceArn: ARN, router: { version: '0.42.0', build: 'b' }, source: 'manager', tags: {}, state: 'AWAKE',
  stateAt: minutesAgo(90), drift: [], updatedAt: minutesAgo(2), awakeSince: minutesAgo(90), wakeStartedAt: null, failedAt: null, failure: null, consecutiveFailures: 0, nextAttemptAt: null,
  wakeCount: 3, pendingWake: false, pauses: [],
  idle: [
    { signal: 'cpu', below: 5, value: 1.2, underSince: minutesAgo(40), applies: true, from: 'default' },
    { signal: 'network', below: null, value: null, underSince: null, applies: false, reason: 'off', from: 'default' },
    { signal: 'metric', below: 1, value: 3, underSince: null, applies: true, from: 'type' },
  ],
  nap: { eligibleAt: minutesAgo(-80), latestAt: minutesAgo(-85), inSeconds: 4800 },
  discovery: 'standalone', instances: [{ id: 'i-0abc', state: 'running' }], backends: [{ kind: 'instance', id: 'i-0abc', status: 'running' }], resourceMissing: true,
  ignoredTargets: [], recommendations: [],
  settings: { idleMinutes: 120, wakeTimeoutSeconds: 600, idleCpuPercent: 5, idleNetworkBytes: 'off', idleMetric: METRIC },
  settingsFrom: { idleMinutes: 'default', wakeTimeoutSeconds: 'default', idleCpuPercent: 'default', idleNetworkBytes: 'default', idleMetric: 'type' },
  type: { name: 'instance', from: 'backends' }, stats: { days: 7, since: minutesAgo(10_000), today: { wakes: {} }, total: { wakes: {} } }, schedule: null, next: [],
  account: '111122223333', region: 'eu-west-1', can: { wake: true, nap: true },
};
vi.mock('../src/api', () => ({ api: vi.fn(async (path: string) => (path.endsWith('/description') ? { description: null } : path.endsWith('/history') ? { phases: [], entries: [] } : structuredClone(STATUS))) }));
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});

async function mountView() {
  setActivePinia(createPinia());
  useSession().role = 'operator';
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/workloads/:router/:id', component: WorkloadView }, { path: '/:rest(.*)', component: { render: () => null } }] });
  await router.push('/workloads/dmt-dev/a1b2c3d4e5f60718');
  const wrapper = mount(WorkloadView, { props: { router: 'dmt-dev', id: 'a1b2c3d4e5f60718' }, attachTo: document.body, global: { plugins: [createVuetify({ components, directives }), router] } });
  await flushPromises();
  return wrapper;
}
const titles = (w: Awaited<ReturnType<typeof mountView>>) => w.findAll('.v-card-title').map((t) => t.text());

describe('a standalone workload\'s page', () => {
  it('has no waiting page, rules, targets, wake filtering, request cards or URL', async () => {
    const w = await mountView();
    expect(w.findComponent(WaitingPageCard).exists()).toBe(false);
    expect(w.findComponent(RequestHeatmap).exists()).toBe(false);
    expect(w.findComponent(IdleWindowCard).exists()).toBe(false);
    for (const title of ['Targets', 'Wake filtering', 'Rule']) expect(titles(w), title).not.toContain(title);
    expect(titles(w).some((t) => t.startsWith('Requests while not awake'))).toBe(false);
    expect(w.find('.dm-hero__url').exists()).toBe(false);
    const summary = w.find('.dm-summary').text();
    expect(summary).not.toContain('Route');
    expect(summary).not.toContain('Held requests');
    expect(summary).toContain('Standalone');
    w.unmount();
  });

  it('shows its Activity: each signal with its threshold, level, last value and since when it is under, the nap estimate, the resource missing', async () => {
    const w = await mountView();
    const card = w.findComponent(ActivityCard);
    const rows = card.findAll('[data-test="signal"]').map((r) => r.findAll('td').map((td) => td.text()));
    expect(rows).toEqual([
      ['CPU', 'under 5 %', 'built-in', '1.2 %', '40 min ago'],
      ['Network', 'off', 'built-in', '—', '—'],
      ['QueueDepth', 'under 1', 'type instance', '3', 'not under'],
    ]);
    expect(card.find('[data-test="nap-estimate"]').text()).toBe('Nap: eligible in 1 h 20 min');
    expect(card.find('[data-test="resource-missing"]').text()).toContain('Its resource is missing');
    w.unmount();
  });

  it('shows its kind\'s settings: the idle window, the wake timeout and its idle signals', async () => {
    const w = await mountView();
    const settings = w.findAll('.dm-setting').map((s) => s.find('strong').element.parentElement!.firstChild!.textContent!.trim() + ' ' + s.find('strong').text());
    expect(settings).toEqual(['Idle window 120 min', 'Wake timeout 10 min', 'CPU under 5 %', 'Network off', 'Custom metric QueueDepth under 1 (Maximum)']);
    w.unmount();
  });
});

describe('a standalone workload\'s words', () => {
  it('name each signal, the custom metric by its name', () => {
    expect([signalName('cpu'), signalName('network'), signalName('metric', METRIC), signalName('metric', 'off')]).toEqual(['CPU', 'Network', 'QueueDepth', 'Custom metric']);
    expect(standaloneSettingRows(STATUS.settings as never, STATUS.settingsFrom as never).map((r) => [r.label, r.value, r.from])).toEqual([
      ['Idle window', '120 min', 'default'], ['Wake timeout', '10 min', 'default'], ['CPU', 'under 5 %', 'default'], ['Network', 'off', 'default'],
      ['Custom metric', 'QueueDepth under 1 (Maximum)', 'type'],
    ]);
  });

  it('say an idle nap by the workload\'s kind', () => {
    expect(causeText({ state: 'NAPPING', cause: 'idle' })).toBe('the idle check (no request for its idle window)');
    expect(causeText({ state: 'NAPPING', cause: 'idle', kind: 'standalone' })).toBe('the idle check (idle on every signal for its idle window)');
  });
});
