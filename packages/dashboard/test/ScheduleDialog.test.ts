import { afterEach, describe, expect, it } from 'vitest';
import { h as vh } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import ScheduleDialog from '../src/components/ScheduleDialog.vue';
import type { Schedule } from '../src/schedule';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});

const schedule: Schedule = { timeZone: 'Europe/Paris', windows: [{ kind: 'awake', days: ['mon'], start: '08:00', end: '19:00' }] };
const mounted: VueWrapper[] = [];
const emitted: string[] = [];
async function open(s: Schedule | null) {
  emitted.length = 0;
  const wrapper = mount({ render: () => vh(components.VApp, null, () => vh(ScheduleDialog, { modelValue: true, schedule: s, name: 'Shop', onClear: () => emitted.push('clear'), onSubmit: () => emitted.push('submit') })) }, { attachTo: document.body, global: { plugins: [createVuetify({ components, directives })] } });
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}
afterEach(() => { mounted.splice(0).forEach((w) => w.unmount()); document.body.innerHTML = ''; });
const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
const click = async (label: string) => { button(label)!.click(); await flushPromises(); };

describe('Schedule dialog: clearing', () => {
  it('has a Clear schedule action that asks first, then emits a clear', async () => {
    await open(schedule);
    expect(button('Clear schedule')).toBeDefined();
    await click('Clear schedule');
    expect(emitted).toEqual([]);
    expect(document.body.textContent).toContain('Clear the schedule?');
    await click('Cancel');
    expect(emitted).toEqual([]);
    await click('Clear schedule');
    await click('Clear');
    expect(emitted).toEqual(['clear']);
  });

  it('has no Clear schedule action for a workload with no schedule', async () => {
    await open(null);
    expect(button('Clear schedule')).toBeUndefined();
  });

  it('turns Save into Clear schedule when every window is removed and there is no maximum nap', async () => {
    await open(schedule);
    expect(button('Save')).toBeDefined();
    (document.querySelector('[data-test="remove-window"]') as HTMLElement).click();
    await flushPromises();
    expect(button('Save')).toBeUndefined();
    expect(button('Clear schedule')!.disabled).toBe(false);
    await click('Clear schedule');
    await click('Clear');
    expect(emitted).toEqual(['clear']);
  });
});
