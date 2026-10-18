import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import NoticeAlert from '../src/components/NoticeAlert.vue';
import { useSession } from '../src/stores/session';

const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { render: () => null } }, { path: '/operations', component: { render: () => null } }] });
const plugins = [createVuetify({ components }), router];

describe('NoticeAlert', () => {
  beforeEach(() => setActivePinia(createPinia()));
  it('shows a member the operation as text, with no Operations link', () => {
    useSession().role = 'member';
    const wrapper = mount(NoticeAlert, { props: { notice: { type: 'success', text: 'Done (operation op-1).', operation: 'op-1' } }, global: { plugins } });
    expect(wrapper.find('a').exists()).toBe(false);
    expect(wrapper.text()).toContain('Done (operation op-1).');
  });

  it('links the operation it announces to its steps in Operations', () => {
    const wrapper = mount(NoticeAlert, { props: { notice: { type: 'success', text: 'Offboarding started (operation op-1).', operation: 'op-1' } }, global: { plugins } });
    expect(wrapper.text()).toContain('Offboarding started (operation op-1).');
    const link = wrapper.find('a');
    expect(link.text()).toBe('Follow it in Operations');
    expect(link.attributes('href')).toBe('/operations?id=op-1');
  });

  it('shows a notice without an operation as text only, and closes', async () => {
    const wrapper = mount(NoticeAlert, { props: { notice: { type: 'error', text: 'Refused.' } }, global: { plugins } });
    expect(wrapper.find('a').exists()).toBe(false);
    await wrapper.find('button').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });
});
