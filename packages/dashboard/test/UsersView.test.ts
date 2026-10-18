import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import UsersView from '../src/views/UsersView.vue';
import { useSession } from '../src/stores/session';

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
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});

describe('Users', () => {
  it('shows who has two-step verification, and resets another user\'s after confirmation', async () => {
    setActivePinia(createPinia());
    useSession().email = 'admin@example.com';
    const wrapper = mount(UsersView, { attachTo: document.body, global: { plugins: [createVuetify({ components })] } });
    await flushPromises();
    const row = (email: string) => wrapper.findAll('tbody tr').find((r) => r.text().includes(email))!;
    expect(row('ops@example.com').text()).toContain('on');
    expect(row('new@example.com').text()).toContain('off');
    // Review M4: Cognito could not say.
    expect(row('odd@example.com').text()).toContain('unknown');
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

  // R11: groups and grants.
  async function mountUsers() {
    setActivePinia(createPinia());
    useSession().email = 'admin@example.com';
    for (const k of Object.keys(bodies)) delete bodies[k];
    calls.length = 0;
    const wrapper = mount(UsersView, { attachTo: document.body, global: { plugins: [createVuetify({ components })] } });
    await flushPromises();
    return wrapper;
  }
  const press = async (label: string) => {
    ([...document.querySelectorAll<HTMLElement>('.v-overlay--active button')].find((b) => b.textContent?.trim() === label) as HTMLElement).click();
    await flushPromises();
  };
  const fill = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => { el.value = value; el.dispatchEvent(new Event('input')); await flushPromises(); };
  const field = (label: string) => [...document.querySelectorAll('.v-overlay--active .v-input')].find((i) => i.querySelector('label')?.textContent?.includes(label))!.querySelector('input, textarea') as HTMLInputElement;

  it('lists the groups with their members and grants, and each user\'s groups', async () => {
    const wrapper = await mountUsers();
    const card = wrapper.find('[data-test="groups"]');
    const payments = card.findAll('[data-test="group"]').find((g) => g.text().includes('payments'))!;
    expect(payments.text()).toContain('The payments team');
    expect(payments.text()).toContain('dev@example.com');
    expect(payments.findAll('[data-test="grant"]').map((g) => g.text())).toEqual(['team=payments · read, wake, nap', 'every workload · read']);
    expect(card.findAll('[data-test="group"]').find((g) => g.text().includes('auditors'))!.text()).toContain('no grants');
    const row = wrapper.findAll('tbody tr').find((r) => r.text().includes('dev@example.com'))!;
    expect(row.text()).toContain('member');
    expect(row.find('[data-test="user-group"]').text()).toBe('payments');
    wrapper.unmount();
  });

  it('creates a group from the grant editor: a selector of tags and permissions, wake and nap implying read', async () => {
    const wrapper = await mountUsers();
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
    wrapper.unmount();
  });

  it('edits a group\'s description and grants (not its name) and deletes it after confirmation', async () => {
    const wrapper = await mountUsers();
    await wrapper.find('[data-test="edit-group-payments"]').trigger('click');
    await flushPromises();
    expect(field('Name').disabled).toBe(true);
    await fill(field('Description'), 'Payments');
    await press('Save');
    expect(bodies['PUT /groups/payments']).toMatchObject({ description: 'Payments', grants: [{ tags: { team: 'payments' }, permissions: ['read', 'wake', 'nap'] }, { tags: {}, permissions: ['read'] }] });
    await wrapper.find('[data-test="delete-group-payments"]').trigger('click');
    await flushPromises();
    expect(document.querySelector('.v-overlay--active')!.textContent).toContain('dev@example.com');
    expect(calls).not.toContainEqual(['DELETE', '/groups/payments']);
    await press('Delete');
    expect(calls).toContainEqual(['DELETE', '/groups/payments']);
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

  it('says so when the groups cannot be read, and still lists the users', async () => {
    failing.groups = true;
    const wrapper = await mountUsers();
    failing.groups = false;
    expect(wrapper.text()).toContain('The groups could not be read: groups table throttled');
    expect(wrapper.text()).toContain('dev@example.com');
    wrapper.unmount();
  });
});
