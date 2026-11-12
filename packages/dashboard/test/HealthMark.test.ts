// A router's health as its icon alone (tables design §3, §4): no word in the cell; the status, its problems with their
// levels, the open alert and since when, the error's text and "not reporting" in the tooltip; an open alert adds a bell.
import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { mdiAlertOctagonOutline, mdiAlertOutline, mdiBellRingOutline, mdiCheckCircleOutline, mdiLanDisconnect } from '@mdi/js';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import HealthMark from '../src/components/HealthMark.vue';
import type { AlarmInfo, RouterInfo } from '../src/types';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const base: RouterInfo = { name: 'dmtr-dev-eu-west-3', region: 'eu-west-3', account: '111122223333', source: 'manager', version: '0.40.0' };
const alarm: AlarmInfo = { id: 'router#111122223333#eu-west-3', kind: 'router', name: 'dmtr-dev-eu-west-3', level: 'warning', since: new Date(Date.now() - 3 * 3_600_000).toISOString(), problems: [] };

let wrapper: VueWrapper | undefined;
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  document.body.innerHTML = '';
});
function render(router: RouterInfo, open?: AlarmInfo) {
  wrapper = mount(HealthMark, { props: { router, alarm: open }, attachTo: document.body, global: { plugins: [createVuetify({ components })] } });
  return wrapper;
}
const marks = (w: VueWrapper) => w.findAll('[data-test="status-mark"]');
const icons = (w: VueWrapper) => w.findAllComponents({ name: 'VIcon' }).map((i) => i.props('icon'));
// The tooltip of a mark, as its lines: the word first.
async function tip(w: VueWrapper, index = 0): Promise<string[]> {
  await marks(w)[index]!.trigger('mouseenter');
  await nextTick();
  await sleep(300);
  const overlay = document.querySelector('.v-overlay--active .v-overlay__content')!;
  return [...overlay.children].map((line) => line.textContent!.replace(/\s+/g, ' ').trim());
}

describe('HealthMark', () => {
  it('shows an ok router as the check icon in green, its word the icon\'s name and its tooltip', async () => {
    const w = render({ ...base, health: { status: 'ok', problems: [] } });
    expect(w.text()).toBe('');
    expect(marks(w)).toHaveLength(1);
    expect(marks(w)[0]!.attributes('aria-label')).toBe('ok');
    expect(marks(w)[0]!.classes()).toContain('text-success');
    expect(icons(w)).toEqual([mdiCheckCircleOutline]);
    expect(await tip(w)).toEqual(['ok']);
  });

  it('lists each problem of a warning with its level in the tooltip, none in the cell', async () => {
    const w = render({ ...base, health: { status: 'warning', problems: [{ level: 'warning', text: 'controller: 2 errors in 24 hours' }, { level: 'warning', text: '5 drift repairs in 24 hours' }] } });
    expect(w.text()).toBe('');
    expect(marks(w)[0]!.attributes('aria-label')).toBe('warning');
    expect(marks(w)[0]!.classes()).toContain('text-warning');
    expect(icons(w)).toEqual([mdiAlertOutline]);
    expect(await tip(w)).toEqual(['warning', 'warning: controller: 2 errors in 24 hours', 'warning: 5 drift repairs in 24 hours']);
  });

  it('shows an error in red, its problems of either level in the tooltip', async () => {
    const w = render({ ...base, health: { status: 'error', problems: [{ level: 'error', text: 'idle check late' }, { level: 'warning', text: 'check queue: 3 messages' }] } });
    expect(marks(w)[0]!.attributes('aria-label')).toBe('error');
    expect(marks(w)[0]!.classes()).toContain('text-error');
    expect(icons(w)).toEqual([mdiAlertOctagonOutline]);
    expect(await tip(w)).toEqual(['error', 'error: idle check late', 'warning: check queue: 3 messages']);
  });

  it('shows a router it cannot reach as the disconnected icon, the error\'s text in the tooltip', async () => {
    const w = render({ ...base, error: 'router dmtr-dev-eu-west-3: Task timed out after 30.00 seconds', reporting: false });
    expect(w.text()).toBe('');
    expect(marks(w)[0]!.attributes('aria-label')).toBe('unreachable');
    expect(marks(w)[0]!.classes()).toContain('text-error');
    expect(icons(w)).toEqual([mdiLanDisconnect]);
    // Unreachable says it all: no "not reporting" beside it.
    expect(await tip(w)).toEqual(['unreachable', 'router dmtr-dev-eu-west-3: Task timed out after 30.00 seconds']);
  });

  it('adds a bell for an open alert, dated in its tooltip and in the health\'s', async () => {
    const w = render({ ...base, health: { status: 'warning', problems: [{ level: 'warning', text: 'drift' }] } }, alarm);
    expect(w.text()).toBe('');
    expect(marks(w).map((m) => m.attributes('aria-label'))).toEqual(['warning', 'alert since 3 h ago']);
    expect(marks(w)[1]!.classes()).toContain('text-warning');
    expect(marks(w)[1]!.attributes('tabindex')).toBe('0');
    expect(icons(w)).toEqual([mdiAlertOutline, mdiBellRingOutline]);
    expect(await tip(w)).toEqual(['warning', 'warning: drift', 'alert since 3 h ago']);
    await marks(w)[0]!.trigger('mouseleave');
    await sleep(300);
    expect((await tip(w, 1))[0]).toBe('alert since 3 h ago');
  });

  it('says in the tooltip that a router does not report, and why', async () => {
    const w = render({ ...base, reporting: false, health: { status: 'ok', problems: [] } });
    expect(w.text()).toBe('');
    expect(await tip(w)).toEqual(['ok', 'not reporting: the manager calls this router at each view: it does not send its state (a router older than 0.21, or without the manager\'s event bus).']);
  });

  it('says a router before 0.16 has no health report, upgrading gives one', async () => {
    const w = render({ ...base, version: '0.15.2' });
    expect(w.text()).toBe('');
    expect(marks(w)[0]!.attributes('aria-label')).toBe('no health report');
    expect(marks(w)[0]!.classes()).toContain('dm-status--plain');
    expect(await tip(w)).toEqual(['no health report', 'Upgrade to 0.16 for health.']);
  });
});
