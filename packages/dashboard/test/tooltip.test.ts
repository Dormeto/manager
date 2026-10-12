import { describe, expect, it } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import { VTooltip } from 'vuetify/components';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// jsdom has no ResizeObserver nor visualViewport, which the Vuetify overlays use to position their content.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1024, height: 768, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});

describe('setting tooltip', () => {
  it('opens on hover with the props used in the workload view', async () => {
    const Probe = defineComponent({
      render: () => h(VTooltip, { location: 'top', openOnClick: true, openOnFocus: true }, {
        activator: ({ props }: { props: Record<string, unknown> }) => h('span', { ...props, class: 'setting', tabindex: 0 }, 'Hold 60 s'),
        default: () => 'How long the waker holds a request',
      }),
    });
    const wrapper = mount(Probe, { attachTo: document.body, global: { plugins: [createVuetify({ components })] } });
    await wrapper.find('.setting').trigger('mouseenter');
    await nextTick();
    await sleep(300);
    expect(document.body.textContent).toContain('How long the waker holds a request');
    wrapper.unmount();
  });
});
