// A pause as its icon alone (tables design §3): "paused" or "excluded" is the icon's name and its tooltip's first line,
// who, when and why after it.
import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { mdiCancel, mdiPauseCircleOutline } from '@mdi/js';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import PauseChip from '../src/components/PauseChip.vue';
import type { Pause } from '../src/types';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
const pause = (over: Partial<Pause> = {}): Pause => ({ scope: 'router', by: 'ops@example.com', at: hourAgo, reason: 'load test', until: null, keepAsleep: false, ...over });

let wrapper: VueWrapper | undefined;
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  document.body.innerHTML = '';
});
const render = (pauses?: Pause[]) => {
  wrapper = mount(PauseChip, { props: { pauses }, attachTo: document.body, global: { plugins: [createVuetify({ components })] } });
  return wrapper;
};

describe('PauseChip', () => {
  it('shows a pause as the pause icon in the pause\'s color, no word; who, when and why in the tooltip', async () => {
    const w = render([pause()]);
    const mark = w.find('[data-test="status-mark"]');
    expect(mark.text()).toBe('');
    expect(mark.attributes('aria-label')).toBe('paused');
    expect(mark.attributes('tabindex')).toBe('0');
    expect(mark.classes()).toContain('text-secondary');
    expect(w.findComponent({ name: 'VIcon' }).props('icon')).toBe(mdiPauseCircleOutline);
    await mark.trigger('mouseenter');
    await nextTick();
    await sleep(300);
    const lines = [...document.querySelector('.v-overlay--active .v-overlay__content')!.children].map((l) => l.textContent!.trim());
    expect(lines).toEqual(['paused', 'Router paused by ops@example.com 1 h ago: load test', 'Never napped while paused; requests still wake it.']);
  });

  it('names an exclusion "excluded", with its own icon', () => {
    const w = render([pause({ scope: 'workload', exclusionId: 'ex-1', reason: 'excluded: shared' }), pause({ scope: 'workload' })]);
    expect(w.find('[data-test="status-mark"]').attributes('aria-label')).toBe('excluded');
    expect(w.findComponent({ name: 'VIcon' }).props('icon')).toBe(mdiCancel);
  });

  it('shows nothing without a pause', () => {
    expect(render([]).find('[data-test="status-mark"]').exists()).toBe(false);
    wrapper!.unmount();
    expect(render(undefined).find('[data-test="status-mark"]').exists()).toBe(false);
  });
});
