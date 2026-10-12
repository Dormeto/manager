import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import App from '../src/App.vue';

vi.mock('../src/config', () => ({ getConfig: () => ({ env: 'dev' }) }));
vi.mock('../src/auth', () => ({ signOut: vi.fn() }));
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

describe('App', () => {
  it('gives the views the whole width of the window, however wide', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { render: () => null }, meta: { public: true } }] });
    await router.push('/');
    const wrapper = mount(App, { global: { plugins: [createVuetify({ components }), pinia, router] } });
    await flushPromises();
    const container = wrapper.find('main .v-container');
    expect(container.classes()).toContain('v-container--fluid');
    expect(container.attributes('style') ?? '').not.toMatch(/max-width/);
    wrapper.unmount();
  });
});
