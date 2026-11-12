// The audit table (user request): long actions and targets cut with an ellipsis on one line, the full text in a tooltip.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import AuditView from '../src/views/AuditView.vue';
import { download } from '../src/table-export';

const TARGET = 'dmt-dev/demo-rds dmt-dev/demo-ecs dmt-dev/demo-asg arn:aws:elasticloadbalancing:eu-west-1:000000000000:targetgroup/demo/0123456789abcdef';
const OK = { id: '1', at: '2026-10-09T10:00:00.000Z', who: 'ops@example.com', role: 'operator', action: 'operation-router-upgrade', target: TARGET, result: 'ok' };
let entries: Record<string, string>[] = [OK];
vi.mock('../src/api', () => ({ api: vi.fn(async () => ({ entries: structuredClone(entries) })) }));
vi.mock('../src/table-export', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/table-export')>()), download: vi.fn() }));
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

  it('says each result\'s outcome as an icon, its word its name; an error\'s text whole in red beside it, wrapping and selectable, as before the redesign (PR #1)', async () => {
    const MESSAGE = 'AccessDenied: User: arn:aws:sts::000000000000:assumed-role/dmt-dev-manager-api/x is not authorized to perform: lambda:InvokeFunction';
    entries = [
      { ...OK, id: '2', at: '2026-10-09T11:00:00.000Z', result: `error: ${MESSAGE}` },
      { ...OK, id: '3', at: '2026-10-09T10:30:00.000Z', result: 'compute 10%, databases 20%' },
      { ...OK, id: '4', at: '2026-10-09T10:15:00.000Z', result: 'refused' },
      OK,
    ];
    wrapper = mount(AuditView, { attachTo: document.body, global: { plugins: [createVuetify({ components })] } });
    await flushPromises();
    const results = wrapper.findAll('[data-test="audit-result"]');
    expect(results.map((r) => r.find('[data-test="status-mark"]').attributes('aria-label'))).toEqual(['error', 'ok', 'refused', 'ok']);
    const [failed, done, refused, ok] = results;
    // The word "error" is the icon's; the message stays whole.
    expect(failed!.text()).toBe(MESSAGE);
    expect(failed!.classes()).toContain('text-error');
    // Not a chip (a chip's text is not selectable), not cut.
    expect(failed!.element.closest('.v-chip')).toBeNull();
    expect(failed!.find('.v-chip').exists()).toBe(false);
    expect(failed!.find('.text-truncate').exists()).toBe(false);
    expect(done!.text()).toBe('compute 10%, databases 20%');
    expect(done!.find('.text-truncate').exists()).toBe(false);
    // A result that is only its word: the icon alone.
    expect(refused!.text()).toBe('');
    expect(ok!.text()).toBe('');
    entries = [OK];
  });

  it('exports the entries newest first, each result as recorded, who with their role', async () => {
    entries = [OK, { ...OK, id: '2', at: '2026-10-09T11:00:00.000Z', who: 'admin@example.com', role: 'admin', action: 'role', target: 'ops@example.com', result: 'error: no such user' }];
    wrapper = mount(AuditView, { attachTo: document.body, global: { plugins: [createVuetify({ components })] } });
    await flushPromises();
    await wrapper.find('[data-test="dm-table-menu"]').trigger('click');
    await flushPromises();
    (document.querySelector('.v-overlay--active [data-test="dm-table-export-csv"]') as HTMLElement).click();
    await flushPromises();
    const [name, , body] = vi.mocked(download).mock.calls.at(-1)!;
    expect(name).toMatch(/^dormeto-audit-\d{4}-\d{2}-\d{2}\.csv$/);
    expect((body as string).split('\r\n')).toEqual([
      'When,Who,Action,Target,Result',
      '2026-10-09T11:00:00.000Z,admin@example.com (admin),role,ops@example.com,error: no such user',
      `2026-10-09T10:00:00.000Z,ops@example.com (operator),operation-router-upgrade,${TARGET},ok`,
      '',
    ]);
    entries = [OK];
  });
});
