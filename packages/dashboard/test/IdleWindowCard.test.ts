// A workload's Idle window card (R10): the recommendation, every window with its bars, and what to make of them.
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import IdleWindowCard from '../src/components/IdleWindowCard.vue';
import { api } from '../src/api';
import type { IdleWindowAdvice } from '../src/types';

const MINUTES = [5, 10, 15, 20, 30, 45, 60, 90, 120];
const ADVICE: IdleWindowAdvice = {
  computedAt: '2026-10-10T12:00:00.000Z', from: '2026-09-26T12:00:00.000Z', to: '2026-10-10T12:00:00.000Z', current: 15, recommended: 10,
  checkMinutes: 5, wakeSeconds: 25, priced: true,
  windows: MINUTES.map((minutes, i) => ({ minutes, asleepHours: 22 - i, usdMonth: 40 - 4 * i, wakesPerDay: Math.max(1, 12 - 2 * i), waitSecondsPerDay: Math.max(1, 12 - 2 * i) * 25 })),
  actual: { wakes: 30, replayedWakes: 28, noisy: false }, wakerTargetGroup: true,
};
const answer: { value: unknown; fail?: string } = { value: ADVICE };
vi.mock('../src/api', () => ({ api: vi.fn(async () => { if (answer.fail) throw new Error(answer.fail); return answer.value; }) }));
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

async function mountCard(value: unknown, fail?: string) {
  answer.value = value;
  answer.fail = fail;
  const wrapper = mount(IdleWindowCard, { props: { router: 'dmt-dev', id: 'demo' }, global: { plugins: [createVuetify({ components, directives })] } });
  await flushPromises();
  return wrapper;
}

describe('IdleWindowCard', () => {
  it('says the recommendation and shows every window, the current and the recommended marked', async () => {
    const wrapper = await mountCard(ADVICE);
    expect(vi.mocked(api)).toHaveBeenCalledWith('/workloads/dmt-dev/demo/idle-window');
    expect(wrapper.text()).toContain('Recommended: 10 minutes, saves about $4.00 a month more than now, with 2 more wakes a day (about 25 seconds each)');
    const rows = wrapper.findAll('[data-test="idle-row"]');
    expect(rows).toHaveLength(9);
    expect(rows[2]!.text()).toContain('current');
    expect(rows[1]!.text()).toContain('recommended');
    expect(rows[0]!.text()).toContain('$40.00');
    // A bar per measure, each against its own column's largest value.
    expect(rows[0]!.findAll('[data-test="idle-bar"]')).toHaveLength(2);
    expect(wrapper.text()).toContain('idle_minutes');
    expect(wrapper.text()).not.toContain('requests the waker ignores');
  });

  it('notes a replay with clearly more wakes than happened, and an unknown wait', async () => {
    const wrapper = await mountCard({ ...ADVICE, wakeSeconds: null, windows: ADVICE.windows.map((w) => ({ ...w, waitSecondsPerDay: null })), actual: { wakes: 4, replayedWakes: 28, noisy: true } });
    expect(wrapper.text()).toContain('requests the waker ignores');
    expect(wrapper.text()).toContain('No wake measured yet');
  });

  it('no request in 14 days, without the waker target group, nothing priced', async () => {
    const quiet = { ...ADVICE, recommended: 5, priced: false, wakerTargetGroup: false, windows: MINUTES.map((minutes) => ({ minutes, asleepHours: 24, usdMonth: null, wakesPerDay: 0, waitSecondsPerDay: 0 })), actual: { wakes: 0, replayedWakes: 0, noisy: false } };
    const wrapper = await mountCard(quiet);
    expect(wrapper.text()).toContain('No request in 14 days');
    expect(wrapper.text()).toContain('waker target group was not found');
    expect(wrapper.text()).toContain('Asleep a day');
    expect(wrapper.text()).toContain('24 h');
  });

  it('an answer that is not an advice is said, not drawn', async () => {
    const wrapper = await mountCard({ workloadId: 'demo', state: 'AWAKE' });
    expect(wrapper.text()).toContain('The advice cannot be computed');
    expect(wrapper.findAll('[data-test="idle-row"]')).toHaveLength(0);
  });

  it('says why when the advice cannot be computed', async () => {
    const wrapper = await mountCard(null, 'discovery is busy (a discovery run uses its capacity): try again in a few minutes');
    expect(wrapper.text()).toContain('try again in a few minutes');
  });
});
