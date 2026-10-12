// The audit table (user request): long actions and targets cut with an ellipsis on one line, the full text in a tooltip.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import AuditView from '../src/views/AuditView.vue';

const TARGET = 'dmt-dev/demo-rds dmt-dev/demo-ecs dmt-dev/demo-asg arn:aws:elasticloadbalancing:eu-west-1:000000000000:targetgroup/demo/0123456789abcdef';
vi.mock('../src/api', () => ({
  api: vi.fn(async () => ({ entries: [
    { id: '1', at: '2026-10-09T10:00:00.000Z', who: 'ops@example.com', role: 'operator', action: 'operation-router-upgrade', target: TARGET, result: 'ok' },
  ] })),
}));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});

let wrapper: VueWrapper | undefined;
afterEach(() => wrapper?.unmount());

describe('Audit', () => {
  it('cuts the action and the target on one line, their full text in a tooltip', async () => {
    wrapper = mount(AuditView, { attachTo: document.body, global: { plugins: [createVuetify({ components })] } });
    await flushPromises();
    const cells = wrapper.findAll('[data-test="audit-cell"]');
    expect(cells.map((c) => c.text())).toEqual(['operation-router-upgrade', TARGET]);
    for (const cell of cells) expect(cell.classes()).toContain('text-truncate');
    await cells[1]!.trigger('mouseenter');
    await nextTick();
    await sleep(300);
    expect(document.querySelector('.v-overlay-container')?.textContent).toContain(TARGET);
  });
});
