// The idle signals in the settings dialogs (vision standalone workloads design §4, §6): each a number, Off, or empty to
// inherit (the placeholder says what and from where); the custom metric a small form or Off. A standalone workload's dialog
// has no waker's settings; a level's has both groups; the organization-level gate's refusal shows on the idle signals.
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import DefaultsDialog from '../src/components/DefaultsDialog.vue';
import IdleSignalsFields from '../src/components/IdleSignalsFields.vue';
import WorkloadSettingsDialog from '../src/components/WorkloadSettingsDialog.vue';
import ScheduleDialog from '../src/components/ScheduleDialog.vue';
import OnboardDialog from '../src/components/OnboardDialog.vue';
import { useSession } from '../src/stores/session';
import { idleChanges, idleFormOf } from '../src/idle-settings';
import { scheduleBody } from '../src/schedule';
import { createMemoryHistory, createRouter } from 'vue-router';

vi.mock('../src/api', () => ({ api: vi.fn(async () => null) }));
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});
const plugins = () => [createVuetify({ components, directives })];
const METRIC = { namespace: 'Custom/Jobs', name: 'QueueDepth', dimensions: { Instance: '${resource}' }, statistic: 'Maximum' as const, below: 1 };
const input = (test: string) => document.querySelector(`[data-test="${test}"] input`) as HTMLInputElement;
async function type(test: string, value: string) {
  const el = input(test);
  el.value = value;
  el.dispatchEvent(new Event('input'));
  await flushPromises();
}
const STANDALONE_STATUS = {
  kind: 'standalone' as const,
  settings: { idleMinutes: 120, wakeTimeoutSeconds: 600, idleCpuPercent: 5, idleNetworkBytes: 'off' as const, idleMetric: METRIC },
  settingsFrom: { idleMinutes: 'default' as const, wakeTimeoutSeconds: 'default' as const, idleCpuPercent: 'default' as const, idleNetworkBytes: 'workload' as const, idleMetric: 'type' as const },
  type: { name: 'instance', from: 'backends' as const }, wakeMode: 'any', noWakeRules: [], wakeRules: [],
};

describe('the idle signals\' form', () => {
  it('keeps a level\'s own values, sends a value, off, or null to inherit, the metric whole', () => {
    const initial = idleFormOf({ idleCpuPercent: 5, idleNetworkBytes: 'off' });
    expect(initial).toEqual({ idleCpuPercent: '5', cpuOff: false, idleNetworkBytes: '', networkOff: true, metricMode: 'inherit', metric: { namespace: '', name: '', dimensions: [], statistic: 'Maximum', below: '' } });
    const edited = { ...initial, idleCpuPercent: '', cpuOff: false, networkOff: false, idleNetworkBytes: '2000', metricMode: 'metric' as const, metric: { namespace: 'Custom/Jobs', name: 'QueueDepth', dimensions: [{ name: 'Instance', value: '${resource}' }], statistic: 'Maximum' as const, below: '1' } };
    expect(idleChanges(initial, edited)).toEqual({ changes: { idleCpuPercent: null, idleNetworkBytes: 2000, idleMetric: METRIC }, problem: null });
    expect(idleChanges(initial, { ...initial, metricMode: 'off' })).toEqual({ changes: { idleMetric: 'off' }, problem: null });
    expect(idleChanges(initial, { ...initial, idleCpuPercent: '101' }).problem).toBe('CPU: a number from 0 to 100, or off');
    expect(idleChanges(initial, { ...edited, metric: { ...edited.metric, name: '' } }).problem).toBe('Custom metric: its namespace, name and threshold are needed');
  });
});

describe('a standalone workload\'s settings dialog', () => {
  it('has its kind\'s settings only, the inherited value as each placeholder, and sends what changed', async () => {
    setActivePinia(createPinia());
    const w = mount(WorkloadSettingsDialog, { props: { modelValue: false, subject: 'build-agent', status: STANDALONE_STATUS as never }, attachTo: document.body, global: { plugins: plugins() } });
    await w.setProps({ modelValue: true });
    await flushPromises();
    for (const key of ['waitSeconds', 'drainSeconds', 'maxHolders', 'failedRetrySeconds', 'wakeMode', 'noWakeRules', 'wakeRules']) expect(document.querySelector(`[data-test="setting-${key}"]`), key).toBeNull();
    expect(input('setting-idleMinutes').placeholder).toBe('Inherit (120 min, built-in)');
    expect(input('idle-cpu').placeholder).toBe('Inherit (under 5 %, built-in)');
    expect((document.querySelector('[data-test="idle-network-off"] input') as HTMLInputElement).checked).toBe(true);
    await type('idle-cpu', '3');
    (document.querySelector('[data-test="save-settings"]') as HTMLButtonElement).click();
    await flushPromises();
    expect(w.emitted('submit')).toEqual([[{ idleCpuPercent: 3 }]]);
    w.unmount();
  });
});

describe('a level\'s defaults dialog', () => {
  async function open(props: Record<string, unknown>) {
    setActivePinia(createPinia());
    useSession().role = 'admin';
    const w = mount(DefaultsDialog, { props: { modelValue: false, title: 'The organization\'s workload settings', level: 'organization', values: {}, ...props }, attachTo: document.body, global: { plugins: plugins() } });
    await w.setProps({ modelValue: true });
    await flushPromises();
    return w;
  }

  it('shows both kinds\' settings under two headings, the idle signals with their built-in values', async () => {
    const w = await open({ values: { idleCpuPercent: 'off' } });
    const headings = [...document.querySelectorAll('[data-test="defaults-group"]')].map((h) => h.textContent!.trim());
    expect(headings).toEqual(['HTTP workloads', 'Standalone workloads']);
    expect(input('idle-cpu').placeholder).toBe('Off');
    expect((document.querySelector('[data-test="idle-cpu-off"] input') as HTMLInputElement).checked).toBe(true);
    expect(input('idle-network').placeholder).toBe('Built-in (off)');
    await type('idle-network', '1000');
    (document.querySelector('[data-test="save-defaults"]') as HTMLButtonElement).click();
    await flushPromises();
    expect(w.emitted('submit')).toEqual([[{ idleNetworkBytes: 1000 }]]);
    w.unmount();
  });

  it('shows the gate\'s refusal on the idle signals, as the API says it', async () => {
    const refusal = 'the organization\'s idle signals need every router at 0.42.0 or later and no Google Cloud router: 1 router must be upgraded first: dmt-dev (0.41.0)';
    const w = await open({ error: refusal });
    expect(document.querySelector('[data-test="idle-problem"]')!.textContent).toContain(refusal);
    expect(document.querySelector('[data-test="defaults-problem"]')).toBeNull();
    w.unmount();
  });

  it('has no idle signal for a Google Cloud router', async () => {
    const w = await open({ level: 'router', name: 'dmtr-p-europe-west2', idle: false });
    expect(w.findComponent(IdleSignalsFields).exists()).toBe(false);
    w.unmount();
  });
});

describe('a standalone workload\'s schedule', () => {
  it('has no wake choice in a nap window', async () => {
    setActivePinia(createPinia());
    const schedule = { timeZone: 'UTC', windows: [{ kind: 'nap', days: ['mon'], start: '20:00', end: '07:00', wake: 'never' }], maxNapDays: 7 };
    const w = mount(ScheduleDialog, { props: { modelValue: false, schedule: schedule as never, name: 'build-agent', kinds: ['instance'], standalone: true }, attachTo: document.body, global: { plugins: plugins() } });
    await w.setProps({ modelValue: true });
    await flushPromises();
    expect(document.querySelector('[data-test="window-wake"]')).toBeNull();
    (document.querySelector('[data-test="save-schedule"]') as HTMLButtonElement | null)?.click();
    await flushPromises();
    const sent = w.emitted('submit')?.[0]?.[0] as { windows: Record<string, unknown>[] } | undefined;
    if (sent) expect(sent.windows.every((x) => !('wake' in x))).toBe(true);
    expect(scheduleBody(schedule as never, '', { standalone: true }).windows![0]).not.toHaveProperty('wake');
    expect(scheduleBody(schedule as never, '').windows![0]).toHaveProperty('wake', 'never');
    w.unmount();
  });
});

describe('onboarding a resource', () => {
  it('says what stopping it means, that nothing wakes it on demand, and offers a schedule', async () => {
    setActivePinia(createPinia());
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:rest(.*)', component: { render: () => null } }] });
    const w = mount(OnboardDialog, { props: { modelValue: false, title: 'build-agent', defaultName: 'build-agent', resource: 'instance' }, attachTo: document.body, global: { plugins: [...plugins(), router] } });
    await w.setProps({ modelValue: true });
    await flushPromises();
    const text = document.querySelector('[data-test="onboard-standalone"]')!.textContent!;
    expect(text).toContain('A nap stops the instance');
    expect(text).toContain('Nothing wakes it on demand: a schedule, a person or a start made in AWS does.');
    expect(document.querySelector('[data-test="onboard-schedule"]')!.getAttribute('href')).toBe('/schedules');
    expect(document.querySelector('[data-test="onboard-wakeMode"]')).toBeNull();
    expect(input('idle-cpu')).not.toBeNull();
    w.unmount();
  });
});
