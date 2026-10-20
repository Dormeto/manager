import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import PauseDialog from '../src/components/PauseDialog.vue';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});

function text(router: boolean) {
  const w = mount(PauseDialog, { props: { modelValue: true, subject: 'demo', router }, attachTo: document.body, global: { plugins: [createVuetify({ components, directives })] } });
  const t = document.body.textContent ?? '';
  w.unmount();
  return t;
}

describe('PauseDialog', () => {
  it('says a paused workload is not napped, and no workload of a paused router is', () => {
    expect(text(false)).toContain('This workload is not napped while paused.');
    expect(text(true)).toContain('No workload of this router is napped while paused.');
  });
});
