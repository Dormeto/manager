import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import { VTooltip } from 'vuetify/components';

const SRC = resolve(import.meta.dirname, '../src');
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
      render: () => h(VTooltip, { location: 'top', openOnFocus: true }, {
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

  it('stays open through a tap, which is a hover and a click', async () => {
    const Probe = defineComponent({
      render: () => h(VTooltip, { location: 'top', openOnFocus: true, transition: false }, {
        activator: ({ props }: { props: Record<string, unknown> }) => h('span', { ...props, class: 'setting', tabindex: 0 }, 'Hold 60 s'),
        default: () => h('span', { class: 'tip' }, 'How long the waker holds a request'),
      }),
    });
    const wrapper = mount(Probe, { attachTo: document.body, global: { plugins: [createVuetify({ components })] } });
    await wrapper.find('.setting').trigger('mouseenter');
    await sleep(300);
    await wrapper.find('.setting').trigger('click');
    await sleep(300);
    expect(document.querySelector('.v-overlay--active .tip')).not.toBeNull();
    wrapper.unmount();
  });

  it('no tooltip of the dashboard opens on click too: on a phone a tap would open and close it at once', () => {
    const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.vue'));
    expect(files.length).toBeGreaterThan(50);
    const found = files.filter((f) => /<v-tooltip\b[^>]*\bopen-on-click\b/.test(readFileSync(join(SRC, f), 'utf8')));
    expect(found).toEqual([]);
  });
});
