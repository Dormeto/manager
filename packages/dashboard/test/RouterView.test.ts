// A router's own view (user request): its version, health, workloads, configuration with where each setting is changed,
// and its actions, reached from the Routers list as a workload is from Workloads.
import { nextTick } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import RouterView from '../src/views/RouterView.vue';
import DescriptionCard from '../src/components/DescriptionCard.vue';
import { useSession } from '../src/stores/session';

const INSTALLED = {
  name: 'dmtr-dev-eu-west-3', region: 'eu-west-3', account: '111122223333', source: 'manager', version: '0.25.0', build: 'b1', workloads: 2, workloadStates: { AWAKE: 1, ASLEEP: 1 },
  health: { status: 'warning', problems: [{ level: 'warning', text: 'controller: 2 errors in 24 hours' }] }, pauses: [], lastScheduledCheckAt: new Date().toISOString(),
};
const DETAILS = {
  health: { checkSchedule: 'rate(5 minutes)', lastScheduledCheckAt: null, lambda: { controller: { errors: 2, throttles: 0 } }, queues: { check: 0, controller: 0 }, concurrency: null, ipLists: [] },
  configuration: { checkSchedule: { value: 'rate(5 minutes)', source: 'manager' }, metrics: { value: false, source: 'manager' }, ipLists: { value: [], source: 'manager' }, noWakeRules: { value: [], source: 'manager' } },
};
// Routers 0.32.0 and later: the router's own hibernate setting and the manager's settings as it last read them.
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const HIBERNATION: { settings: { hibernate: boolean | null; by: string | null; at: string | null }; managerSettings: Record<string, unknown> } = {
  settings: { hibernate: null, by: null, at: null },
  managerSettings: { url: 's3://b/settings.json', hibernate: true, readAt: minutesAgo(3), error: null },
};
const calls: { path: string; init?: RequestInit }[] = [];
let withHibernation = true;
let failSave = false;
// The description the manager answers with (undefined: none readable, the key absent) and the refusal of its PUT.
let described: { text: string; by: string; at: string } | null | undefined;
let descriptionRefusal = '';
const TERRAFORM_DETAILS = {
  ...DETAILS,
  settings: { hibernate: null, by: null, at: null }, managerSettings: { url: null, hibernate: null, readAt: null, error: null },
  configuration: { checkSchedule: { value: 'rate(5 minutes)', source: 'terraform' }, metrics: { value: true, source: 'terraform' }, ipLists: { value: [], source: 'terraform' },
    ipListsCatalog: { value: { lists: [] }, source: 'manager' }, noWakeRules: { value: [], source: 'terraform' } },
};
vi.mock('../src/api', () => ({
  api: vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    if (path.endsWith('/description')) {
      if (descriptionRefusal) throw new Error(descriptionRefusal);
      return { description: init?.method === 'DELETE' ? null : described };
    }
    if (init?.method === 'PUT') {
      if (failSave) throw new Error('upgrade the router to 0.32.0');
      return {};
    }
    if (path === '/routers') return { available: { version: '0.26.0' }, routers: [INSTALLED, { ...INSTALLED, name: 'dmt-dev', source: 'terraform', region: 'eu-west-1' }] };
    if (path === '/routers/dmt-dev') return TERRAFORM_DETAILS;
    if (path.startsWith('/routers/')) return { ...DETAILS, ...(withHibernation ? HIBERNATION : {}), ...(described === undefined ? {} : { description: described }), clusters: [
      { name: 'eks-demo', reachable: true, allowed: true, missing: [], checkedAt: new Date(Date.now() - 3_600_000).toISOString() },
      { name: 'eks-legacy', reachable: true, allowed: false, missing: ['get nodes'], checkedAt: new Date(Date.now() - 3_600_000).toISOString() },
      { name: 'eks-lab', reachable: false, allowed: false, missing: [], reason: 'GET /apis: no connection within 3000 ms', checkedAt: new Date(Date.now() - 3_600_000).toISOString() },
    ] };
    if (path === '/alerts') return { alarms: [{ id: 'router#111122223333#eu-west-3', kind: 'router', name: 'dmtr-dev-eu-west-3', level: 'warning', since: new Date(Date.now() - 600_000).toISOString(), problems: [] }], notifications: null };
    return {};
  }),
}));
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});

async function mountView(name: string, role: 'admin' | 'viewer' = 'admin') {
  const pinia = createPinia();
  setActivePinia(pinia);
  useSession().role = role;
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/routers', component: { render: () => null } }, { path: '/routers/:name', component: RouterView, props: true },
    { path: '/workloads', component: { render: () => null } }, { path: '/workloads/:router/:id', component: { render: () => null } }, { path: '/operations', component: { render: () => null } }] });
  await router.push(`/routers/${name}`);
  const wrapper = mount(RouterView, { props: { name }, attachTo: document.body, global: { plugins: [createVuetify({ components, directives }), pinia, router] } });
  await flushPromises();
  return wrapper;
}
const chips = (wrapper: Awaited<ReturnType<typeof mountView>>) => wrapper.findAll('.v-chip').map((c) => c.text());

describe('Router view', () => {
  it('shows a router: version and upgrade, health with its alert, workloads by state, and its account and region', async () => {
    const wrapper = await mountView('dmtr-dev-eu-west-3');
    const text = wrapper.text();
    expect(wrapper.find('h1').text()).toBe('dmtr-dev-eu-west-3');
    expect(text).toContain('0.25.0');
    expect(wrapper.find('[aria-label="Upgrade dmtr-dev-eu-west-3 to 0.26.0"]').exists()).toBe(true);
    expect(text).toContain('controller: 2 errors in 24 hours');
    expect(text).toMatch(/alert since 10 min ago/);
    expect(text).toContain('1 awake');
    expect(text).toContain('111122223333');
    wrapper.unmount();
  });

  it('says where its configuration is changed: by the manager for one it installed, in its Terraform otherwise', async () => {
    const installed = await mountView('dmtr-dev-eu-west-3');
    expect(installed.text()).toMatch(/Set by the manager when it installs or upgrades the router/);
    installed.unmount();
    const terraform = await mountView('dmt-dev');
    expect(terraform.text()).toMatch(/Set in this router's Terraform/);
    terraform.unmount();
  });

  it('shows the Terraform deployment mode, explained in a tooltip, and says nothing of the manager\'s, the standard way', async () => {
    const installed = await mountView('dmtr-dev-eu-west-3');
    expect(installed.text()).not.toContain('installed by the manager');
    expect(chips(installed)).not.toContain('Terraform');
    expect(chips(installed)).not.toContain('manager');
    installed.unmount();
    const terraform = await mountView('dmt-dev');
    // The router's own chip, and one per setting set in its Terraform; none for the manager's IP lists.
    expect(chips(terraform).filter((c) => c === 'Terraform')).toHaveLength(5);
    expect(chips(terraform)).not.toContain('manager');
    const [header, setting] = terraform.findAll('.v-chip').filter((c) => c.text() === 'Terraform');
    await header!.trigger('mouseenter');
    await nextTick();
    await new Promise((r) => setTimeout(r, 300));
    expect(document.body.textContent).toMatch(/dmt-dev is written in Terraform: change its settings, upgrade or uninstall it there/);
    await setting!.trigger('mouseenter');
    await nextTick();
    await new Promise((r) => setTimeout(r, 300));
    expect(document.body.textContent).toMatch(/Set in this router's Terraform: change it there and apply/);
    terraform.unmount();
  });

  it('offers pause to operators, and upgrade and uninstall to administrators of a router the manager installed', async () => {
    const admin = await mountView('dmtr-dev-eu-west-3');
    const labels = admin.findAll('button').map((b) => b.text() || b.attributes('aria-label'));
    expect(labels).toEqual(expect.arrayContaining(['Pause', 'Uninstall dmtr-dev-eu-west-3']));
    admin.unmount();
    const viewer = await mountView('dmtr-dev-eu-west-3', 'viewer');
    expect(viewer.findAll('button').map((b) => b.text())).not.toContain('Pause');
    viewer.unmount();
  });

  it('lists the EKS clusters of its account and region with its reach and rights, and what to apply when some are missing (R10.5)', async () => {
    const wrapper = await mountView('dmtr-dev-eu-west-3');
    await flushPromises();
    const text = wrapper.find('[data-test="clusters"]').findAll('tr').map((r) => `${r.find('th').text()} ${r.find('td').text()}`.replace(/\s+/g, ' ')).join(' | ');
    expect(text).toContain('eks-demo reachable, every right checked 1 h ago');
    expect(text).toContain('eks-legacy missing get nodes: apply dormeto-kubernetes-<version>.yaml of the release (the ClusterRole and its binding to the group dormeto:router): https://dormeto.com/organization-access.html#kubernetes');
    expect(text).toContain('eks-lab unreachable: GET /apis: no connection within 3000 ms');
    wrapper.unmount();
  });

  it('says so for a router the manager does not know', async () => {
    const wrapper = await mountView('nope');
    expect(wrapper.text()).toContain('Unknown router: nope');
    wrapper.unmount();
  });

  describe('the Hibernate row (EC2 hibernation)', () => {
    const row = (wrapper: Awaited<ReturnType<typeof mountView>>) => wrapper.find('[data-test="hibernate"]');
    const dialogButton = (text: string) => [...document.querySelectorAll('.v-dialog button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;

    it("shows Inherit with the manager's value as the router last read it, and when", async () => {
      withHibernation = true;
      const wrapper = await mountView('dmtr-dev-eu-west-3');
      expect(row(wrapper).text()).toContain('Hibernate');
      expect(row(wrapper).text()).toContain('Inherit');
      expect(row(wrapper).text()).toContain('manager: On, read 3 min ago');
      wrapper.unmount();
    });

    it("says the manager's value is unknown while the router has read none, and when its last read failed", async () => {
      const old = HIBERNATION.managerSettings;
      HIBERNATION.managerSettings = { url: 's3://b/settings.json', hibernate: null, readAt: null, error: null };
      const fresh = await mountView('dmtr-dev-eu-west-3');
      expect(row(fresh).text()).toContain('Inherit (manager: unknown (not read yet): naps stop)');
      fresh.unmount();
      HIBERNATION.managerSettings = { url: 's3://b/settings.json', hibernate: false, readAt: minutesAgo(3), error: 'AccessDenied' };
      const failed = await mountView('dmtr-dev-eu-west-3');
      expect(row(failed).text()).toContain('manager: Off (last read failed 3 min ago: AccessDenied)');
      failed.unmount();
      HIBERNATION.managerSettings = old;
    });

    it('keeps "not editable from the dashboard yet" for the settings the manager sets, not above the editable Hibernate', async () => {
      const wrapper = await mountView('dmtr-dev-eu-west-3');
      const note = wrapper.find('.dm-wide .dm-detail__note').text();
      expect(note).not.toContain('Not editable from the dashboard yet.');
      expect(note).toContain('not editable from the dashboard yet: an idle check every 5 minutes');
      wrapper.unmount();
    });

    it('says built-in default for a router that reads no manager settings', async () => {
      const wrapper = await mountView('dmt-dev');
      expect(row(wrapper).text()).toContain('Inherit');
      expect(row(wrapper).text()).toContain('built-in default: On');
      wrapper.unmount();
    });

    it('shows nothing for a router before 0.32.0', async () => {
      withHibernation = false;
      const wrapper = await mountView('dmtr-dev-eu-west-3');
      expect(row(wrapper).exists()).toBe(false);
      wrapper.unmount();
      withHibernation = true;
    });

    it('shows an explicit value with who set it', async () => {
      const old = HIBERNATION.settings;
      HIBERNATION.settings = { hibernate: false, by: 'ops@example.com', at: minutesAgo(90) };
      const wrapper = await mountView('dmtr-dev-eu-west-3');
      expect(row(wrapper).text()).toContain('Off');
      expect(row(wrapper).text()).toContain('ops@example.com');
      wrapper.unmount();
      HIBERNATION.settings = old;
    });

    it('lets an administrator change it, Off sending {hibernate: false}; a viewer has no Edit', async () => {
      const admin = await mountView('dmtr-dev-eu-west-3');
      calls.length = 0;
      await row(admin).find('[data-test="edit-hibernate"]').trigger('click');
      await flushPromises();
      const off = document.querySelector('.v-dialog input[type="radio"][value="off"]') as HTMLInputElement;
      off.click();
      await flushPromises();
      dialogButton('Save').click();
      await flushPromises();
      const put = calls.find((c) => c.init?.method === 'PUT')!;
      expect(put.path).toBe('/routers/dmtr-dev-eu-west-3/settings');
      expect(JSON.parse(String(put.init!.body))).toEqual({ hibernate: false });
      admin.unmount();
      document.body.innerHTML = '';
      const viewer = await mountView('dmtr-dev-eu-west-3', 'viewer');
      expect(row(viewer).exists()).toBe(true);
      expect(row(viewer).find('[data-test="edit-hibernate"]').exists()).toBe(false);
      viewer.unmount();
    });

    it('closes the dialog on a refusal and shows the API message in the row', async () => {
      failSave = true;
      const admin = await mountView('dmtr-dev-eu-west-3');
      await row(admin).find('[data-test="edit-hibernate"]').trigger('click');
      await flushPromises();
      dialogButton('Save').click();
      await flushPromises();
      expect(document.querySelector('.v-overlay--active')).toBeNull();
      expect(row(admin).text()).toContain('upgrade the router to 0.32.0');
      admin.unmount();
      failSave = false;
    });
  });

  describe('the Description card', () => {
    const DESCRIPTION = { text: '# Dev\n\nfirst\nsecond\n\n- one\n- [wiki](https://wiki.example.com)', by: 'fab@example.com', at: minutesAgo(120) };
    const card = (w: Awaited<ReturnType<typeof mountView>>) => w.find('[data-test="description-card"]');
    const dialogButton = (text: string) => [...document.querySelectorAll('.v-dialog button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
    const isOpen = (w: Awaited<ReturnType<typeof mountView>>) => w.findComponent(DescriptionCard).findComponent({ name: 'VDialog' }).props('modelValue');
    const writes = () => calls.filter((c) => c.path.endsWith('/description'));
    // Earlier tests leave their dialogs in the document: start from an empty one.
    beforeEach(() => { document.body.innerHTML = ''; });
    const reset = () => { described = undefined; descriptionRefusal = ''; calls.length = 0; document.body.innerHTML = ''; };

    it('draws the text with who wrote it and when, under the header', async () => {
      described = DESCRIPTION;
      const w = await mountView('dmtr-dev-eu-west-3', 'viewer');
      expect(card(w).find('h4').text()).toBe('Dev');
      expect(card(w).findAll('li').map((l) => l.text())).toEqual(['one', 'wiki']);
      expect(card(w).find('a').attributes('rel')).toBe('noopener');
      expect(card(w).find('[data-test="description-by"]').text()).toBe('— fab@example.com, 2 h ago');
      expect(card(w).find('[data-test="edit-description"]').exists()).toBe(false);
      w.unmount();
      reset();
    });

    it('says "No description", with "Add a description" for an administrator only', async () => {
      described = null;
      const admin = await mountView('dmtr-dev-eu-west-3');
      expect(card(admin).text()).toContain('No description');
      expect(card(admin).get('[data-test="edit-description"]').text()).toBe('Add a description');
      admin.unmount();
      const viewer = await mountView('dmtr-dev-eu-west-3', 'viewer');
      expect(card(viewer).text()).toContain('No description');
      expect(card(viewer).find('[data-test="edit-description"]').exists()).toBe(false);
      viewer.unmount();
      reset();
    });

    it('shows nothing when the manager did not answer a description (a store error, or before 0.19.0)', async () => {
      described = undefined;
      const w = await mountView('dmtr-dev-eu-west-3');
      expect(card(w).exists()).toBe(false);
      expect(w.text()).not.toContain('Add a description');
      expect(w.text()).not.toContain('No description');
      w.unmount();
      reset();
    });

    it('PUTs the text, and keeps the dialog open with the message on a refusal', async () => {
      described = null;
      const w = await mountView('dmtr-dev-eu-west-3');
      await card(w).get('[data-test="edit-description"]').trigger('click');
      await flushPromises();
      const area = document.querySelector('[data-test="description-text"] textarea') as HTMLTextAreaElement;
      area.value = 'The dev router';
      area.dispatchEvent(new Event('input'));
      await nextTick();
      descriptionRefusal = 'text must not contain control characters other than line feed and tab';
      dialogButton('Save').click();
      await flushPromises();
      expect(writes()).toHaveLength(1);
      expect(writes()[0]).toMatchObject({ path: '/routers/dmtr-dev-eu-west-3/description', init: { method: 'PUT' } });
      expect(JSON.parse(String(writes()[0]!.init!.body))).toEqual({ text: 'The dev router' });
      await vi.waitFor(() => expect(document.querySelector('[data-test="description-error"]')?.textContent).toContain('control characters'));
      expect(isOpen(w)).toBe(true);
      descriptionRefusal = '';
      described = { text: 'The dev router', by: 'fab@example.com', at: minutesAgo(0) };
      dialogButton('Save').click();
      await flushPromises();
      expect(isOpen(w)).toBe(false);
      expect(card(w).text()).toContain('The dev router');
      w.unmount();
      reset();
    });

    it('Clear sends DELETE', async () => {
      described = DESCRIPTION;
      const w = await mountView('dmtr-dev-eu-west-3');
      await card(w).get('[data-test="edit-description"]').trigger('click');
      await flushPromises();
      described = null;
      dialogButton('Clear').click();
      await flushPromises();
      expect(writes()).toHaveLength(1);
      expect(writes()[0]).toMatchObject({ path: '/routers/dmtr-dev-eu-west-3/description', init: { method: 'DELETE' } });
      expect(card(w).text()).toContain('No description');
      w.unmount();
      reset();
    });
  });
});
