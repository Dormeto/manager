// The words of a standalone workload's onboarding and schedule (the coordinator's review of M46): short sentences in the
// dialog's list, the dashboard's link, and what wakes it said by kind.
import { describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import OnboardDialog from '../src/components/OnboardDialog.vue';
import ScheduleCard from '../src/components/ScheduleCard.vue';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});
const router = () => createRouter({ history: createMemoryHistory(), routes: [{ path: '/:rest(.*)', component: { render: () => null } }] });
const words = (text: string) => text.trim().split(/\s+/).length;

describe('onboarding a resource', () => {
  for (const resource of ['instance', 'asg', 'ecs', 'rds-instance', 'rds-cluster']) {
    it(`says what changes for ${resource} in four short items, the schedule's link in the dashboard's style`, async () => {
      setActivePinia(createPinia());
      const w = mount(OnboardDialog, { props: { modelValue: false, title: 'r', defaultName: 'r', resource: resource as never }, attachTo: document.body, global: { plugins: [createVuetify({ components, directives }), router()] } });
      await w.setProps({ modelValue: true });
      await flushPromises();
      const items = [...document.querySelectorAll('[data-test="onboard-standalone"]')].map((e) => e.textContent!.trim());
      expect(items).toHaveLength(4);
      for (const item of items) expect(words(item), item).toBeLessThanOrEqual(18);
      expect(items[2]).toBe('Nothing wakes it on demand: a schedule, a person or a start made in AWS does.');
      expect(document.querySelector('[data-test="onboard-schedule"]')!.classList.contains('dm-link')).toBe(true);
      w.unmount();
    });
  }
});

describe('a standalone workload\'s empty schedule', () => {
  it('says that only a person or a start made in AWS wakes it, an HTTP one\'s as before', () => {
    const mountCard = (standalone: boolean) => mount(ScheduleCard, { props: { schedule: null, canEdit: false, standalone }, global: { plugins: [createVuetify({ components, directives })] } });
    expect(mountCard(true).text()).toContain('No schedule: it naps when idle; only a person or a start made in AWS wakes it. A schedule keeps it awake at given hours.');
    expect(mountCard(false).text()).toContain('No schedule: the workload naps when idle and wakes on requests, at any hour.');
  });
});
