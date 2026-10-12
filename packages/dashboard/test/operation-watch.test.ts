import { describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { operationWatch } from '../src/operation-watch';
import type { Notice } from '../src/components/NoticeAlert.vue';

const ended: Record<string, { status: string; error?: string }> = { 'op-1': { status: 'succeeded' }, 'op-2': { status: 'failed', error: 'verify: route app' }, 'op-3': { status: 'running' } };
const asked: string[] = [];
vi.mock('../src/api', () => ({
  api: vi.fn(async (path: string) => {
    asked.push(path);
    return ended[path.slice('/operations/'.length)];
  }),
}));

describe('operation watch', () => {
  it('tells how an operation it saw running ended, once, with its operation', async () => {
    const told: Notice[] = [];
    const watch = operationWatch((n) => told.push(n));
    watch.refreshed([{ id: 'op-1', type: 'onboard', subject: 'ligoj-ui-prod' }, { id: 'op-2', type: 'upgrade-router', subject: 'dmtr-dev-eu-west-3' }]);
    expect(watch.active).toBe(true);
    watch.refreshed([]);
    watch.refreshed([]);
    await flushPromises();
    expect(told).toEqual([
      { type: 'success', text: 'Onboarding of ligoj-ui-prod succeeded.', operation: 'op-1' },
      { type: 'error', text: 'Upgrade of dmtr-dev-eu-west-3 failed: verify: route app.', operation: 'op-2' },
    ]);
    expect(asked.filter((p) => p === '/operations/op-1')).toHaveLength(1);
    expect(watch.active).toBe(false);
  });

  it('keeps the name an operation was started with (an onboarding under another name than its target group)', async () => {
    const told: Notice[] = [];
    const watch = operationWatch((n) => told.push(n));
    watch.watch('op-1', 'onboard', 'Ligoj UI');
    watch.refreshed([{ id: 'op-1', type: 'onboard', subject: 'ligoj-ui-prod' }]);
    watch.refreshed([]);
    await flushPromises();
    expect(told.map((n) => n.text)).toEqual(['Onboarding of Ligoj UI succeeded.']);
  });

  it('tells nothing of an operation still running that a refresh missed', async () => {
    const told: Notice[] = [];
    const watch = operationWatch((n) => told.push(n));
    watch.watch('op-3', 'offboard', 'shop');
    watch.refreshed([]);
    await flushPromises();
    expect(told).toEqual([]);
  });
});
