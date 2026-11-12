// Operations as a table (tables design §4): a row per operation, its status an icon alone, its steps under the row, the
// table's search, sort, pages and exports.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import { mdiAlertCircleOutline, mdiCheckCircleOutline, mdiProgressClock } from '@mdi/js';
import OperationsView from '../src/views/OperationsView.vue';
import { api } from '../src/api';
import { download } from '../src/table-export';
import { expectEveryColumnSaid } from './table-columns';

const operation = (id: string, step: string) => ({
  id, type: 'upgrade-router', target: { router: 'dmtr-dev-eu-west-3' }, input: {}, status: 'running', cursor: 1, by: 'ops@example.com',
  createdAt: '2026-10-07T06:00:00.000Z', updatedAt: '2026-10-07T06:00:00.000Z',
  // A finished step shows only in the expanded row (the progress column names the current one).
  steps: [{ name: step, status: 'done' }, { name: 'install functions', status: 'running' }],
});
// An onboarding that failed, and an offboarding running, with every fact their cells show.
const ERROR = 'AccessDenied: DmtCommandRole cannot create the listener rule';
const failed = {
  id: 'op-f', type: 'onboard', target: { account: '111122223333', region: 'eu-west-3', targetGroupArn: 'arn:aws:elasticloadbalancing:eu-west-3:111122223333:targetgroup/shop/73e2d6bc24d8a067' },
  input: { name: 'Shop' }, status: 'failed', cursor: 2, by: 'ops@example.com', createdAt: '2026-10-07T05:00:00.000Z', updatedAt: '2026-10-07T05:02:00.000Z',
  finishedAt: '2026-10-07T05:02:00.000Z', error: ERROR,
  steps: [{ name: 'find router', status: 'done', detail: 'dmtr-dev-eu-west-3 0.40.0' }, { name: 'lock router', status: 'skipped' },
    { name: 'add rule', status: 'failed', detail: ERROR, attempts: 3 }, { name: 'onboard', status: 'pending' }],
};
const running = {
  id: 'op-r', type: 'offboard', target: { account: '111122223333', region: 'eu-west-1', router: 'dmt-dev', workloadId: '7010ea54b5c02245' }, input: {},
  context: { name: 'Paris' }, status: 'running', cursor: 1, by: 'ann@example.com', createdAt: '2026-10-07T07:00:00.000Z', updatedAt: '2026-10-07T07:01:00.000Z',
  steps: [{ name: 'find router', status: 'done' }, { name: 'remove rule', status: 'running', detail: 'waiting for the lock' }, { name: 'forget workload', status: 'pending' }],
};
// jsdom has no ResizeObserver nor visualViewport, which the Vuetify table and overlays use.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const initial = [operation('op-1', 'step of the first'), operation('op-2', 'step of the second')];
let operations: Record<string, unknown>[] = initial;
vi.mock('../src/api', () => ({ api: vi.fn(async () => ({ operations: structuredClone(operations) })) }));
vi.mock('../src/table-export', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/table-export')>()), download: vi.fn() }));
afterEach(() => {
  operations = initial;
  document.body.innerHTML = '';
});

type View = Awaited<ReturnType<typeof mountView>>;
let router: ReturnType<typeof createRouter>;
async function mountView(path = '/operations') {
  const pinia = createPinia();
  setActivePinia(pinia);
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/operations', component: OperationsView }] });
  await router.push(path);
  const wrapper = mount(OperationsView, { attachTo: document.body, global: { plugins: [createVuetify({ components }), pinia, router] } });
  await flushPromises();
  return wrapper;
}
// The operations' rows (not their expanded parts), their ids, and a column's cell by its title.
const rows = (wrapper: View) => wrapper.findAll('.dm-operations tbody tr').filter((tr) => tr.find('.dm-op__id').exists());
const ids = (wrapper: View) => rows(wrapper).map((tr) => tr.find('.dm-op__id').text());
const rowOf = (wrapper: View, id: string) => rows(wrapper).find((tr) => tr.find('.dm-op__id').text() === id)!;
const cellOf = (wrapper: View, id: string, column: string) => {
  const titles = wrapper.findAll('.dm-operations thead th').map((th) => th.text());
  return rowOf(wrapper, id).findAll('td')[titles.indexOf(column)]!;
};
const toggle = async (wrapper: View, id: string) => {
  await rowOf(wrapper, id).find('[data-test="dm-row-expand"]').trigger('click');
  await flushPromises();
};
// The expanded part under an operation's row: the one its toggle names (aria-controls); none while it is closed.
const stepsOf = (wrapper: View, id: string) => wrapper.find(`[id="${rowOf(wrapper, id).find('[data-test="dm-row-expand"]').attributes('aria-controls')}"]`);
// Until a condition holds (a tooltip shown, then gone), 2 s at most.
async function until(test: () => boolean) {
  for (const end = Date.now() + 2000; !test(); await sleep(10)) if (Date.now() > end) throw new Error('timed out');
}
const icon = (el: { findComponent: (s: { name: string }) => { props: (k: string) => unknown } }) => el.findComponent({ name: 'VIcon' }).props('icon');
// The tooltip an element names (aria-describedby), while it is open.
const tooltipOf = (el: Element) => {
  const overlay = document.getElementById(el.getAttribute('aria-describedby') ?? '');
  return overlay?.classList.contains('v-overlay--active') ? overlay.querySelector('.v-overlay__content') : null;
};
// A tooltip opened by the keyboard's focus, as its lines (a mark's word first), then closed by the focus moving on (a blur to
// nothing keeps a Vuetify tooltip open).
async function tip(el: { element: Element }): Promise<string[]> {
  const target = el.element as HTMLElement;
  target.focus();
  await nextTick();
  await until(() => Boolean(tooltipOf(target)));
  const content = tooltipOf(target)!;
  const lines = content.children.length ? [...content.children].map((line) => line.textContent!.replace(/\s+/g, ' ').trim()) : [content.textContent!.trim()];
  const away = document.body.appendChild(document.createElement('button'));
  away.focus();
  await until(() => !tooltipOf(target));
  away.remove();
  return lines;
}
async function exportCsv(wrapper: View): Promise<string[]> {
  await wrapper.find('.dm-operations [data-test="dm-table-menu"]').trigger('click');
  await flushPromises();
  (document.querySelector('.v-overlay--active [data-test="dm-table-export-csv"]') as HTMLElement).click();
  await flushPromises();
  const [name, , body] = vi.mocked(download).mock.calls.at(-1)!;
  expect(name).toMatch(/^dormeto-operations-\d{4}-\d{2}-\d{2}\.csv$/);
  return (body as string).split('\r\n').slice(0, -1);
}

describe('Operations view', () => {
  it('opens the operation a link names, with its steps', async () => {
    const wrapper = await mountView('/operations?id=op-2');
    expect(wrapper.text()).toContain('step of the second');
    expect(wrapper.text()).not.toContain('step of the first');
    expect(rowOf(wrapper, 'op-2').find('[data-test="dm-row-expand"]').attributes('aria-expanded')).toBe('true');
    expect(rowOf(wrapper, 'op-1').find('[data-test="dm-row-expand"]').attributes('aria-expanded')).toBe('false');
    wrapper.unmount();
  });

  it('names each row\'s toggle by the operation\'s title and id, so two of one title differ, and the toggle names the part it opens', async () => {
    const target = { account: '111122223333', region: 'eu-west-3', router: 'dmtr-dev-eu-west-3' };
    operations = [{ ...operation('op-1', 'first step'), target }, { ...operation('op-2', 'second step'), target }];
    const wrapper = await mountView();
    const toggles = ['op-1', 'op-2'].map((id) => rowOf(wrapper, id).find('[data-test="dm-row-expand"]'));
    const title = 'Upgrade the router of 111122223333/eu-west-3';
    expect(toggles.map((t) => t.attributes('aria-label'))).toEqual([`Steps of ${title} (op-1)`, `Steps of ${title} (op-2)`]);
    expect(toggles[0]!.attributes('aria-controls')).not.toBe(toggles[1]!.attributes('aria-controls'));
    await toggle(wrapper, 'op-2');
    // The part the toggle names: the second one's steps, its list named the same way.
    const part = document.getElementById(toggles[1]!.attributes('aria-controls')!)!;
    expect(part.textContent).toContain('second step');
    expect(part.textContent).not.toContain('first step');
    expect(part.querySelector('ol')!.getAttribute('aria-label')).toBe(`Steps of ${title} (op-2)`);
    wrapper.unmount();
  });

  it('opens the operation a link names on the page that holds it, and a link followed while on Operations opens its row', async () => {
    // 60 operations, newest first: op-05 is the 55th, on the second page of 50.
    operations = Array.from({ length: 60 }, (_, i) => ({ ...operation(`op-${String(i).padStart(2, '0')}`, `step ${i}`), createdAt: new Date(Date.UTC(2026, 9, 7, 0, i)).toISOString() }));
    const wrapper = await mountView('/operations?id=op-05');
    expect(ids(wrapper)).toContain('op-05');
    expect(ids(wrapper)).toHaveLength(10);
    expect(stepsOf(wrapper, 'op-05').text()).toContain('step 5');
    // Followed from a toast while here: that row opens on its page, the other stays open.
    await router.push('/operations?id=op-58');
    await flushPromises();
    expect(ids(wrapper)).toContain('op-58');
    expect(rowOf(wrapper, 'op-58').find('[data-test="dm-row-expand"]').attributes('aria-expanded')).toBe('true');
    expect(stepsOf(wrapper, 'op-58').text()).toContain('step 58');
    wrapper.unmount();
  });

  it('shows a row per operation: the kind and title, the target and the id, the status as its icon alone, the progress and the current step, by whom, when', async () => {
    operations = [running, failed];
    const wrapper = await mountView();
    expect(wrapper.findAll('.dm-operations thead th').map((th) => th.text())).toEqual(['Operation', 'Target', 'Status', 'Progress', 'By', 'Started', 'Steps', 'Actions']);
    expect(ids(wrapper)).toEqual(['op-r', 'op-f']);
    expect(cellOf(wrapper, 'op-r', 'Operation').find('.dm-op__kind').text()).toBe('offboard');
    expect(cellOf(wrapper, 'op-r', 'Operation').find('.dm-op__title').text()).toBe('Offboard Paris from dmt-dev');
    expect(cellOf(wrapper, 'op-r', 'Target').text()).toMatch(/111122223333.*eu-west-1.*dmt-dev.*op-r/);
    // The status: no word in its cell, the word its icon's name; the running one breathes.
    for (const [id, word, mark, color] of [['op-r', 'running', mdiProgressClock, 'text-primary'], ['op-f', 'failed', mdiAlertCircleOutline, 'text-error']] as const) {
      const status = cellOf(wrapper, id, 'Status');
      expect(status.text()).toBe('');
      const el = status.find('[data-test="status-mark"]');
      expect(el.attributes()).toMatchObject({ 'aria-label': word, role: 'img', tabindex: '0' });
      expect(el.classes()).toContain(color);
      expect(icon(status)).toBe(mark);
    }
    expect(cellOf(wrapper, 'op-r', 'Status').find('[data-test="status-mark"]').classes()).toContain('dm-status--pulse');
    expect(cellOf(wrapper, 'op-f', 'Status').find('[data-test="status-mark"]').classes()).not.toContain('dm-status--pulse');
    // The bar and done/total, the step running under it.
    const progress = cellOf(wrapper, 'op-r', 'Progress');
    expect(progress.find('[role="progressbar"]').attributes('aria-label')).toBe('1 of 3 steps');
    expect(progress.find('.dm-op__count').text()).toBe('1/3');
    expect(progress.find('.dm-op__current').text()).toBe('remove rule: waiting for the lock');
    expect(cellOf(wrapper, 'op-f', 'Progress').find('.dm-op__count').text()).toBe('2/4');
    expect(cellOf(wrapper, 'op-f', 'Progress').find('.dm-op__current').exists()).toBe(false);
    expect(cellOf(wrapper, 'op-r', 'By').text()).toBe('ann@example.com');
    // When it started: relative, the exact time in a tooltip a keyboard opens too.
    const started = cellOf(wrapper, 'op-r', 'Started').find('time');
    expect(started.text()).toMatch(/ ago$/);
    expect(started.attributes()).toMatchObject({ datetime: '2026-10-07T07:00:00.000Z', tabindex: '0' });
    expect((await tip(started)).join(' ')).toMatch(/Oct 7, 2026/);
    // No row has an action: no row "⋮", the header's holds the exports.
    expect(wrapper.find('[data-test="dm-row-menu"]').exists()).toBe(false);
    expect(wrapper.find('.dm-operations thead [data-test="dm-table-menu"]').attributes('aria-label')).toBe('Table actions');
    wrapper.unmount();
  });

  it('says a failed operation\'s error in its status\' tooltip and under its row; a succeeded one\'s check', async () => {
    operations = [failed, { ...running, id: 'op-s', status: 'succeeded', cursor: 3, steps: running.steps.map((s) => ({ ...s, status: 'done' })) }];
    const wrapper = await mountView();
    expect(await tip(cellOf(wrapper, 'op-f', 'Status').find('[data-test="status-mark"]'))).toEqual(['failed', ERROR]);
    const ok = cellOf(wrapper, 'op-s', 'Status');
    expect(ok.find('[data-test="status-mark"]').attributes('aria-label')).toBe('succeeded');
    expect(icon(ok)).toBe(mdiCheckCircleOutline);
    expect(await tip(ok.find('[data-test="status-mark"]'))).toEqual(['succeeded']);
    // The error is in none of the row's cells, but under it once opened.
    expect(rowOf(wrapper, 'op-f').text()).not.toContain(ERROR);
    await toggle(wrapper, 'op-f');
    expect(stepsOf(wrapper, 'op-f').find('.dm-op__error').text()).toBe(ERROR);
    wrapper.unmount();
  });

  it('shows the steps under the row: each one\'s mark an icon named by its status, no status word beside it, its name, attempts and detail', async () => {
    operations = [failed];
    const wrapper = await mountView();
    expect(stepsOf(wrapper, 'op-f').exists()).toBe(false);
    await toggle(wrapper, 'op-f');
    const steps = stepsOf(wrapper, 'op-f').findAll('.dm-step');
    expect(steps.map((s) => s.find('[data-test="status-mark"]').attributes('aria-label'))).toEqual(['done', 'skipped', 'failed', 'pending']);
    expect(steps.map((s) => s.find('[data-test="status-mark"]').attributes('tabindex'))).toEqual(['0', '0', '0', '0']);
    expect(steps.map((s) => s.find('.dm-step__line').text().replace(/\s+/g, ' '))).toEqual(['find router', 'lock router', 'add rule (3 attempts)', 'onboard']);
    expect(steps[0]!.find('.dm-step__detail').text()).toBe('dmtr-dev-eu-west-3 0.40.0');
    expect(steps[2]!.find('.dm-step__detail').text()).toBe(ERROR);
    expect(await tip(steps[2]!.find('[data-test="status-mark"]'))).toEqual(['failed']);
    // Closed again by its toggle.
    await toggle(wrapper, 'op-f');
    expect(stepsOf(wrapper, 'op-f').exists()).toBe(false);
    wrapper.unmount();
  });

  it('keeps an open row open when the list refreshes', async () => {
    operations = [running, failed];
    const wrapper = await mountView();
    await toggle(wrapper, 'op-r');
    expect(stepsOf(wrapper, 'op-r').exists()).toBe(true);
    const asked = vi.mocked(api).mock.calls.length;
    operations = [{ ...running, steps: running.steps.map((s, i) => (i === 1 ? { ...s, detail: 'removing the rule' } : s)) }, failed];
    await wrapper.find('[aria-label="Refresh now"]').trigger('click');
    await flushPromises();
    expect(vi.mocked(api).mock.calls.length).toBe(asked + 1);
    expect(stepsOf(wrapper, 'op-r').text()).toContain('removing the rule');
    expect(rowOf(wrapper, 'op-r').find('[data-test="dm-row-expand"]').attributes('aria-expanded')).toBe('true');
    expect(stepsOf(wrapper, 'op-f').exists()).toBe(false);
    wrapper.unmount();
  });

  it('sorts newest first by default; on its headers by kind then title, status, whom and when it started: ascending, descending, then as the API lists them', async () => {
    // Not newest first, as the API lists them.
    operations = [
      { ...operation('op-b', 'x'), type: 'install-router', target: { account: '2', region: 'eu-west-3' }, status: 'failed', by: 'carl@example.com', createdAt: '2026-10-07T07:00:00.000Z' },
      { ...operation('op-c', 'x'), type: 'install-router', target: { account: '1', region: 'eu-west-3' }, status: 'running', by: 'bea@example.com', createdAt: '2026-10-07T08:00:00.000Z' },
      { ...operation('op-a', 'x'), type: 'connect-account', target: { account: '3' }, input: { regions: ['eu-west-1'] }, status: 'succeeded', by: 'ann@example.com', createdAt: '2026-10-07T06:00:00.000Z' },
    ];
    const wrapper = await mountView();
    const header = (title: string) => wrapper.findAll('.dm-operations thead th').find((th) => th.text() === title)!;
    const sort = async (title: string) => {
      await header(title).find('.v-data-table-header__content').trigger('click');
      await flushPromises();
    };
    expect(ids(wrapper)).toEqual(['op-c', 'op-b', 'op-a']);
    expect(header('Started').attributes('aria-sort')).toBe('descending');
    await sort('By');
    expect(ids(wrapper)).toEqual(['op-a', 'op-c', 'op-b']);
    expect(header('By').attributes('aria-sort')).toBe('ascending');
    await sort('By');
    expect(ids(wrapper)).toEqual(['op-b', 'op-c', 'op-a']);
    await sort('By');
    expect(ids(wrapper)).toEqual(['op-b', 'op-c', 'op-a']);
    expect(header('By').attributes('aria-sort')).toBeUndefined();
    await sort('Started');
    expect(ids(wrapper)).toEqual(['op-a', 'op-b', 'op-c']);
    await sort('Status');
    expect(ids(wrapper)).toEqual(['op-b', 'op-c', 'op-a']);
    expect(header('Status').attributes('aria-sort')).toBe('ascending');
    // By kind ("connect account" before "install router"), then by title ("…in 1/…" before "…in 2/…").
    await sort('Operation');
    expect(ids(wrapper)).toEqual(['op-a', 'op-c', 'op-b']);
    await sort('Operation');
    expect(ids(wrapper)).toEqual(['op-b', 'op-c', 'op-a']);
    // The target and the progress are not sorted.
    expect(header('Target').classes()).not.toContain('v-data-table__th--sortable');
    expect(header('Progress').classes()).not.toContain('v-data-table__th--sortable');
    wrapper.unmount();
  });

  it('pages 50 operations by default, as every table, and as many as chosen', async () => {
    operations = Array.from({ length: 60 }, (_, i) => operation(`op-${String(i).padStart(2, '0')}`, 'x'));
    const wrapper = await mountView();
    expect(ids(wrapper)).toHaveLength(50);
    expect(wrapper.find('.dm-operations .v-data-table-footer').exists()).toBe(true);
    const perPage = wrapper.findComponent({ name: 'VDataTableFooter' }).findComponent({ name: 'VSelect' });
    await perPage.setValue(25);
    await flushPromises();
    expect(ids(wrapper)).toHaveLength(25);
    await perPage.setValue(-1);
    await flushPromises();
    expect(ids(wrapper)).toHaveLength(60);
    wrapper.unmount();
  });

  it('searches what the columns say: an id, a status\' word, a region, a failure\'s error', async () => {
    operations = [running, failed];
    const wrapper = await mountView();
    const search = async (text: string) => {
      await wrapper.find('.dm-operations [data-test="dm-table-search"] input').setValue(text);
      await flushPromises();
      return ids(wrapper);
    };
    expect(await search('op-f')).toEqual(['op-f']);
    expect(await search('running')).toEqual(['op-r']);
    expect(await search('eu-west-1')).toEqual(['op-r']);
    expect(await search('AccessDenied')).toEqual(['op-f']);
    wrapper.unmount();
  });

  it('exports the operations, not their steps, newest first, each column in words: the status\' word and a failure\'s error, the progress and the current step, the date as ISO 8601', async () => {
    operations = [failed, running];
    const wrapper = await mountView('/operations?id=op-f');
    expect(await exportCsv(wrapper)).toEqual([
      'Operation,Target,Status,Progress,By,Started',
      'offboard · Offboard Paris from dmt-dev,111122223333 · eu-west-1 · dmt-dev · op-r,running,1/3 · remove rule: waiting for the lock,ann@example.com,2026-10-07T07:00:00.000Z',
      `onboard · Onboard shop as Shop,111122223333 · eu-west-3 · op-f,failed: ${ERROR},2/4,ops@example.com,2026-10-07T05:00:00.000Z`,
    ]);
    expectEveryColumnSaid(wrapper, 'operations', (items: { id: string }[]) => items.find((o) => o.id === 'op-r')!);
    wrapper.unmount();
  });

  it('says when there is no operation yet, under the page\'s lead', async () => {
    operations = [];
    const wrapper = await mountView();
    expect(wrapper.find('.dm-operations').text()).toContain('No operation yet: onboardings, offboardings and router installations show here.');
    expect(wrapper.text()).toContain('Onboardings, offboardings and router installations, run step by step');
    wrapper.unmount();
  });

  it('shows a manager update as such: its kind, "manager <version>", and the link to its build in CodeBuild under its row', async () => {
    const url = 'https://eu-west-1.console.aws.amazon.com/codesuite/codebuild/121014831971/projects/dmt-dev-install/build/dmt-dev-install%3Ab2/?region=eu-west-1';
    const update = (id: string, context: Record<string, unknown>) => ({
      id, type: 'update-manager', target: { account: '121014831971', region: 'eu-west-1', version: '0.13.0' }, input: { action: 'apply', version: '0.13.0', request: 'r', planBuild: 'p' },
      status: 'succeeded', cursor: 0, by: 'admin@example.com', createdAt: '2026-10-18T10:00:00.000Z', updatedAt: '2026-10-18T10:09:00.000Z', finishedAt: '2026-10-18T10:09:00.000Z',
      steps: [{ name: 'Apply manager 0.13.0', status: 'done' }], context,
    });
    operations = [update('op-u', { build: 'dmt-dev-install:b2', consoleUrl: url })];
    const wrapper = await mountView();
    expect(wrapper.find('.dm-op__kind').text()).toBe('Manager update');
    expect(wrapper.find('.dm-op__title').text()).toBe('Update the manager to 0.13.0');
    expect(cellOf(wrapper, 'op-u', 'Target').text()).toContain('manager 0.13.0');
    expect(wrapper.text()).not.toContain('View the build in CodeBuild');
    await toggle(wrapper, 'op-u');
    const link = stepsOf(wrapper, 'op-u').findAll('a').find((a) => a.text() === 'View the build in CodeBuild')!;
    expect(link.attributes()).toMatchObject({ href: url, target: '_blank', rel: 'noopener' });
    wrapper.unmount();
    // None before its build is known, nor for a link that is not https.
    operations = [update('op-a', {}), update('op-b', { build: 'b', consoleUrl: 'javascript:alert(1)' })];
    const without = await mountView();
    await toggle(without, 'op-a');
    await toggle(without, 'op-b');
    expect(stepsOf(without, 'op-a').exists()).toBe(true);
    expect(without.text()).not.toContain('View the build in CodeBuild');
    without.unmount();
  });

  it('links no other operation to CodeBuild', async () => {
    operations = [{ ...operation('op-1', 'x'), context: { consoleUrl: 'https://eu-west-1.console.aws.amazon.com/x' } }];
    const wrapper = await mountView('/operations?id=op-1');
    expect(stepsOf(wrapper, 'op-1').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('View the build in CodeBuild');
    expect(wrapper.find('.dm-op__kind').text()).toBe('upgrade router');
    wrapper.unmount();
  });
});
