// Google Cloud standalone workloads in the dashboard (plan 5, M52): every standalone view in the cloud's own words (cloud-words.ts):
// a VM, a managed instance group, a Cloud SQL instance, "a start made in Google Cloud", Cloud Monitoring, what marks a resource;
// the custom metric's form in the level's cloud's shape (the organization's and a type's pick the cloud); the Activity card;
// a failed workload retried, napped by a person to end the retries; Discovery's candidates; the demo's data.
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import ActivityCard from '../src/components/ActivityCard.vue';
import IdleSignalsFields from '../src/components/IdleSignalsFields.vue';
import OnboardDialog from '../src/components/OnboardDialog.vue';
import ScheduleCard from '../src/components/ScheduleCard.vue';
import DefaultsDialog from '../src/components/DefaultsDialog.vue';
import WorkloadSettingsDialog from '../src/components/WorkloadSettingsDialog.vue';
import { useSession } from '../src/stores/session';
import KindMark from '../src/components/KindMark.vue';
import { idleChanges, idleFormOf, metricText, signalName, standaloneHelp, IDLE_BUILT_IN_OF } from '../src/idle-settings';
import { retriesText, retryText } from '../src/failures';
import { causeText } from '../src/history';
import { idleText } from '../src/discovery';
import { cloudWords } from '../src/cloud-words';
import { exclusionTargets } from '../src/pause';
import { resourceKindOf } from '../src/kinds';

vi.mock('../src/api', () => ({ api: vi.fn(async () => { throw new Error('no history here'); }) }));
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});
const plugins = () => [createVuetify({ components, directives }), createRouter({ history: createMemoryHistory(), routes: [{ path: '/:rest(.*)', component: { render: () => null } }] })];
const NOW = Date.UTC(2026, 11, 1, 12, 0);
const GCP_METRIC = { type: 'custom.googleapis.com/queue/depth', filter: 'metric.labels.agent = "${resource}"', aligner: 'ALIGN_MAX' as const, below: 1 };

describe('the cloud\'s words for a standalone workload', () => {
  it('say who wakes it, where its signals come from and what marks its resource, by cloud', () => {
    expect(cloudWords('gcp').standalone).toMatchObject({ startOutside: 'a start made in Google Cloud', signals: 'Cloud Monitoring', metric: 'A Cloud Monitoring metric' });
    expect(cloudWords('aws').standalone).toMatchObject({ startOutside: 'a start made in AWS', signals: 'CloudWatch', metric: 'A CloudWatch metric' });
    expect(`${cloudWords('gcp').standalone.missing} ${cloudWords('gcp').standalone.missingFix}`).toBe('It was deleted: nothing of it is stopped or started. Offboard the workload.');
    expect(standaloneHelp('idleMinutes', 'gcp')).toContain('a start made in Google Cloud');
    expect(standaloneHelp('idleCpuPercent', 'gcp')).toContain('Cloud Monitoring');
    expect(standaloneHelp('idleCpuPercent', 'gcp')).not.toMatch(/CloudWatch|EC2|RDS|ECS/);
    expect(IDLE_BUILT_IN_OF('gcp')).toEqual({ idleCpuPercent: 'under 5 %, off for a Cloud SQL instance', idleNetworkBytes: 'off', idleMetric: 'off; a Cloud SQL instance\'s connections under 1' });
  });

  it('name a Google Cloud metric by its type, and its kind mark by its cloud', () => {
    expect(signalName('metric', GCP_METRIC)).toBe('queue/depth');
    expect(metricText(GCP_METRIC)).toBe('queue/depth under 1 (ALIGN_MAX)');
    const mark = mount(KindMark, { props: { kind: 'standalone', cloud: 'gcp' }, global: { plugins: plugins() } });
    expect(mark.findComponent(components.VTooltip).props('text')).toBe('Standalone: a resource with no load balancer. A schedule, a person or a start made in Google Cloud wakes it.');
  });

  it('say a Google Cloud candidate\'s idle share from Cloud Monitoring', () => {
    expect(idleText({ idleHours7d: 150, resource: 'cloudsql-instance' }, 'gcp').source).toContain('Cloud Monitoring');
    expect(idleText({ idleHours7d: 150, resource: 'instance' }, 'gcp').detail).toBe('150 of 168 hours with its CPU under 5 % at every 5-minute point.');
  });
});

describe('a Google Cloud standalone resource', () => {
  it('has its kind read from its path, and is excluded by its path', () => {
    expect(resourceKindOf({ resource: 'projects/p/zones/europe-west2-b/instances/batch' })).toBe('instance');
    expect(resourceKindOf({ resource: 'projects/p/regions/europe-west2/instanceGroupManagers/workers' })).toBe('asg');
    expect(resourceKindOf({ resource: 'projects/p/instances/orders' })).toBe('cloudsql-instance');
    expect(resourceKindOf({ resourceArn: 'arn:aws:ec2:eu-west-1:111122223333:instance/i-0abc' })).toBe('instance');
    const path = 'projects/dormeto-dev/zones/europe-west2-b/instances/batch';
    expect(exclusionTargets({ kind: 'standalone', id: path, resource: path, name: 'batch', account: 'dormeto-dev', accountName: 'dormeto-dev' } as never)).toEqual([
      { kind: 'resource', path, label: 'Resource batch' },
      { kind: 'account', account: 'dormeto-dev', label: 'Project dormeto-dev (never read again)' },
    ]);
  });
});

describe('the custom metric\'s form', () => {
  const mountFields = (cloud: 'aws' | 'gcp' | 'any', values = {}) => mount(IdleSignalsFields, {
    props: { modelValue: { ...idleFormOf(values), metricMode: 'metric' as const }, placeholders: { idleCpuPercent: 'Inherit', idleNetworkBytes: 'Inherit', idleMetric: 'Inherit' }, cloud },
    attachTo: document.body, global: { plugins: plugins() },
  });

  it('has Google Cloud\'s fields at a Google Cloud level: type, filter with ${resource} offered, aligner, threshold', () => {
    const w = mountFields('gcp', { idleMetric: GCP_METRIC });
    expect(w.find('[data-test="idle-metric-type"]').exists()).toBe(true);
    expect(w.find('[data-test="idle-metric-filter"]').exists()).toBe(true);
    expect(w.find('[data-test="idle-metric-aligner"]').exists()).toBe(true);
    expect(w.find('[data-test="idle-metric-namespace"]').exists()).toBe(false);
    expect(w.find('[data-test="idle-metric-cloud"]').exists()).toBe(false);
    expect(w.text()).toContain('${resource} is the resource\'s name');
    w.unmount();
  });

  it('lets the organization pick the cloud, saying a router of the other cloud ignores it', () => {
    const w = mountFields('any');
    expect(w.find('[data-test="idle-metric-cloud"]').exists()).toBe(true);
    expect(w.find('[data-test="idle-metric-note"]').text()).toBe('A router of the other cloud ignores this metric.');
    w.unmount();
  });

  it('gives the changes in the cloud\'s shape', () => {
    const initial = idleFormOf({});
    const gcp = { ...idleFormOf({}), metricMode: 'metric' as const, metricCloud: 'gcp' as const, gcp: { type: ' custom.googleapis.com/queue/depth ', filter: 'metric.labels.agent = "${resource}"', aligner: 'ALIGN_MAX' as const, below: '1' } };
    expect(idleChanges(initial, gcp)).toEqual({ changes: { idleMetric: GCP_METRIC }, problem: null });
    expect(idleChanges(initial, { ...gcp, gcp: { ...gcp.gcp, filter: '' } })).toEqual({ changes: { idleMetric: { type: GCP_METRIC.type, aligner: 'ALIGN_MAX', below: 1 } }, problem: null });
    expect(idleChanges(initial, { ...gcp, gcp: { ...gcp.gcp, type: '' } }).problem).toBe('Custom metric: its type and threshold are needed');
    // A stored Google Cloud metric is read back in its shape.
    expect(idleFormOf({ idleMetric: GCP_METRIC })).toMatchObject({ metricMode: 'metric', metricCloud: 'gcp', gcp: { type: GCP_METRIC.type, filter: GCP_METRIC.filter, aligner: 'ALIGN_MAX', below: '1' } });
  });
});

describe('a Google Cloud standalone workload\'s page', () => {
  const STATUS = {
    workloadId: 'orders', name: 'orders', kind: 'standalone', state: 'AWAKE', pauses: [], type: { name: 'databases', from: 'backends' }, resourceMissing: true,
    idle: [
      { signal: 'cpu', below: null, value: null, underSince: null, applies: false, reason: 'off', from: 'type' },
      { signal: 'network', below: 1000, value: null, underSince: null, applies: false, reason: 'a Cloud SQL instance\'s network is not read: its connections are its signal', from: 'workload' },
      { signal: 'metric', below: 1, value: 0, underSince: new Date(NOW - 3_600_000).toISOString(), applies: true, from: 'type' },
    ],
    nap: null, settings: { idleMinutes: 120, wakeTimeoutSeconds: 1700, idleCpuPercent: 'off', idleNetworkBytes: 1000, idleMetric: { type: 'cloudsql.googleapis.com/database/network/connections', aligner: 'ALIGN_MAX', below: 1 } },
  };

  it('shows its signals in plain words, the network not read on a Cloud SQL instance with its reason, Cloud Monitoring\'s delay, its missing resource in Google Cloud\'s words', async () => {
    const w = mount(ActivityCard, { props: { status: STATUS as never, now: NOW, cloud: 'gcp' }, global: { plugins: plugins() } });
    await flushPromises();
    const rows = w.findAll('[data-test="signal"]').map((r) => r.findAll('td').map((td) => td.text()));
    expect(rows.map((r) => [r[0], r[1]])).toEqual([['CPU', 'off'], ['Network', 'does not apply'], ['network/connections', 'under 1']]);
    expect(w.text()).toContain('Network: a Cloud SQL instance\'s network is not read: its connections are its signal');
    expect(w.text()).toContain('Cloud Monitoring publishes the signals minutes late');
    expect(w.find('[data-test="resource-missing"]').text()).toContain('It was deleted: nothing of it is stopped or started. Offboard the workload.');
    expect(w.text()).not.toMatch(/CloudWatch|dormeto:workload/);
  });

  it('has its schedule card and its onboarding in Google Cloud\'s words', async () => {
    const card = mount(ScheduleCard, { props: { schedule: null, canEdit: false, standalone: true, cloud: 'gcp' }, global: { plugins: plugins() } });
    expect(card.text()).toContain('only a person or a start made in Google Cloud wakes it');
    setActivePinia(createPinia());
    for (const resource of ['instance', 'asg', 'cloudsql-instance']) {
      const w = mount(OnboardDialog, { props: { modelValue: false, title: 'r', defaultName: 'r', resource: resource as never, cloud: 'gcp' }, attachTo: document.body, global: { plugins: plugins() } });
      await w.setProps({ modelValue: true });
      await flushPromises();
      const items = [...document.querySelectorAll('[data-test="onboard-standalone"]')].map((e) => e.textContent!.trim());
      expect(items[2], resource).toBe('Nothing wakes it on demand: a schedule, a person or a start made in Google Cloud does.');
      expect(items.join(' '), resource).not.toMatch(/AWS|EC2|RDS|Aurora/);
      expect(items[0], resource).toContain('dormeto=managed');
      w.unmount();
    }
  });
});

describe('the settings dialogs on Google Cloud', () => {
  const q = (test: string) => document.querySelector(`[data-test="${test}"]`);
  async function openDefaults(props: Record<string, unknown>) {
    setActivePinia(createPinia());
    useSession().role = 'admin';
    const w = mount(DefaultsDialog, { props: { modelValue: false, title: 't', level: 'organization', values: {}, ...props }, attachTo: document.body, global: { plugins: plugins() } });
    await w.setProps({ modelValue: true });
    await flushPromises();
    return w;
  }

  it('gives a Google Cloud router\'s level its idle signals in Google Cloud\'s shape', async () => {
    const w = await openDefaults({ level: 'router', name: 'dmtr-p-europe-west2', cloud: 'gcp', values: { idleMetric: GCP_METRIC } });
    expect(w.findComponent(IdleSignalsFields).props('cloud')).toBe('gcp');
    expect((q('idle-metric-type')!.querySelector('input') as HTMLInputElement).value).toBe(GCP_METRIC.type);
    expect(q('idle-metric-cloud')).toBeNull();
    w.unmount();
  });

  it('lets the organization and a type hold either cloud\'s metric, the stored one in its shape', async () => {
    const w = await openDefaults({ values: { idleMetric: GCP_METRIC } });
    expect(w.findComponent(IdleSignalsFields).props('cloud')).toBe('any');
    expect(q('idle-metric-cloud')).not.toBeNull();
    expect(q('idle-metric-type')).not.toBeNull();
    expect(q('idle-metric-note')!.textContent).toBe('A router of the other cloud ignores this metric.');
    w.unmount();
    const t = await openDefaults({ level: 'type', name: 'batch' });
    expect(t.findComponent(IdleSignalsFields).props('cloud')).toBe('any');
    t.unmount();
  });

  it('shows the gate\'s refusal as the API now says it', async () => {
    const refusal = 'the organization\'s idle signals need every router at 0.42.0 or later: 1 router(s) must be upgraded first: dmtr-p-europe-west2 (0.41.0)';
    const w = await openDefaults({ error: refusal });
    expect(q('idle-problem')!.textContent).toContain(refusal);
    w.unmount();
  });

  it('gives a Google Cloud workload its metric in Google Cloud\'s shape and its helps in Google Cloud\'s words', async () => {
    setActivePinia(createPinia());
    const status = { kind: 'standalone', account: 'dormeto-dev', cloud: 'gcp', settings: { idleMinutes: 120, wakeTimeoutSeconds: 600, idleCpuPercent: 5, idleNetworkBytes: 'off', idleMetric: 'off' },
      settingsFrom: { idleMinutes: 'default', wakeTimeoutSeconds: 'default', idleCpuPercent: 'default', idleNetworkBytes: 'default', idleMetric: 'default' }, type: { name: 'instance', from: 'backends' }, wakeMode: 'any', noWakeRules: [], wakeRules: [] };
    const w = mount(WorkloadSettingsDialog, { props: { modelValue: false, subject: 'batch', status: status as never }, attachTo: document.body, global: { plugins: plugins() } });
    await w.setProps({ modelValue: true });
    await flushPromises();
    expect(w.findComponent(IdleSignalsFields).props('cloud')).toBe('gcp');
    expect(document.body.textContent).not.toMatch(/CloudWatch|start made in AWS/);
    const rows = (w.vm as unknown as { rows: { key: string; help: string; range: string }[] }).rows;
    expect(rows.find((r) => r.key === 'wakeTimeoutSeconds')).toMatchObject({ help: 'Longest a wake may take before the workload is marked FAILED; the check retries it until it succeeds or a person naps it.', range: '60 to 1,700 s; built-in 10 min, 28 min 20 s for a Cloud SQL instance.' });
    expect(rows.find((r) => r.key === 'idleMinutes')!.help).toContain('a start made in Google Cloud');
    w.unmount();
  });
});

describe('a failed standalone workload', () => {
  const rel = (iso: string) => `at ${iso}`;
  it('says its failed wake is retried until it succeeds or a person naps it, and when; a failed nap tried again after its idle window', () => {
    expect(retryText({ state: 'FAILED', nextAttemptAt: '2026-12-01T12:05:00.000Z', failure: { step: 'wake' } }, NOW, true, rel)).toBe('next attempt at 2026-12-01T12:05:00.000Z');
    expect(retryText({ state: 'FAILED', nextAttemptAt: null, failure: { step: 'wake' } }, NOW, true, rel)).toBe('not retried now: a pause, a nap window, its unreadable settings or resource, or a nap asked holds it');
    expect(retryText({ state: 'FAILED', nextAttemptAt: null, failure: { step: 'nap' } }, NOW, true, rel)).toBe('its nap is tried again after its idle window');
    expect(retriesText({ state: 'FAILED', failure: { step: 'wake' } }, true)).toBe('retried until it succeeds or a person naps it');
    expect(retriesText({ state: 'FAILED', failure: { step: 'nap' } }, true)).toBe('');
    expect(retriesText({ state: 'FAILED', failure: { step: 'wake' } }, false)).toBe('');
    // A person's nap of a failed workload is journaled FAILED → ASLEEP with cause manager and by (router 4c1fe78); the check's own
    // release keeps failed-released.
    expect(causeText({ state: 'ASLEEP', cause: 'manager', by: 'ana@example.com', kind: 'standalone' })).toBe('napped from the manager by ana@example.com');
    expect(causeText({ state: 'ASLEEP', cause: 'failed-released', kind: 'standalone' })).toBe('released after its idle window (the wake had failed)');
    // An HTTP workload's, as before.
    expect(retryText({ state: 'FAILED' }, NOW, false, rel)).toBe('the next request retries it');
  });
});

describe('the demo\'s Google Cloud standalone workloads', () => {
  it('has one of each kind in several states, a failed one retried, one with a kept permission failure, candidates eligible and not, and a run with a Cloud SQL problem', async () => {
    const { mockApi } = await import('../src/mock');
    const { workloads } = await mockApi('/workloads?kind=standalone&limit=200') as { workloads: { name: string; cloud?: string; kind?: string; resource?: string; state: string; failure?: { kind: string; step: string } | null; nextAttemptAt?: string | null }[] };
    const gcp = workloads.filter((w) => w.cloud === 'gcp');
    expect(new Set(gcp.map((w) => w.resource!.split('/').at(-2)))).toEqual(new Set(['instances', 'instanceGroupManagers']));
    expect(gcp.some((w) => /^projects\/[^/]+\/instances\//.test(w.resource!))).toBe(true);
    expect(new Set(gcp.map((w) => w.state))).toEqual(new Set(['AWAKE', 'ASLEEP', 'FAILED']));
    expect(gcp.some((w) => w.state === 'FAILED' && w.failure?.step === 'wake' && w.nextAttemptAt)).toBe(true);
    expect(gcp.some((w) => w.failure?.kind === 'permission' && /dormeto=managed/.test((w.failure as { message?: string }).message ?? ''))).toBe(true);
    for (const w of gcp) expect(w, w.name).not.toHaveProperty('resourceArn');
    const { candidates } = await mockApi('/discovery/candidates?status=pending-onboarding&kind=standalone&limit=200') as { candidates: { cloud?: string; eligibility: string }[] };
    expect(candidates.some((c) => c.cloud === 'gcp')).toBe(true);
    const all = await mockApi('/discovery/candidates?status=ineligible&kind=standalone&limit=200') as { candidates: { cloud?: string }[] };
    expect(all.candidates.some((c) => c.cloud === 'gcp')).toBe(true);
    const discovery = await mockApi('/discovery') as { lastRun: { targets: { problems?: string[] }[] } };
    expect(discovery.lastRun.targets.flatMap((t) => t.problems ?? []).some((p) => p.startsWith('Cloud SQL instances not listed'))).toBe(true);
  });
});

describe('onboarding a Google Cloud resource with a custom metric (final review I4)', () => {
  it('sends the metric in Google Cloud\'s shape', async () => {
    setActivePinia(createPinia());
    const w = mount(OnboardDialog, { props: { modelValue: false, title: 'batch', defaultName: 'batch', resource: 'instance', cloud: 'gcp' }, attachTo: document.body, global: { plugins: plugins() } });
    await w.setProps({ modelValue: true });
    await flushPromises();
    (w.vm as unknown as { idle: { metricMode: string } }).idle.metricMode = 'metric';
    await flushPromises();
    const type = async (test: string, value: string) => {
      const el = document.querySelector(`[data-test="${test}"] input`) as HTMLInputElement;
      el.value = value;
      el.dispatchEvent(new Event('input'));
      await flushPromises();
    };
    await type('idle-metric-type', 'custom.googleapis.com/queue/depth');
    await type('idle-metric-below', '1');
    [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Onboard')!.click();
    await flushPromises();
    expect((w.emitted('submit')?.[0]?.[0] as { settings: Record<string, unknown> }).settings).toEqual({ idleMetric: { type: 'custom.googleapis.com/queue/depth', aligner: 'ALIGN_MAX', below: 1 } });
    w.unmount();
  });
});
