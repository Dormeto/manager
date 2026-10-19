import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import WorkloadView from '../src/views/WorkloadView.vue';
import IdleWindowCard from '../src/components/IdleWindowCard.vue';
import { useSession } from '../src/stores/session';
import { api } from '../src/api';
import StateBar from '../src/components/StateBar.vue';
import { barSavings } from '../src/costs';

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
// Awake for 35 minutes; the run last written 5 minutes ago (a nap request at the last idle check: no state change).
const status = {
  workloadId: '5cdfbf844b925bf8', name: 'ligoj-ui-prod', url: null, router: { version: '0.23.2', build: 'b' }, state: 'AWAKE',
  updatedAt: minutesAgo(5), awakeSince: minutesAgo(35), wakeStartedAt: minutesAgo(36), failedAt: null, wakeCount: 2, holders: 0, pendingWake: false,
  pauses: [], drift: [], lastRequestAt: minutesAgo(40), nap: { eligibleAt: minutesAgo(1), latestAt: minutesAgo(0), inSeconds: 0 }, route: 'app', rules: [], issues: [],
  backends: [], ignoredTargets: [], recommendations: [], targets: [], settings: { waitSeconds: 60, idleMinutes: 30, drainSeconds: 30, wakeTimeoutSeconds: 300, maxHolders: 100 },
  stats: null, ipLists: [], wakeMode: 'any', wakeRules: [], noWakeRules: [],
};
let current: Record<string, unknown> = status;
vi.mock('../src/api', () => ({ api: vi.fn(async () => structuredClone(current)) }));
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});

async function mountView(role: 'admin' | 'operator' | 'viewer' | 'member' = 'viewer') {
  setActivePinia(createPinia());
  useSession().role = role;
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/workloads/:router/:id', component: WorkloadView }] });
  await router.push('/workloads/dmtr-dev/5cdfbf844b925bf8');
  const wrapper = mount(WorkloadView, { props: { router: 'dmtr-dev', id: '5cdfbf844b925bf8' }, attachTo: document.body, global: { plugins: [createVuetify({ components, directives }), router] } });
  await flushPromises();
  return wrapper;
}
const ACTIONS = ['Pause', 'Resume', 'Exclude', 'Offboard', 'Nap', 'Wake'];

describe('Workload view', () => {
  it('gives each backend and target its id, ARN and service in a tooltip (user request)', async () => {
    current = {
      ...status, account: '111122223333', region: 'eu-west-3',
      backends: [{ kind: 'ecs', id: 'arn:aws:ecs:eu-west-3:111122223333:service/main/shop', status: 'running' }, { kind: 'rds-instance', id: 'shop-db', status: 'running', companion: true }],
      targets: [{ id: '10.0.1.12', state: 'healthy' }],
      costs: {
        baseline: { kind: 'always' }, from: '2026-09-09T12:00:00.000Z', to: '2026-10-09T12:00:00.000Z', napAt: '2026-10-09T04:51:00.000Z', savedShare: 0.9,
        items: [{ item: { kind: 'rds', class: 'db.t4g.micro', engine: 'postgres', multiAz: false }, hourly: 0.017 }], saved: { usd: 3.2, hours: 600, unpricedHours: 0 },
      },
    };
    const wrapper = await mountView();
    const tip = async (el: { trigger: (e: string) => Promise<void> }) => {
      await el.trigger('mouseenter');
      await flushPromises();
      await new Promise((r) => setTimeout(r, 300));
      return [...document.querySelectorAll('.v-tooltip .resource')].map((t) => t.textContent).join(' | ');
    };
    const [, database] = wrapper.findAll('[data-test="backend"]');
    expect(await tip(database!)).toMatch(/Idshop-db.*ARNarn:aws:rds:eu-west-3:111122223333:db:shop-db.*ServiceAmazon RDS.*Base cost\$0\.0170 an hour · \$12\.41 a month.*Savedabout \$11\.17 a month/);
    // R9.5: Spot at Spot prices; no discount set, none said.
    expect(document.body.textContent).toContain('Spot at Spot prices');
    expect(document.body.textContent).not.toContain('after discounts');
    expect(wrapper.find('[data-test="header"]').findComponent(StateBar).props('savings')).toEqual(barSavings(current.costs as never));
    expect(await tip(wrapper.find('[data-test="target"]'))).toMatch(/Id10\.0\.1\.12.*ARN—.*ServiceAmazon ECS task/);
    wrapper.unmount();
    current = status;
  });

  it('shows a Kubernetes backend: its owner, cluster, recorded replicas, KEDA and switch; its cluster\'s ARN, and the Kubernetes assumptions of its cost (R10.5)', async () => {
    current = {
      ...status, account: '111122223333', region: 'eu-west-1',
      backends: [{ kind: 'k8s', id: 'eks-demo/demo/Deployment/web', status: 'running', cluster: 'eks-demo', namespace: 'demo', owner: { kind: 'Deployment', name: 'web' }, replicas: 2, keda: true, switch: 'ingress' }],
      costs: {
        baseline: { kind: 'always' }, from: '2026-09-09T12:00:00.000Z', to: '2026-10-09T12:00:00.000Z', napAt: '2026-10-09T04:51:00.000Z', savedShare: 0.9, saved: { usd: 3.2, hours: 600, unpricedHours: 0 },
        items: [{ item: { kind: 'k8s-pods', count: 2, cpu: 0.25, memoryGb: 0.5, nodeType: 'm5.large', os: 'Linux', autoscaled: true, allocatable: { cpu: 1.93, memoryGb: 6.886 } }, hourly: 0.0277 }],
      },
    };
    const wrapper = await mountView();
    const row = wrapper.find('[data-test="backend"]');
    expect(row.text()).toContain('Deployment demo/web');
    expect(row.text()).toContain('Kubernetes workload · cluster eks-demo');
    expect(row.text()).toContain('2 replicas · KEDA · Dormeto\'s Ingress in the group');
    await row.trigger('mouseenter');
    await flushPromises();
    await new Promise((r) => setTimeout(r, 300));
    const tip = [...document.querySelectorAll('.v-tooltip')].map((t) => t.textContent).join(' | ');
    expect(tip).toContain('arn:aws:eks:eu-west-1:111122223333:cluster/eks-demo');
    expect(tip).toContain('Amazon EKS');
    expect(tip).toContain('the pods\' share of their nodes, where an autoscaler removes the nodes they free; the EKS control plane and the nodes\' DaemonSets keep running');
    wrapper.unmount();
    current = status;
  });

  // At a phone's width the details beside the state crushed the owner's name and clipped the state chip (read on dev).
  it('a backend\'s details go in its subtitle, wrapped, its state alone on its right', async () => {
    current = {
      ...status, account: '111122223333', region: 'eu-west-1',
      backends: [
        { kind: 'k8s', id: 'eks-demo/demo/Deployment/web', status: 'stopped', cluster: 'eks-demo', namespace: 'demo', owner: { kind: 'Deployment', name: 'web' }, replicas: 1, keda: false, switch: 'ingress' },
        { kind: 'asg', id: 'shop-asg', status: 'running', min: 0, desired: 1, max: 2 },
      ],
    };
    const wrapper = await mountView();
    const [k8s, asg] = wrapper.findAll('[data-test="backend"]');
    expect(k8s!.find('.v-list-item-subtitle').text()).toBe('Kubernetes workload · cluster eks-demo · 1 replica · Dormeto\'s Ingress in the group');
    expect(k8s!.find('.v-list-item-subtitle').classes()).toContain('text-wrap');
    expect(k8s!.find('.v-list-item__append').text()).toBe('stopped');
    expect(asg!.find('.v-list-item-subtitle').text()).toBe('Auto Scaling group · min 0 · desired 1 · max 2');
    expect(asg!.find('.v-list-item__append').text()).toBe('running');
    wrapper.unmount();
    current = status;
  });

  it('groups its actions in one menu on the right of its header: wake, nap, pause, rename, exclude, offboard (user request)', async () => {
    current = { ...status, source: 'manager', targetGroupArn: 'arn:aws:elasticloadbalancing:eu-west-3:111122223333:targetgroup/shop/0123456789abcdef' };
    const wrapper = await mountView('operator');
    const header = wrapper.find('[data-test="header"]');
    expect(header.findAll('button').map((b) => b.text()).filter((t) => ACTIONS.includes(t))).toEqual([]);
    expect(header.find('button[aria-label="Rename"]').exists()).toBe(false);
    await header.find('[data-test="actions"]').trigger('click');
    await flushPromises();
    const items = [...document.querySelectorAll<HTMLElement>('[data-test="action"]')];
    expect(items.map((i) => [i.textContent?.trim(), i.classList.contains('v-list-item--disabled')])).toEqual([
      ['Wake', true], ['Nap', false], ['Pause', false], ['Rename', false], ['Exclude', false], ['Offboard', false],
    ]);
    items[1]!.click();
    await flushPromises();
    expect(document.body.textContent).toContain('Nap ligoj-ui-prod?');
    wrapper.unmount();
    current = status;
  });

  it('offers no action to viewers, and only what a workload written in Terraform allows', async () => {
    const viewer = await mountView();
    expect(viewer.find('[data-test="actions"]').exists()).toBe(false);
    viewer.unmount();
    current = { ...status, state: 'ASLEEP', source: 'terraform' };
    const operator = await mountView('operator');
    await operator.find('[data-test="actions"]').trigger('click');
    await flushPromises();
    expect([...document.querySelectorAll('[data-test="action"]')].map((i) => i.textContent?.trim())).toEqual(['Wake', 'Nap', 'Pause']);
    operator.unmount();
    current = status;
  });

  it('shows in its header its time in each state over 7 days, the bar of its Workloads row (user request)', async () => {
    const states7d = { from: '2026-10-02T12:00:00.000Z', to: '2026-10-09T12:00:00.000Z', totals: { ASLEEP: 500_000, AWAKE: 104_800 } };
    current = { ...status, states7d, idleHours7d: 150, requests7d: 12 };
    const wrapper = await mountView();
    const bar = wrapper.find('[data-test="header"]').findComponent(StateBar);
    expect(bar.props()).toMatchObject({ states: states7d, idleHours7d: 150, requests7d: 12 });
    wrapper.unmount();
    current = status;
  });

  it('shows its Idle window card after its history (R10)', async () => {
    const wrapper = await mountView();
    const card = wrapper.findComponent(IdleWindowCard);
    expect(card.exists()).toBe(true);
    expect(card.props()).toEqual({ router: 'dmtr-dev', id: '5cdfbf844b925bf8' });
    wrapper.unmount();
  });

  it('says why the last wake failed, how many times in a row, and when a request retries it (R7b)', async () => {
    current = {
      ...status, state: 'FAILED', failedAt: minutesAgo(2), consecutiveFailures: 3, nextAttemptAt: new Date(Date.now() + 4 * 60_000).toISOString(), fallbacks: [],
      failure: { kind: 'capacity', step: 'wake', backend: 'rds-instance:shop-db', message: 'no capacity for db.t4g.micro in eu-west-3a', at: minutesAgo(2) },
    };
    const wrapper = await mountView();
    const alert = wrapper.find('[data-test="failure"]');
    expect(alert.text()).toContain('Last wake failed: no capacity');
    expect(alert.text()).toContain('no capacity for db.t4g.micro in eu-west-3a');
    expect(alert.text()).toContain('shop-db');
    expect(alert.text()).toContain('3 failures in a row');
    expect(alert.text()).toContain('next attempt in 4 min');
    wrapper.unmount();
    current = status;
  });

  it('says which instances run on a fallback instance type, until the next nap (R7b)', async () => {
    current = { ...status, fallbacks: [{ instance: 'i-0123456789abcdef0', from: 't3.medium', to: 't3a.medium' }] };
    const wrapper = await mountView();
    expect(wrapper.find('[data-test="failure"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="fallbacks"]').text()).toMatch(/i-0123456789abcdef0 on t3a\.medium instead of t3\.medium.*next nap/);
    wrapper.unmount();
    current = status;
  });


  it('says in its costs area the energy its naps did not use and its carbon, as the API estimates it with Cloud Carbon Footprint\'s coefficients', async () => {
    // The API's estimate with the workload's figures (energy.ts there): the view computes nothing.
    current = {
      ...status, account: '111122223333', region: 'eu-west-3',
      backends: [{ kind: 'rds-instance', id: 'shop-db', status: 'stopped', companion: true }],
      costs: {
        baseline: { kind: 'always' }, from: '2026-09-09T12:00:00.000Z', to: '2026-10-09T12:00:00.000Z', napAt: '2026-10-09T04:51:00.000Z', savedShare: 0.9,
        items: [{ item: { kind: 'rds', class: 'db.t4g.micro', engine: 'postgres', multiAz: false }, hourly: 0.017 }], saved: { usd: 3.2, hours: 600, unpricedHours: 0 },
      },
      energy: { kwh: 4.14, co2Kg: 0.211, estimated: 1 },
    };
    const wrapper = await mountView();
    const energy = wrapper.find('[data-test="energy"]');
    expect(energy.text()).toContain('Energy not used (estimate)');
    expect(energy.text()).toMatch(/4\.1\s*kWh/);
    expect(energy.text()).toMatch(/0\.21\s*kg CO₂e/);
    expect(energy.text()).toContain('Cloud Carbon Footprint\'s coefficients for AWS; not a measure');
    wrapper.unmount();
    // Without an estimate (no priced nap yet, or nothing of a known size stopped), no energy is said.
    for (const without of [status, { ...current, energy: { kwh: 0, co2Kg: 0, estimated: 0 } }]) {
      current = without;
      const plain = await mountView();
      expect(plain.find('[data-test="energy"]').exists()).toBe(false);
      plain.unmount();
    }
    current = status;
  });

  it('dates the state from when it began, not from the last write of the workload', async () => {
    setActivePinia(createPinia());
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/workloads/:router/:id', component: WorkloadView }] });
    await router.push('/workloads/dmtr-dev/5cdfbf844b925bf8');
    const wrapper = mount(WorkloadView, { props: { router: 'dmtr-dev', id: '5cdfbf844b925bf8' }, global: { plugins: [createVuetify({ components, directives }), router] } });
    await flushPromises();
    const rows = Object.fromEntries(wrapper.findAll('tr').map((tr) => [tr.find('th').text(), tr.find('td').text()]));
    expect(rows['Awake since']).toBe('35 min ago');
    expect(rows['Last state change']).toBeUndefined();
    wrapper.unmount();
  });

  // R11: tags, and the actions the caller's grants allow.
  const openActions = async (wrapper: Awaited<ReturnType<typeof mountView>>) => {
    await wrapper.find('[data-test="actions"]').trigger('click');
    await flushPromises();
    return [...document.querySelectorAll('[data-test="action"]')].map((i) => i.textContent?.trim());
  };

  it('offers a member only what `can` allows: a wake grant gives Wake, no Nap, Pause or Resume (R11)', async () => {
    current = { ...status, state: 'ASLEEP', tags: { team: 'payments' }, can: { wake: true, nap: false } };
    const member = await mountView('member');
    expect(await openActions(member)).toEqual(['Wake']);
    member.unmount();
    current = { ...status, tags: { team: 'payments' }, can: { wake: false, nap: true } };
    const napper = await mountView('member');
    expect(await openActions(napper)).toEqual(['Nap', 'Pause']);
    napper.unmount();
    current = { ...status, tags: { team: 'payments' }, can: { wake: false, nap: false } };
    const reader = await mountView('member');
    expect(reader.find('[data-test="actions"]').exists()).toBe(false);
    reader.unmount();
    current = status;
  });

  it('hides Wake from an operator whose payload says they cannot, and keeps the built-in menu without `can` (older API)', async () => {
    current = { ...status, state: 'ASLEEP', source: 'terraform', can: { wake: false, nap: true } };
    const wrapper = await mountView('operator');
    expect(await openActions(wrapper)).toEqual(['Nap', 'Pause']);
    wrapper.unmount();
    current = status;
  });

  it('pauses without waking where the caller cannot wake: "leave it asleep" is forced', async () => {
    current = { ...status, tags: {}, can: { wake: false, nap: true } };
    const wrapper = await mountView('member');
    await openActions(wrapper);
    ([...document.querySelectorAll('[data-test="action"]')].find((i) => i.textContent?.trim() === 'Pause') as HTMLElement).click();
    await flushPromises();
    const box = document.querySelector<HTMLInputElement>('.v-dialog input[type="checkbox"]')!;
    expect([box.checked, box.disabled]).toEqual([true, true]);
    expect(document.body.textContent).toContain('needs the wake permission');
    wrapper.unmount();
    current = status;
  });

  it('shows its tags as chips', async () => {
    current = { ...status, source: 'manager', tags: { team: 'payments', env: 'staging' } };
    const wrapper = await mountView('viewer');
    expect(wrapper.findAll('[data-test="tag"]').map((t) => t.text())).toEqual(['env=staging', 'team=payments']);
    expect(wrapper.find('[data-test="edit-tags"]').exists()).toBe(false);
    wrapper.unmount();
    current = status;
  });

  it('shows its Schedule card after its history, with the schedule and next events from the API (R12)', async () => {
    current = { ...status, can: { wake: true, nap: true }, schedule: { timeZone: 'Europe/Paris', windows: [{ kind: 'awake', days: ['mon', 'tue'], start: '08:00', end: '19:00' }] }, next: [{ at: '2026-10-20T06:00:00.000Z', kind: 'awake-start', window: 0 }], maintenanceDue: null };
    const wrapper = await mountView('operator');
    expect(wrapper.find('[data-test="schedule-card"]').text()).toContain('Mon, Tue');
    expect(wrapper.find('[data-test="edit-schedule"]').exists()).toBe(true);
    wrapper.unmount();
    current = { ...status, can: { wake: true, nap: false }, schedule: null, next: [], maintenanceDue: null };
    const member = await mountView('member');
    expect(member.find('[data-test="edit-schedule"]').exists()).toBe(false);
    member.unmount();
    current = status;
  });

  it('puts the schedule, keeps the dialog open with the 400 text, then closes on success (R12)', async () => {
    current = { ...status, can: { wake: true, nap: true }, schedule: null, next: [], maintenanceDue: null };
    const calls: [string, RequestInit | undefined][] = [];
    let fail = true;
    vi.mocked(api).mockImplementation((async (path: string, init?: RequestInit) => {
      calls.push([path, init]);
      if (init?.method === 'PUT') {
        if (fail) throw new Error('windows[0].end: overlaps windows[1]');
        return { schedule: {}, next: [], maintenanceDue: null };
      }
      return structuredClone(current);
    }) as never);
    const wrapper = await mountView('operator');
    await wrapper.find('[data-test="edit-schedule"]').trigger('click');
    await flushPromises();
    const dialog = () => document.querySelector('.v-dialog')!;
    const click = (label: string) => ([...dialog().querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLElement).click();
    click('Add awake window');
    await flushPromises();
    click('Save');
    await flushPromises();
    const put = calls.find(([, init]) => init?.method === 'PUT')!;
    expect(put[0]).toBe('/workloads/dmtr-dev/5cdfbf844b925bf8/schedule');
    expect(JSON.parse(put[1]!.body as string).windows).toEqual([{ kind: 'awake', days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '08:00', end: '19:00' }]);
    expect(dialog().textContent).toContain('windows[0].end: overlaps windows[1]');
    fail = false;
    click('Save');
    await flushPromises();
    expect(wrapper.text()).toContain('Schedule saved');
    wrapper.unmount();
    current = status;
  });

  it('lets an administrator edit the tags of a manager workload, sending the rows as an object', async () => {
    current = { ...status, source: 'manager', tags: { team: 'payments' } };
    const calls: [string, RequestInit | undefined][] = [];
    vi.mocked(api).mockImplementation((async (path: string, init?: RequestInit) => { calls.push([path, init]); return structuredClone(current); }) as never);
    const wrapper = await mountView('admin');
    await wrapper.find('[data-test="edit-tags"]').trigger('click');
    await flushPromises();
    const dialog = () => document.querySelector('.v-dialog')!;
    expect([...dialog().querySelectorAll<HTMLInputElement>('input')].map((i) => i.value)).toEqual(['team', 'payments']);
    (dialog().querySelector('[data-test="add-tag"]') as HTMLElement).click();
    await flushPromises();
    const inputs = [...dialog().querySelectorAll<HTMLInputElement>('input')];
    inputs[2]!.value = 'env';
    inputs[2]!.dispatchEvent(new Event('input'));
    await flushPromises();
    inputs[3]!.value = 'staging';
    inputs[3]!.dispatchEvent(new Event('input'));
    await flushPromises();
    ([...dialog().querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save') as HTMLElement).click();
    await flushPromises();
    const put = calls.find(([, init]) => init?.method === 'PUT')!;
    expect(put[0]).toBe('/workloads/dmtr-dev/5cdfbf844b925bf8/tags');
    expect(JSON.parse(put[1]!.body as string)).toEqual({ tags: { team: 'payments', env: 'staging' } });
    wrapper.unmount();
    current = status;
  });

  it('refuses tags the rules refuse before sending them, with the router\'s words', async () => {
    current = { ...status, source: 'manager', tags: { team: 'payments' } };
    const wrapper = await mountView('admin');
    await wrapper.find('[data-test="edit-tags"]').trigger('click');
    await flushPromises();
    const key = document.querySelector<HTMLInputElement>('.v-dialog input')!;
    key.value = 'Dormeto:x';
    key.dispatchEvent(new Event('input'));
    await flushPromises();
    expect(document.querySelector('.v-dialog')!.textContent).toContain('the dormeto: prefix is reserved');
    expect(([...document.querySelectorAll('.v-dialog button')].find((b) => b.textContent?.trim() === 'Save') as HTMLButtonElement).disabled).toBe(true);
    wrapper.unmount();
    current = status;
  });

  it('says the tags are unknown, with no edit button, when the router reports none (before 0.30.0), even for an administrator', async () => {
    current = { ...status, source: 'manager' };
    const wrapper = await mountView('admin');
    expect(wrapper.find('[data-test="tags"]').text()).toContain('Tags unknown (router before 0.30.0)');
    expect(wrapper.find('[data-test="edit-tags"]').exists()).toBe(false);
    wrapper.unmount();
    current = status;
  });

  it('offers Edit tags to an administrator on a manager workload only, not on one that is neither manager nor Terraform', async () => {
    current = { ...status, tags: { team: 'payments' } };
    const wrapper = await mountView('admin');
    expect(wrapper.find('[data-test="edit-tags"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="tags-terraform"]').exists()).toBe(false);
    wrapper.unmount();
    current = { ...status, source: 'manager', tags: { team: 'payments' } };
    const manager = await mountView('admin');
    expect(manager.find('[data-test="edit-tags"]').exists()).toBe(true);
    manager.unmount();
    current = status;
  });

  it('shows a member the router and the pause links as plain text, an administrator as links', async () => {
    current = { ...status, tags: { team: 'payments' }, can: { wake: false, nap: false }, pauses: [{ scope: 'router', by: 'ops', at: minutesAgo(5), reason: 'maintenance' }, { scope: 'workload', exclusionId: 'ex-1', by: 'ops', at: minutesAgo(5), reason: 'excluded: shared' }] };
    const member = await mountView('member');
    expect(member.find('.dm-hero__router').element.tagName).toBe('SPAN');
    expect(member.find('.dm-hero__router').text()).toBe('dmtr-dev');
    expect(member.text()).not.toContain('Resume the router');
    expect(member.text()).not.toContain('Lift the exclusion in Discovery');
    member.unmount();
    const admin = await mountView('admin');
    expect(admin.find('a.dm-hero__router').attributes('href')).toBe('/routers/dmtr-dev');
    expect(admin.text()).toContain('Resume the router');
    expect(admin.text()).toContain('Lift the exclusion in Discovery');
    admin.unmount();
    current = status;
  });

  it('says a Terraform workload\'s tags are set in Terraform, with no edit button, even for an administrator', async () => {
    current = { ...status, source: 'terraform', tags: { team: 'payments' } };
    const wrapper = await mountView('admin');
    expect(wrapper.find('[data-test="edit-tags"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="tags-terraform"]').text()).toContain('set in Terraform');
    wrapper.unmount();
    current = status;
  });
});
