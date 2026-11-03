// The defaults of a level (vision settings at scale design §8, §9): each field empty to inherit, what each reaches, only what changed sent.
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import DefaultsDialog from '../src/components/DefaultsDialog.vue';
import { api } from '../src/api';
import { useSession } from '../src/stores/session';

vi.mock('../src/api', () => ({ api: vi.fn(async () => ({ workloads: 12, keys: { idleMinutes: 9, waitSeconds: 12, drainSeconds: 12, wakeTimeoutSeconds: 12, maxHolders: 12, failedRetrySeconds: 12, wakeMode: 4 } })) }));
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});

async function open(props: Record<string, unknown>) {
  setActivePinia(createPinia());
  useSession().role = 'admin';
  const wrapper = mount(DefaultsDialog, { props: { modelValue: false, title: 'Defaults of dmt-dev', level: 'router', name: 'dmt-dev', values: {}, ...props }, attachTo: document.body, global: { plugins: [createVuetify({ components, directives })] } });
  await wrapper.setProps({ modelValue: true });
  await flushPromises();
  return wrapper;
}
const field = (key: string) => document.querySelector(`[data-test="default-${key}"] input`) as HTMLInputElement;
const save = () => (document.querySelector('[data-test="save-defaults"]') as HTMLButtonElement).click();

describe('DefaultsDialog', () => {
  it('says what each field inherits and how many workloads follow the level, from the manager', async () => {
    const wrapper = await open({ values: { idleMinutes: 30 }, inherited: { idleMinutes: '45 min, organization', waitSeconds: '60 s, built-in' } });
    expect(vi.mocked(api)).toHaveBeenCalledWith('/settings/reach?level=router&name=dmt-dev');
    expect(field('idleMinutes').value).toBe('30');
    expect(field('waitSeconds').placeholder).toBe('Inherit (60 s, built-in)');
    expect(document.querySelector('[data-test="default-idleMinutes"]')!.textContent).toContain('9 of 12 workloads follow this level');
    wrapper.unmount();
  });

  it('sends only what changed: a value, null for one emptied', async () => {
    const wrapper = await open({ values: { idleMinutes: 30 } });
    field('idleMinutes').value = '';
    field('idleMinutes').dispatchEvent(new Event('input'));
    field('waitSeconds').value = '20';
    field('waitSeconds').dispatchEvent(new Event('input'));
    await flushPromises();
    save();
    await flushPromises();
    expect(wrapper.emitted('submit')).toEqual([[{ idleMinutes: null, waitSeconds: 20 }]]);
    wrapper.unmount();
  });

  it('the organization\'s fields fall back on the built-in values, and it reads its reach without a name', async () => {
    vi.mocked(api).mockClear();
    const wrapper = await open({ level: 'organization', name: undefined, values: {} });
    expect(vi.mocked(api)).toHaveBeenCalledWith('/settings/reach?level=organization');
    expect(field('idleMinutes').placeholder).toBe('Built-in (15 min)');
    wrapper.unmount();
  });
});
