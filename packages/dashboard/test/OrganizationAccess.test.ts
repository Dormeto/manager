import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import OrganizationAccess from '../src/components/OrganizationAccess.vue';
import type { AccessReport } from '../src/access';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ready: AccessReport = {
  counts: { ready: 2, discoveryMissing: 0, commandMissing: 0, unchecked: 0 }, accounts: [], cursor: null, delegation: 'ok',
  checkedAt: '2026-10-07T06:00:00.000Z', forwarders: { connected: 2, connecting: 0, impossible: [] },
};
const mountPanel = (report: AccessReport) => mount(OrganizationAccess, { attachTo: document.body, props: { report }, global: { plugins: [createVuetify({ components })] } });

describe('Organization access panel', () => {
  it('says all is ready with a status icon whose tooltip holds the counts and what they mean', async () => {
    const wrapper = mountPanel(ready);
    expect(wrapper.text()).not.toContain('2 ready.');
    const icon = wrapper.find('[aria-label="Organization access: all ready"]');
    expect(icon.exists()).toBe(true);
    await icon.trigger('mouseenter');
    await nextTick();
    await sleep(300);
    expect(document.body.textContent).toContain('2 ready.');
    expect(document.body.textContent).toContain('Event-driven refresh: 2 accounts connected.');
    wrapper.unmount();
  });

  it('keeps listing what needs attention, with the status saying so', () => {
    const wrapper = mountPanel({ ...ready, counts: { ready: 1, discoveryMissing: 0, commandMissing: 1, unchecked: 0 },
      accounts: [{ account: '222222222222', name: 'shop', discovery: { ok: true }, command: { ok: false, reason: 'AccessDenied' } }] });
    expect(wrapper.find('[aria-label="Organization access: needs attention"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('shop (222222222222): no command role (AccessDenied)');
    expect(wrapper.text()).toContain('How to set up the roles');
    wrapper.unmount();
  });
});
