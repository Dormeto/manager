// A standalone candidate's idle share (vision standalone workloads design §4, §6): hours with its default signals under their
// thresholds at every 5-minute point, from CloudWatch's metrics of the resource; no request is counted.
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import IdleBar from '../src/components/IdleBar.vue';
import { idleText } from '../src/discovery';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// jsdom has no ResizeObserver nor visualViewport, which the Vuetify overlays use to position their content.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1024, height: 768, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});
let wrapper: VueWrapper | undefined;
afterEach(() => wrapper?.unmount());

describe('a standalone candidate\'s idle share', () => {
  it('says which signal was under, a server\'s CPU or a database\'s connections', () => {
    expect(idleText({ idleHours7d: 154, requests7d: null, resource: 'instance' })).toEqual({
      title: 'Idle 92 % of the last 7 days',
      detail: '154 of 168 hours with its CPU under 5 % at every 5-minute point.',
      source: 'From CloudWatch\'s metrics of the resource, the default idle signals of its type (its CPU; a database\'s connections), read by discovery: no onboarding needed. An hour with a missing point is not idle, and a resource stopped all week has no share.',
    });
    expect(idleText({ idleHours7d: 10, requests7d: null, resource: 'rds-cluster' }).detail).toBe('10 of 168 hours with no database connection at every 5-minute point.');
    // An HTTP candidate's, as before.
    expect(idleText({ idleHours7d: 154, requests7d: 1 })).not.toHaveProperty('source');
  });

  it('shows the bar with the standalone words in its tooltip', async () => {
    wrapper = mount(IdleBar, { props: { idleHours7d: 154, requests7d: null, resource: 'ecs' }, attachTo: document.body, global: { plugins: [createVuetify({ components })] } });
    await wrapper.find('.idle-bar').trigger('mouseenter');
    await nextTick();
    await sleep(300);
    const tip = document.querySelector('.v-overlay-container')?.textContent ?? '';
    expect(tip).toContain('154 of 168 hours with its CPU under 5 %');
    expect(tip).toContain('the default idle signals of its type');
    expect(tip).not.toContain('request');
  });
});
