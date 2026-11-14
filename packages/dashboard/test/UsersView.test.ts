import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import UsersView from '../src/views/UsersView.vue';
import { useSession } from '../src/stores/session';
import { download } from '../src/table-export';
import { expectEveryColumnSaid } from './table-columns';

const calls: [string, string][] = [];
const bodies: Record<string, unknown> = {};
const failing = { groups: false };
vi.mock('../src/api', () => ({
  api: vi.fn(async (path: string, init?: RequestInit) => {
    calls.push([init?.method ?? 'GET', path]);
    if (init?.body) bodies[`${init.method} ${path}`] = JSON.parse(init.body as string);
    if (path === '/groups' && !init?.method && failing.groups) throw new Error('groups table throttled');
    if (path === '/groups' && !init?.method) {
      return { groups: [
        { name: 'payments', description: 'The payments team', grants: [{ tags: { team: 'payments' }, permissions: ['read', 'wake', 'nap'] }, { tags: {}, permissions: ['read'] }], updatedAt: '2026-10-18T10:00:00.000Z', updatedBy: 'admin@example.com' },
        { name: 'auditors', description: '', grants: [], updatedAt: null, updatedBy: null },
      ] };
    }
    if (path === '/users') {
      return { users: [
        { email: 'admin@example.com', role: 'admin', status: 'CONFIRMED', enabled: true, createdAt: null, mfa: true },
        { email: 'ops@example.com', role: 'operator', status: 'CONFIRMED', enabled: true, createdAt: null, mfa: true },
        { email: 'new@example.com', role: 'viewer', status: 'CONFIRMED', enabled: true, createdAt: null, mfa: false },
        { email: 'dev@example.com', role: 'member', status: 'CONFIRMED', enabled: true, createdAt: null, mfa: true, groups: ['payments'] },
        { email: 'odd@example.com', role: 'viewer', status: 'CONFIRMED', enabled: true, createdAt: null, mfa: null },
      ] };
    }
    return { email: 'ops@example.com', mfa: false };
  }),
}));
vi.mock('../src/table-export', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/table-export')>()), download: vi.fn() }));
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});

async function mountUsers(path = '/users') {
  const pinia = createPinia();
  setActivePinia(pinia);
  useSession().email = 'admin@example.com';
  for (const k of Object.keys(bodies)) delete bodies[k];
  calls.length = 0;
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/users', component: UsersView }, { path: '/groups', component: { render: () => null } }] });
  await router.push(path);
  const wrapper = mount(UsersView, { attachTo: document.body, global: { plugins: [createVuetify({ components }), pinia, router] } });
  await flushPromises();
  return wrapper;
}

describe('Users', () => {
  it('shows who has two-step verification, and resets another user\'s after confirmation', async () => {
    const wrapper = await mountUsers();
    const row = (email: string) => wrapper.findAll('tbody tr').find((r) => r.text().includes(email))!;
    // The status and the two-step verification as icons (tables design §3): their words are their names and tooltips.
    const marks = (email: string) => row(email).findAll('[data-test="status-mark"]');
    expect(marks('ops@example.com').map((m) => m.attributes('aria-label'))).toEqual(['active', 'Two-step verification on']);
    expect(marks('new@example.com')[1]!.attributes('aria-label')).toBe('Two-step verification off');
    // Review M4: Cognito could not say.
    expect(marks('odd@example.com')[1]!.attributes('aria-label')).toBe('Two-step verification unknown');
    for (const m of marks('ops@example.com')) expect(m.text()).toBe('');
    await row('ops@example.com').find('button').trigger('click');
    await flushPromises();
    const reset = [...document.querySelectorAll('.v-list-item')].find((i) => i.textContent?.includes('Reset two-step verification')) as HTMLElement;
    reset.click();
    await flushPromises();
    expect(document.body.textContent).toContain('ops@example.com sets up an authenticator app again at their next sign-in');
    // Passkeys: no administrator call removes another user's.
    expect(document.body.textContent).toContain('Passkeys cannot be removed by an administrator');
    expect(document.body.textContent).toContain('disable the user');
    const confirm = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Reset') as HTMLElement;
    confirm.click();
    await flushPromises();
    expect(calls).toContainEqual(['POST', '/users/ops%40example.com/mfa/reset']);
    wrapper.unmount();
  });

  const press = async (label: string) => {
    ([...document.querySelectorAll<HTMLElement>('.v-overlay--active button')].find((b) => b.textContent?.trim() === label) as HTMLElement).click();
    await flushPromises();
  };
  const fill = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => { el.value = value; el.dispatchEvent(new Event('input')); await flushPromises(); };
  const field = (label: string) => [...document.querySelectorAll('.v-overlay--active .v-input')].find((i) => i.querySelector('label')?.textContent?.includes(label))!.querySelector('input, textarea') as HTMLInputElement;

  // The groups are managed in their own view (the user, 2026-11-15); Users keeps each user's membership.
  it('shows each user\'s groups, each linking to it in Groups, and manages no group itself', async () => {
    const wrapper = await mountUsers();
    expect(wrapper.find('[data-test="groups"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="new-group"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('New group');
    const row = wrapper.findAll('tbody tr').find((r) => r.text().includes('dev@example.com'))!;
    expect(row.text()).toContain('member');
    const chip = row.find('[data-test="user-group"]');
    expect(chip.text()).toBe('payments');
    expect(chip.attributes('href')).toBe('/groups?group=payments');
    wrapper.unmount();
  });

  it('shows only the users holding a group a link names, until its filter is removed', async () => {
    const wrapper = await mountUsers('/users?group=payments');
    expect(wrapper.findAll('tbody tr').map((r) => r.find('.dm-user__email').text())).toEqual(['dev@example.com']);
    const filter = wrapper.find('[data-test="group-filter"]');
    expect(filter.text()).toContain('payments');
    await filter.find('.v-chip__close').trigger('click');
    await flushPromises();
    expect(wrapper.findAll('tbody tr')).toHaveLength(5);
    wrapper.unmount();
  });

  it('sets a user\'s groups, saying they apply at their next sign-in, within an hour', async () => {
    const wrapper = await mountUsers();
    const row = wrapper.findAll('tbody tr').find((r) => r.text().includes('new@example.com'))!;
    await row.find('button').trigger('click');
    await flushPromises();
    ([...document.querySelectorAll<HTMLElement>('.v-list-item')].find((i) => i.textContent?.includes('Groups…')) as HTMLElement).click();
    await flushPromises();
    expect(document.querySelector('.v-overlay--active')!.textContent).toContain('next sign-in, within an hour');
    const select = wrapper.findAllComponents({ name: 'VSelect' }).find((c) => c.props('label') === 'Groups')!;
    select.vm.$emit('update:modelValue', ['auditors', 'payments']);
    await flushPromises();
    await press('Save');
    expect(bodies['PUT /users/new%40example.com/groups']).toEqual({ groups: ['auditors', 'payments'] });
    wrapper.unmount();
  });

  it('invites a member with groups, and offers "Make member" among the roles', async () => {
    const wrapper = await mountUsers();
    await wrapper.find('button:not([aria-label])').trigger('click');
    await flushPromises();
    await fill(field('Email'), 'new.dev@example.com');
    const role = wrapper.findAllComponents({ name: 'VSelect' }).find((c) => c.props('label') === 'Role')!;
    expect(role.props('items')).toContainEqual({ title: 'Member', value: 'member' });
    role.vm.$emit('update:modelValue', 'member');
    await flushPromises();
    expect(document.querySelector('.v-overlay--active')!.textContent).toContain('only the workloads their groups');
    wrapper.findAllComponents({ name: 'VSelect' }).find((c) => c.props('label') === 'Groups')!.vm.$emit('update:modelValue', ['payments']);
    await flushPromises();
    await press('Invite');
    expect(bodies['POST /users']).toEqual({ email: 'new.dev@example.com', role: 'member', groups: ['payments'] });
    const row = wrapper.findAll('tbody tr').find((r) => r.text().includes('new@example.com'))!;
    await row.find('button').trigger('click');
    await flushPromises();
    expect([...document.querySelectorAll('.v-list-item')].map((i) => i.textContent?.trim())).toContain('Make member');
    wrapper.unmount();
  });

  it('exports its users with each column in words (the status and the two-step verification said), the menu left out', async () => {
    const wrapper = await mountUsers();
    // One's own row has no menu; the others' "⋮" names its user.
    expect(wrapper.findAll('tbody tr').find((r) => r.text().includes('admin@example.com'))!.find('[data-test="dm-row-menu"]').exists()).toBe(false);
    expect(wrapper.findAll('[data-test="dm-row-menu"]').map((b) => b.attributes('aria-label'))).toEqual(['ops@example.com', 'new@example.com', 'dev@example.com', 'odd@example.com'].map((e) => `Actions for ${e}`));
    await wrapper.find('[data-test="dm-table-menu"]').trigger('click');
    await flushPromises();
    (document.querySelector('.v-overlay--active [data-test="dm-table-export-csv"]') as HTMLElement).click();
    await flushPromises();
    const [name, mime, body] = vi.mocked(download).mock.calls.at(-1)!;
    expect(name).toMatch(/^dormeto-users-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(mime).toBe('text/csv;charset=utf-8');
    expect((body as string).split('\r\n')).toEqual([
      'Email,Role,Groups,Status,Two-step,Created',
      'admin@example.com,admin,,active,on,',
      'ops@example.com,operator,,active,on,',
      'new@example.com,viewer,,active,off,',
      'dev@example.com,member,payments,active,on,',
      'odd@example.com,viewer,,active,unknown,',
      '',
    ]);
    wrapper.unmount();
  });

  it('says every column of a user in words, and sorts the status and the two-step verification on those words', async () => {
    const wrapper = await mountUsers();
    type U = { email: string; createdAt: string | null };
    expect(expectEveryColumnSaid(wrapper, 'users', (users: U[]) => ({ ...users.find((u) => u.email === 'dev@example.com')!, createdAt: '2026-10-01T08:00:00.000Z' })))
      .toEqual({ Email: 'dev@example.com', Role: 'member', Groups: 'payments', Status: 'active', 'Two-step': 'on', Created: '2026-10-01T08:00:00.000Z' });
    const header = (title: string) => wrapper.findAll('thead th').find((th) => th.text() === title)!.find('.v-data-table-header__content');
    const mfa = () => wrapper.findAll('tbody tr').map((r) => r.findAll('[data-test="status-mark"]')[1]!.attributes('aria-label'));
    await header('Two-step').trigger('click');
    await flushPromises();
    expect(mfa()).toEqual(['off', 'on', 'on', 'on', 'unknown'].map((w) => `Two-step verification ${w}`));
    wrapper.unmount();
  });

  it('says so when the groups cannot be read, and still lists the users', async () => {
    failing.groups = true;
    const wrapper = await mountUsers();
    failing.groups = false;
    expect(wrapper.text()).toContain('The groups could not be read: groups table throttled');
    expect(wrapper.text()).toContain('dev@example.com');
    wrapper.unmount();
  });
});
