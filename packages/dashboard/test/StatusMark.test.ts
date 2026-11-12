// A status as its icon alone (tables design §3): no word in the cell; the word in the tooltip and the accessible name.
import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { h, nextTick } from 'vue';
import { mdiAlertOutline } from '@mdi/js';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import StatusMark from '../src/components/StatusMark.vue';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let wrapper: VueWrapper | undefined;
afterEach(() => wrapper?.unmount());

describe('StatusMark', () => {
  it('shows the icon in its color and no word; the word is its accessible name and the tooltip\'s first line, the slot after it', async () => {
    wrapper = mount(StatusMark, {
      props: { icon: mdiAlertOutline, color: 'warning', label: 'last download failed: HTTP 503' },
      slots: { default: () => h('div', { class: 'more' }, 'Kept: the version of 2 h ago.') },
      attachTo: document.body,
      global: { plugins: [createVuetify({ components })] },
    });
    const mark = wrapper.find('[data-test="status-mark"]');
    expect(mark.text()).toBe('');
    expect(mark.attributes('role')).toBe('img');
    expect(mark.attributes('aria-label')).toBe('last download failed: HTTP 503');
    expect(mark.attributes('tabindex')).toBe('0');
    expect(mark.classes()).toContain('text-warning');
    expect(wrapper.findComponent({ name: 'VIcon' }).props('icon')).toBe(mdiAlertOutline);
    await mark.trigger('mouseenter');
    await nextTick();
    await sleep(300);
    const tip = document.querySelector('.v-overlay--active')!;
    expect(tip.querySelector('.dm-status__label')!.textContent).toBe('last download failed: HTTP 503');
    expect(tip.querySelector('.more')!.textContent).toBe('Kept: the version of 2 h ago.');
  });

  it('breathes while running (none when motion is reduced, by the style sheet)', () => {
    wrapper = mount(StatusMark, { props: { icon: mdiAlertOutline, label: 'running', pulse: true }, global: { plugins: [createVuetify({ components })] } });
    expect(wrapper.find('[data-test="status-mark"]').classes()).toContain('dm-status--pulse');
    expect(wrapper.find('[data-test="status-mark"]').classes()).toContain('dm-status--plain');
  });
});
