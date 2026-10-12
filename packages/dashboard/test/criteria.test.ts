import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import CriteriaEditor from '../src/components/CriteriaEditor.vue';
import { availableDimensions, formatTags, parseList, parseTags, removeDimension, setDimension } from '../src/discovery';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

describe('criterion editing', () => {
  it('parses values separated by commas, spaces or new lines, without duplicates', () => {
    expect(parseList('121014831971, 038606077307\n038606077307  ')).toEqual(['121014831971', '038606077307']);
    expect(parseList(' ')).toEqual([]);
  });

  it('parses tags as key=value, key= for any value, several values per key', () => {
    expect(parseTags('env=dev, env=test, team=')).toEqual({ env: ['dev', 'test'], team: [] });
    expect(parseTags('owner')).toEqual({ owner: [] });
    expect(formatTags({ env: ['dev', 'test'], team: [] })).toBe('env=dev, env=test, team=');
  });

  it('sets and removes dimensions, and offers each dimension once', () => {
    let c = setDimension({}, 'regions', 'eu-west-1 eu-west-3');
    c = setDimension(c, 'backendKinds', 'ecs, lambda, asg');
    expect(c).toEqual({ regions: ['eu-west-1', 'eu-west-3'], backendKinds: ['ecs', 'asg'] });
    expect(availableDimensions(c)).not.toContain('regions');
    expect(availableDimensions(c)).toContain('accountIds');
    expect(removeDimension(c, 'regions')).toEqual({ backendKinds: ['ecs', 'asg'] });
  });
});

describe('CriteriaEditor', () => {
  const mountEditor = (modelValue: Record<string, unknown>) => mount(CriteriaEditor, { props: { modelValue }, global: { plugins: [createVuetify({ components })] } });

  it('shows each dimension of the criterion with its values', () => {
    const wrapper = mountEditor({ accountIds: ['121014831971', '038606077307'], resourceTags: { env: ['preview'] } });
    const values = wrapper.findAll('input').map((i) => (i.element as HTMLInputElement).value);
    expect(values).toContain('121014831971, 038606077307');
    expect(values).toContain('env=preview');
  });

  it('emits the parsed criterion when values change, and without a removed dimension', async () => {
    const wrapper = mountEditor({ accountIds: ['121014831971'] });
    await wrapper.find('[data-dimension="accountIds"] input').setValue('121014831971, 038606077307');
    expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual([{ accountIds: ['121014831971', '038606077307'] }]);
    await wrapper.find('button[data-remove="accountIds"]').trigger('click');
    expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual([{}]);
  });
});
