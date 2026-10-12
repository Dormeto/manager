import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import StateChip from '../src/components/StateChip.vue';

describe('StateChip', () => {
  it('shows the state with its color', () => {
    const wrapper = mount(StateChip, { props: { state: 'FAILED' }, global: { plugins: [createVuetify({ components })] } });
    expect(wrapper.text()).toBe('FAILED');
    expect(wrapper.html()).toContain('bg-error');
  });
});
