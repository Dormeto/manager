import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import GroupsView from '../src/views/GroupsView.vue';
import { useSession } from '../src/stores/session';
import { download } from '../src/table-export';
import { expectEveryColumnSaid } from './table-columns';

// R11's custom groups, in a view of their own (the user, 2026-11-15: "move group management out of the user management.
// Groups must be displayed in a table").
const calls: [string, string][] = [];
const bodies: Record<string, unknown> = {};
const answer = { groups: true, users: true };
const GROUPS = [
  { name: 'payments', description: 'The payments team', grants: [{ tags: { team: 'payments' }, permissions: ['read', 'wake', 'nap'] }, { tags: {}, permissions: ['read'] }], updatedAt: '2026-10-18T10:00:00.000Z', updatedBy: 'admin@example.com' },
  { name: 'auditors', description: '', grants: [], updatedAt: null, updatedBy: null },
];
vi.mock('../src/api', () => ({
  api: vi.fn(async (path: string, init?: RequestInit) => {
    calls.push([init?.method ?? 'GET', path]);
    if (init?.body) bodies[`${init.method} ${path}`] = JSON.parse(init.body as string);
    if (path === '/groups' && !init?.method) return { groups: answer.groups ? GROUPS : [] };
    if (path === '/users') {
      if (!answer.users) throw new Error('users throttled');
      return { users: [
        { email: 'admin@example.com', role: 'admin', status: 'CONFIRMED', enabled: true, createdAt: null, mfa: true },
        { email: 'dev@example.com', role: 'member', status: 'CONFIRMED', enabled: true, createdAt: null, mfa: true, groups: ['payments'] },
        { email: 'pay@example.com', role: 'member', status: 'CONFIRMED', enabled: true, createdAt: null, mfa: true, groups: ['payments'] },
      ] };
    }
    return {};
  }),
}));
vi.mock('../src/table-export', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/table-export')>()), download: vi.fn() }));
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});
afterEach(() => {
  answer.groups = true;
  answer.users = true;
  document.body.innerHTML = '';
});

let router: ReturnType<typeof createRouter>;
async function mountGroups(path = '/groups') {
  const pinia = createPinia();
  setActivePinia(pinia);
  useSession().email = 'admin@example.com';
  for (const k of Object.keys(bodies)) delete bodies[k];
  calls.length = 0;
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/groups', component: GroupsView }, { path: '/users', component: { render: () => null } }] });
  await router.push(path);
  const wrapper = mount(GroupsView, { attachTo: document.body, global: { plugins: [createVuetify({ components }), pinia, router] } });
  await flushPromises();
  return wrapper;
}
type View = Awaited<ReturnType<typeof mountGroups>>;
const rowOf = (wrapper: View, name: string) => wrapper.findAll('tbody tr').find((r) => r.find('.dm-group__name').exists() && r.find('.dm-group__name').text() === name)!;
const cellOf = (wrapper: View, name: string, column: string) => {
  const titles = wrapper.findAll('thead th').map((th) => th.text());
  return rowOf(wrapper, name).findAll('td')[titles.indexOf(column)]!;
};
const press = async (label: string) => {
  ([...document.querySelectorAll<HTMLElement>('.v-overlay--active button')].find((b) => b.textContent?.trim() === label) as HTMLElement).click();
  await flushPromises();
};
// A row's menu, then one of its items; a click during the menu's closing transition would be lost, hence the wait.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const choose = async (wrapper: View, name: string, title: string) => {
  await rowOf(wrapper, name).find('[data-test="dm-row-menu"]').trigger('click');
  await flushPromises();
  ([...document.querySelectorAll<HTMLElement>('.v-overlay--active .v-list-item')].find((i) => i.textContent?.trim() === title) as HTMLElement).click();
  await flushPromises();
  await sleep(350);
};
const fill = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => { el.value = value; el.dispatchEvent(new Event('input')); await flushPromises(); };
const field = (label: string) => [...document.querySelectorAll('.v-overlay--active .v-input')].find((i) => i.querySelector('label')?.textContent?.includes(label))!.querySelector('input, textarea') as HTMLInputElement;

describe('Groups', () => {
  it('shows a row per group: its name, description, grants, how many users hold it and its last change', async () => {
    const wrapper = await mountGroups();
    expect(wrapper.find('[data-test="page-title"] h1').text()).toBe('Groups');
    expect(wrapper.findAll('thead th').map((th) => th.text())).toEqual(['Name', 'Description', 'Grants', 'Members', 'Changed', 'Actions']);
    // Sorted by name.
    expect(wrapper.findAll('tbody .dm-group__name').map((n) => n.text())).toEqual(['auditors', 'payments']);
    expect(cellOf(wrapper, 'payments', 'Description').text()).toBe('The payments team');
    expect(cellOf(wrapper, 'payments', 'Grants').findAll('[data-test="grant"]').map((g) => g.text())).toEqual(['team=payments · read, wake, nap', 'every workload · read']);
    expect(cellOf(wrapper, 'auditors', 'Grants').text()).toBe('no grants');
    // The members: a link to the users holding the group; none, a plain 0.
    const members = cellOf(wrapper, 'payments', 'Members').find('a');
    expect(members.text()).toBe('2');
    expect(members.attributes('href')).toBe('/users?group=payments');
    expect(cellOf(wrapper, 'auditors', 'Members').text()).toBe('0');
    expect(cellOf(wrapper, 'auditors', 'Members').find('a').exists()).toBe(false);
    expect(cellOf(wrapper, 'payments', 'Changed').text()).toContain('by admin@example.com');
    expect(cellOf(wrapper, 'auditors', 'Changed').text()).toBe('');
    expect(calls).toEqual(expect.arrayContaining([['GET', '/groups'], ['GET', '/users']]));
  });

  it('says every column of a group in words, exports them, and searches them', async () => {
    const wrapper = await mountGroups();
    expect(expectEveryColumnSaid(wrapper, 'groups', (groups: typeof GROUPS) => groups.find((g) => g.name === 'payments')!))
      .toEqual({ Name: 'payments', Description: 'The payments team', Grants: 'team=payments · read, wake, nap; every workload · read', Members: '2', Changed: '2026-10-18T10:00:00.000Z by admin@example.com' });
    await wrapper.find('[data-test="dm-table-menu"]').trigger('click');
    await flushPromises();
    (document.querySelector('.v-overlay--active [data-test="dm-table-export-csv"]') as HTMLElement).click();
    await flushPromises();
    const [name, , body] = vi.mocked(download).mock.calls.at(-1)!;
    expect(name).toMatch(/^dormeto-groups-\d{4}-\d{2}-\d{2}\.csv$/);
    expect((body as string).split('\r\n')).toEqual([
      'Name,Description,Grants,Members,Changed',
      'auditors,,no grants,0,',
      'payments,The payments team,"team=payments · read, wake, nap; every workload · read",2,2026-10-18T10:00:00.000Z by admin@example.com',
      '',
    ]);
    await wrapper.find('[data-test="dm-table-search"] input').setValue('wake');
    await flushPromises();
    expect(wrapper.findAll('tbody .dm-group__name').map((n) => n.text())).toEqual(['payments']);
  });

  it('creates a group from the grant editor: a selector of tags and permissions, wake and nap implying read', async () => {
    const wrapper = await mountGroups();
    await wrapper.find('[data-test="new-group"]').trigger('click');
    await flushPromises();
    await fill(field('Name'), 'Bad Name');
    expect(document.querySelector('.v-overlay--active')!.textContent).toContain('1 to 48 lower-case letters');
    expect(([...document.querySelectorAll<HTMLButtonElement>('.v-overlay--active button')].find((b) => b.textContent?.trim() === 'Create'))!.disabled).toBe(true);
    await fill(field('Name'), 'billing');
    await fill(field('Description'), 'Billing team');
    await press('Add a grant');
    // A grant with no permission is refused; the selector is empty (every workload) until a tag is added.
    expect(([...document.querySelectorAll<HTMLButtonElement>('.v-overlay--active button')].find((b) => b.textContent?.trim() === 'Create'))!.disabled).toBe(true);
    await press('Add a tag');
    const [key, value] = [...document.querySelectorAll<HTMLInputElement>('.v-overlay--active [data-test="tags-editor"] input')];
    await fill(key!, 'team');
    await fill(value!, 'billing');
    (document.querySelector('.v-overlay--active [data-test="perm-wake"] input') as HTMLInputElement).click();
    await flushPromises();
    expect((document.querySelector('.v-overlay--active [data-test="perm-read"] input') as HTMLInputElement).checked).toBe(true);
    expect((document.querySelector('.v-overlay--active [data-test="perm-read"] input') as HTMLInputElement).disabled).toBe(true);
    await press('Create');
    expect(bodies['POST /groups']).toEqual({ name: 'billing', description: 'Billing team', grants: [{ tags: { team: 'billing' }, permissions: ['read', 'wake'] }] });
    expect(wrapper.text()).toContain('Group billing created.');
    wrapper.unmount();
  });

  it('edits a group\'s description and grants (not its name) from its row\'s menu, and deletes it after confirmation, naming its members', async () => {
    const wrapper = await mountGroups();
    expect(wrapper.findAll('[data-test="dm-row-menu"]').map((b) => b.attributes('aria-label'))).toEqual(['Actions for auditors', 'Actions for payments']);
    await choose(wrapper, 'payments', 'Edit');
    expect(field('Name').disabled).toBe(true);
    await fill(field('Description'), 'Payments');
    await press('Save');
    expect(bodies['PUT /groups/payments']).toMatchObject({ description: 'Payments', grants: [{ tags: { team: 'payments' }, permissions: ['read', 'wake', 'nap'] }, { tags: {}, permissions: ['read'] }] });
    await choose(wrapper, 'payments', 'Delete');
    expect(document.querySelector('.v-overlay--active')!.textContent).toContain('dev@example.com, pay@example.com');
    expect(calls).not.toContainEqual(['DELETE', '/groups/payments']);
    await press('Delete');
    expect(calls).toContainEqual(['DELETE', '/groups/payments']);
    wrapper.unmount();
  });

  it('opens a group\'s dialog when its row is clicked, and when a link names it', async () => {
    const wrapper = await mountGroups();
    await cellOf(wrapper, 'payments', 'Description').trigger('click');
    await flushPromises();
    expect(document.querySelector('.v-overlay--active')!.textContent).toContain('Group payments');
    wrapper.unmount();
    document.body.innerHTML = '';
    const linked = await mountGroups('/groups?group=auditors');
    expect(document.querySelector('.v-overlay--active')!.textContent).toContain('Group auditors');
    linked.unmount();
  });

  it('says there is no group yet and offers to create one', async () => {
    answer.groups = false;
    const wrapper = await mountGroups();
    const empty = wrapper.find('[data-test="groups-empty"]');
    expect(empty.text()).toContain('No group yet');
    await empty.find('button').trigger('click');
    await flushPromises();
    expect(document.querySelector('.v-overlay--active')!.textContent).toContain('New group');
    wrapper.unmount();
  });

  it('still lists the groups when the users cannot be read, their members then unknown', async () => {
    answer.users = false;
    const wrapper = await mountGroups();
    expect(wrapper.text()).toContain('The members could not be read: users throttled');
    expect(cellOf(wrapper, 'payments', 'Members').text()).toBe('—');
    wrapper.unmount();
  });
});
