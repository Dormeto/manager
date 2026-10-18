import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useUpdateBadge } from '../src/stores/update';
import type { UpdateState } from '../src/update';

const h = vi.hoisted(() => ({ calls: [] as string[], answer: (() => ({ count: 2 })) as () => unknown }));
vi.mock('../src/api', () => ({
  api: vi.fn(async (path: string) => {
    h.calls.push(path);
    return h.answer();
  }),
}));

const state = (versions: string[]): UpdateState => ({
  installedWithCli: true, version: '0.11.0', applied: null, cli: '0.12.0', build: null, pending: null, plan: null,
  versions: versions.map((version) => ({ version, router: null, minCli: null, published: null })),
});

beforeEach(() => {
  setActivePinia(createPinia());
  h.calls.length = 0;
  h.answer = () => ({ count: 2 });
});

describe('the Update badge', () => {
  it('counts the versions available', async () => {
    const badge = useUpdateBadge();
    expect(badge.count).toBe(0);
    await badge.refresh();
    expect(h.calls).toEqual(['/update/available']);
    expect(badge.count).toBe(2);
  });

  it('keeps the last count when a refresh fails, or answers something else', async () => {
    const badge = useUpdateBadge();
    await badge.refresh();
    h.answer = () => { throw new Error('Failed to fetch'); };
    await badge.refresh();
    expect(badge.count).toBe(2);
    h.answer = () => ({});
    await badge.refresh();
    expect(badge.count).toBe(2);
  });

  it('follows a state the Update page loaded', () => {
    const badge = useUpdateBadge();
    badge.fromState(state(['0.13.0', '0.12.0', '0.12.1-dev.1']));
    expect(badge.count).toBe(3);
    badge.fromState(state([]));
    expect(badge.count).toBe(0);
    badge.count = 2;
    badge.fromState({ installedWithCli: false, version: '0.11.0' });
    expect(badge.count).toBe(0);
  });
});
