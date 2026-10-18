import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import UpdateView from '../src/views/UpdateView.vue';
import { useUpdateBadge } from '../src/stores/update';
import type { Section, UpdateState } from '../src/update';

const h = vi.hoisted(() => ({
  calls: [] as [string, string, string | undefined][],
  answer: (() => ({})) as (path: string, init?: RequestInit) => unknown,
}));
vi.mock('../src/api', () => ({
  api: vi.fn(async (path: string, init?: RequestInit) => {
    h.calls.push([init?.method ?? 'GET', path, init?.body as string | undefined]);
    return h.answer(path, init);
  }),
}));
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});

const REASON = 'run `dormeto install` with the CLI 0.2.0 or later';
const state = (over: Partial<UpdateState> = {}): UpdateState => ({
  installedWithCli: true, version: '0.11.0', applied: { version: '0.11.0', build: 'dmt-dev-install:b1', at: '2026-10-01T10:00:00Z' }, cli: '0.12.0',
  versions: [
    { version: '0.13.0', router: '0.30.0', minCli: '0.2.0', published: '2026-10-15T10:00:00Z' },
    { version: '0.12.0', router: '0.29.0', minCli: '0.9.0', published: '2026-10-10T10:00:00Z', disabled: REASON },
  ],
  env: 'dev', region: 'eu-west-1', build: null, pending: null, plan: null, ...over,
});
const sections: Section[] = [
  { version: '0.13.0', notes: '## 0.13.0 — 2026-10-15\n\n- Adds the Update page.', access: 'a new permission is needed', accessNeeded: true },
  { version: '0.12.0', notes: null, access: null, accessNeeded: false },
];
const running = (over = {}) => state({
  build: { id: 'b2', by: 'dashboard', action: 'apply', version: '0.13.0', status: 'IN_PROGRESS', phase: 'BUILD', startedAt: null, endedAt: null, steps: ['download', 'apply'], tail: [], consoleUrl: null, ...over },
});

let wrapper: VueWrapper;
const mountView = async () => {
  const pinia = createPinia();
  setActivePinia(pinia);
  wrapper = mount(UpdateView, { attachTo: document.body, global: { plugins: [createVuetify({ components }), pinia] } });
  await flushPromises();
};
const button = (label: string) => wrapper.findAll('button').find((b) => b.text().trim() === label || b.text().trim().startsWith(`${label} `))!;
const select = async (version: string) => {
  wrapper.findComponent({ name: 'VSelect' }).vm.$emit('update:modelValue', version);
  await flushPromises();
};

beforeEach(() => {
  h.calls.length = 0;
  h.answer = (path) => (path.startsWith('/update/changes') ? sections : state());
});
afterEach(() => {
  wrapper.unmount();
  vi.useRealTimers();
});

describe('Update', () => {
  it('shows the running version, its last apply and the versions on offer', async () => {
    await mountView();
    expect(wrapper.text()).toContain('0.11.0');
    expect(wrapper.text()).toContain('last applied 0.11.0');
    await wrapper.find('.v-field').trigger('mousedown');
    await flushPromises();
    const menu = document.body.textContent ?? '';
    expect(menu).toContain('0.13.0');
    expect(menu).toContain('router 0.30.0');
    // A version this install cannot update to is listed, with its reason, the backticked part as code.
    expect(menu).toContain('run dormeto install with the CLI 0.2.0 or later');
    expect([...document.querySelectorAll('.v-list code')].map((c) => c.textContent)).toContain('dormeto install');
  });

  it('says "Up to date" when nothing is newer', async () => {
    h.answer = () => state({ versions: [] });
    await mountView();
    expect(wrapper.text()).toContain('Up to date');
    expect(wrapper.text()).not.toContain('could not be read');
    expect(wrapper.findComponent({ name: 'VSelect' }).exists()).toBe(false);
  });

  it('says the releases could not be read instead of "Up to date", and still offers the staged release', async () => {
    h.answer = () => state({ versions: [], releasesUnreachable: true });
    await mountView();
    expect(wrapper.text()).toContain('The releases could not be read: try again later.');
    expect(wrapper.text()).not.toContain('Up to date');
    expect(wrapper.findComponent({ name: 'VSelect' }).exists()).toBe(false);
    wrapper.unmount();
    h.answer = () => state({ versions: [{ version: '0.13.0-dev.1', router: null, minCli: null, published: null, staged: true }], releasesUnreachable: true });
    await mountView();
    expect(wrapper.text()).toContain('The releases could not be read: try again later.');
    expect(wrapper.findComponent({ name: 'VSelect' }).exists()).toBe(true);
  });

  it('loads the release changes of the selected version, with the Access alert and "Release notes unavailable"', async () => {
    await mountView();
    await select('0.13.0');
    expect(h.calls).toContainEqual(['GET', '/update/changes?to=0.13.0', undefined]);
    expect(wrapper.text()).toContain('Adds the Update page.');
    expect(wrapper.text()).not.toContain('2026-10-15');
    expect(wrapper.text()).toContain('Release notes unavailable');
    const alert = wrapper.find('.v-alert');
    expect(alert.text()).toContain('a new permission is needed');
    expect(alert.text()).toContain('does not apply');
    expect(alert.find('a').attributes('href')).toBe('https://dormeto.com/organization-access.html');
    expect(wrapper.findAll('.v-alert')).toHaveLength(1);
  });

  it('prepares a plan, shows its counts and addresses, then confirms that plan', async () => {
    await mountView();
    expect(button('Prepare').attributes('disabled')).toBeDefined();
    await select('0.13.0');
    h.answer = (path) => (path.startsWith('/update/changes') ? sections : state());
    await button('Prepare').trigger('click');
    await flushPromises();
    expect(h.calls).toContainEqual(['POST', '/update/plan', JSON.stringify({ version: '0.13.0' })]);

    h.answer = (path) => (path.startsWith('/update/changes') ? sections : state({
      plan: { build: 'dmt-dev-install:p1', version: '0.13.0', summary: { add: 2, change: 3, destroy: 1, replaced: ['aws_lambda_function.api'], destroyed: ['aws_sqs_queue.old'] } },
    }));
    wrapper.unmount();
    await mountView();
    await select('0.13.0');
    expect(wrapper.text()).toMatch(/2\s*to add/);
    expect(wrapper.text()).toMatch(/3\s*to change/);
    expect(wrapper.text()).toMatch(/1\s*to destroy/);
    expect(wrapper.text()).toContain('aws_lambda_function.api');
    expect(wrapper.text()).toContain('aws_sqs_queue.old');
    await button('Confirm').trigger('click');
    await flushPromises();
    expect(h.calls).toContainEqual(['POST', '/update/apply', JSON.stringify({ planBuild: 'dmt-dev-install:p1' })]);
  });

  it('says a plan that changes nothing, and keeps Confirm available', async () => {
    h.answer = () => state({ plan: { build: 'dmt-dev-install:p1', version: '0.13.0', summary: { add: 0, change: 0, destroy: 0, replaced: [], destroyed: [] } } });
    await mountView();
    expect(wrapper.text()).toContain('This plan changes nothing.');
    expect(button('Confirm').attributes('disabled')).toBeUndefined();
  });

  it('ties Confirm to its plan: named by the plan\'s version, disabled when another version is picked', async () => {
    h.answer = (path) => (path.startsWith('/update/changes') ? sections : state({
      plan: { build: 'dmt-dev-install:p1', version: '0.13.0', summary: { add: 1, change: 0, destroy: 0, replaced: [], destroyed: [] } },
    }));
    await mountView();
    expect(button('Confirm').text()).toBe('Confirm 0.13.0');
    await select('0.12.0');
    expect(button('Confirm').attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toContain('The plan was prepared for 0.13.0: prepare 0.12.0 to update to it, or pick 0.13.0 again.');
    await select('0.13.0');
    expect(button('Confirm').attributes('disabled')).toBeUndefined();
    expect(wrapper.text()).not.toContain('The plan was prepared for');
  });

  it('refreshes the state after a refused request, and shows the API\'s message', async () => {
    let calls = 0;
    h.answer = (path, init) => {
      if (init?.method === 'POST') throw new Error('an update is already running');
      if (path.startsWith('/update/changes')) return sections;
      calls += 1;
      return calls === 1 ? state() : running();
    };
    await mountView();
    await select('0.13.0');
    expect(button('Prepare').attributes('disabled')).toBeUndefined();
    await button('Prepare').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('an update is already running');
    expect(calls).toBe(2);
    expect(button('Prepare').attributes('disabled')).toBeDefined();
  });

  it('drops an older answer landing after a newer one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const slow: Array<(v: unknown) => void> = [];
    let n = 0;
    h.answer = (path, init) => {
      if (path.startsWith('/update/changes')) return sections;
      if (init?.method === 'POST') throw new Error('refused');
      n += 1;
      if (n === 1) return state();
      if (n === 2) return new Promise((resolve) => slow.push(resolve));
      return state({ version: '0.12.5' });
    };
    await mountView();
    await select('0.13.0');
    await vi.advanceTimersByTimeAsync(60_000); // the poll whose answer is slow
    await button('Prepare').trigger('click'); // refused, then read again: the newer answer
    await flushPromises();
    expect(wrapper.text()).toContain('The manager now runs 0.12.5.');
    slow[0]!(state({ version: '0.99.0' }));
    await flushPromises();
    expect(wrapper.text()).toContain('0.12.5');
    expect(wrapper.text()).not.toContain('0.99.0');
  });

  it('disables both buttons while a build runs, and lists its steps', async () => {
    h.answer = () => running();
    await mountView();
    await select('0.13.0');
    expect(button('Prepare').attributes('disabled')).toBeDefined();
    expect(button('Confirm').attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toContain('download');
    expect(wrapper.text()).toContain('apply');
    expect(wrapper.text()).toContain('BUILD');
  });

  it('links the build to its page in the CodeBuild console, for a dashboard build as for a CLI build', async () => {
    const url = 'https://eu-west-1.console.aws.amazon.com/codesuite/codebuild/121014831971/projects/dmt-dev-install/build/dmt-dev-install%3Ab2/?region=eu-west-1';
    for (const by of ['dashboard', 'cli'] as const) {
      h.answer = () => running({ by, consoleUrl: url });
      await mountView();
      const link = wrapper.findAll('a').find((a) => a.text() === 'View the build in CodeBuild')!;
      expect(link.attributes()).toMatchObject({ href: url, target: '_blank', rel: 'noopener' });
      wrapper.unmount();
    }
    h.answer = () => running({ status: 'FAILED', consoleUrl: url, tail: ['Error: boom'] });
    await mountView();
    expect(wrapper.findAll('a').map((a) => a.text())).toContain('View the build in CodeBuild');
    wrapper.unmount();
    // None without its page, nor for a link that is not https.
    for (const consoleUrl of [null, 'javascript:alert(1)']) {
      h.answer = () => running({ consoleUrl });
      await mountView();
      expect(wrapper.text()).not.toContain('View the build in CodeBuild');
      wrapper.unmount();
    }
    wrapper = mount({ render: () => null });
  });

  it('gives the menu\'s badge the versions on offer of each state it loads', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await mountView();
    const badge = useUpdateBadge();
    expect(badge.count).toBe(2);
    h.answer = () => state({ versions: [], applied: { version: '0.13.0', build: 'b3', at: null } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(badge.count).toBe(0);
    // A failed read changes nothing.
    badge.count = 1;
    h.answer = () => { throw new Error('Failed to fetch'); };
    await vi.advanceTimersByTimeAsync(60_000);
    expect(badge.count).toBe(1);
  });

  it('labels a build started from the CLI', async () => {
    h.answer = () => running({ by: 'cli' });
    await mountView();
    expect(wrapper.text()).toContain('started from the CLI');
  });

  it('disables the buttons while a request is pending, and says when the update did not start', async () => {
    const pending = { key: 'k', id: 'i', action: 'plan' as const, version: '0.13.0', at: '2026-10-18T10:00:00Z', who: 'a@b.c' };
    h.answer = () => state({ pending });
    await mountView();
    await select('0.13.0');
    expect(button('Prepare').attributes('disabled')).toBeDefined();
    wrapper.unmount();
    h.answer = () => state({ pending: { ...pending, notStarted: true } });
    await mountView();
    await select('0.13.0');
    expect(wrapper.text()).toContain('The update did not start. Prepare the update again.');
    expect(button('Prepare').attributes('disabled')).toBeUndefined();
  });

  it('says to confirm again when an apply request did not start, its plan still confirmable', async () => {
    const plan = { build: 'dmt-dev-install:p1', version: '0.13.0', summary: { add: 1, change: 0, destroy: 0, replaced: [], destroyed: [] } };
    const pending = { key: 'k', id: 'i', action: 'apply' as const, version: '0.13.0', planBuild: plan.build, at: '2026-10-18T10:00:00Z', who: 'a@b.c', notStarted: true as const };
    h.answer = (path) => (path.startsWith('/update/changes') ? sections : state({ plan, pending }));
    await mountView();
    expect(wrapper.text()).toContain('The update did not start. Confirm again.');
    expect(wrapper.text()).not.toContain('Prepare the update again.');
    await select('0.13.0');
    expect(button('Confirm').attributes('disabled')).toBeUndefined();
  });

  it('says what a successful apply did, and what a failed one left', async () => {
    h.answer = () => running({ status: 'SUCCEEDED', phase: 'COMPLETED' });
    await mountView();
    expect(wrapper.text()).toContain('The manager now runs 0.13.0.');
    wrapper.unmount();
    h.answer = () => running({ status: 'FAILED', steps: ['download', 'apply'], tail: ['Error: boom', 'exit 1'] });
    await mountView();
    expect(wrapper.text()).toContain('The step that failed: apply');
    expect(wrapper.find('pre').text()).toBe('Error: boom\nexit 1');
    expect(wrapper.text()).toContain('The manager is as the failure left it: prepare the update again, or run dormeto install from a laptop.');
  });

  it('says a failed or refused dashboard plan was not prepared, with its last step, and nothing about the manager', async () => {
    h.answer = () => running({ action: 'plan', status: 'FAILED', steps: ['reading the request r1', 'manager 0.13.0 is neither published nor staged'], tail: ['dormeto: manager 0.13.0 is neither published nor staged'] });
    await mountView();
    expect(wrapper.text()).toContain('The plan was not prepared: manager 0.13.0 is neither published nor staged.');
    expect(wrapper.find('pre').text()).toBe('dormeto: manager 0.13.0 is neither published nor staged');
    expect(wrapper.text()).not.toContain('The manager is as the failure left it');
    expect(wrapper.text()).not.toContain('The step that failed');
  });

  it('shows a failed CLI build\'s status, step and tail, without the dashboard\'s sentences', async () => {
    h.answer = () => running({ by: 'cli', action: 'apply', status: 'FAILED', steps: ['download', 'terraform apply'], tail: ['Error: boom'] });
    await mountView();
    expect(wrapper.text()).toContain('FAILED');
    expect(wrapper.text()).toContain('The step that failed: terraform apply');
    expect(wrapper.find('pre').text()).toBe('Error: boom');
    expect(wrapper.text()).not.toContain('The manager is as the failure left it');
    expect(wrapper.text()).not.toContain('The plan was not prepared');
  });

  it('retries failed polls silently while the API is replaced, then offers the reload', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    let polls = 0;
    h.answer = () => {
      polls += 1;
      if (polls === 1) return running();
      if (polls <= 4) throw new Error('Failed to fetch');
      return state({ version: '0.13.0' });
    };
    await mountView();
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(wrapper.text()).not.toContain('not answering');
      expect(wrapper.text()).not.toContain('Failed to fetch');
      expect(wrapper.text()).toContain('download');
    }
    expect(wrapper.text()).not.toContain('Reload');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(wrapper.text()).toContain('The manager now runs 0.13.0.');
    await button('Reload').trigger('click');
    expect(reload).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('says the manager is not answering after two minutes of failed polls, and clears it at the next answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let down = false;
    h.answer = () => {
      if (down) throw new Error('Failed to fetch');
      return running();
    };
    await mountView();
    down = true;
    await vi.advanceTimersByTimeAsync(5_000 * 23);
    expect(wrapper.text()).not.toContain('not answering');
    await vi.advanceTimersByTimeAsync(5_000 * 2);
    expect(wrapper.text()).toContain('the manager is not answering');
    expect(wrapper.find('.v-alert').classes().join(' ')).toContain('warning');
    down = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(wrapper.text()).not.toContain('not answering');
  });

  it('polls every 60 s when nothing runs, and stops on unmount', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await mountView();
    const count = () => h.calls.filter((c) => c[1] === '/update').length;
    expect(count()).toBe(1);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(count()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(count()).toBe(2);
    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(count()).toBe(2);
    wrapper = mount({ render: () => null });
  });

  // The API answers so whenever the module's install input is unset: an install made without the CLI, with a CLI older
  // than 0.2.0, or with --build-role.
  it('explains why updates are not set up, and how to update either install, with no picker, and only the check button', async () => {
    h.answer = () => ({ installedWithCli: false, version: '0.11.0', env: 'dev', region: 'eu-west-1' });
    await mountView();
    const text = wrapper.text();
    expect(text).toContain('0.11.0');
    expect(text).toContain('Updates from this page are not set up for this manager.');
    expect(text).toContain('It was installed without dormeto install, or with a CLI older than 0.2.0, or with --build-role.');
    expect(text).toContain('Installed with the CLI: run dormeto install again with the CLI 0.2.0 or later (without --build-role) to set up updates from this page, or dormeto install --profile <your profile> --region eu-west-1 --env dev --version <version> from a laptop.');
    expect(text).toContain('Installed with the Terraform module: raise the module\'s version in the configuration that installed it, and apply.');
    expect(text).not.toContain('was not installed with');
    expect(text).not.toContain('new install');
    const hrefs = wrapper.findAll('a').map((a) => a.attributes('href'));
    expect(hrefs).toEqual([
      'https://dormeto.com/get-started.html#update', 'https://dormeto.com/get-started.html#upgrade',
      'https://github.com/Dormeto/cli', 'https://github.com/Dormeto/cli#install-the-manager',
    ]);
    expect(wrapper.findAll('a').slice(2).every((a) => a.attributes('target') === '_blank' && a.attributes('rel') === 'noopener')).toBe(true);
    expect(wrapper.findAll('button').map((b) => b.text())).toEqual(['Check for updates']);
    expect(wrapper.findComponent({ name: 'VSelect' }).exists()).toBe(false);
  });

  describe('the CLI card', () => {
    const commands = () => wrapper.findAll('.dm-command code').map((c) => c.text());

    it('shows the three commands with the env, region and the newest offered version', async () => {
      await mountView();
      const text = wrapper.text();
      expect(text).toContain('Install the CLI');
      expect(commands()).toEqual([
        'brew install dormeto/tap/dormeto',
        'curl -fsSL https://dormeto.com/install.sh | sh',
        'dormeto install --profile <your profile> --region eu-west-1 --env dev --version 0.13.0',
        'dormeto install status --profile <your profile> --region eu-west-1 --env dev',
      ]);
      expect(text).toContain('administrator rights in this account');
      expect(text).toContain('plans first and asks before applying');
    });

    it('uses the selected target, and no --version when nothing is on offer', async () => {
      await mountView();
      await select('0.12.0');
      expect(commands()[2]).toBe('dormeto install --profile <your profile> --region eu-west-1 --env dev --version 0.12.0');
      wrapper.unmount();
      h.answer = () => state({ versions: [] });
      await mountView();
      expect(commands()[2]).toBe('dormeto install --profile <your profile> --region eu-west-1 --env dev');
    });

    it('copies a command with its button', async () => {
      const writeText = vi.fn(async () => {});
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
      await mountView();
      await wrapper.find('.dm-command button').trigger('click');
      await flushPromises();
      expect(writeText).toHaveBeenCalledWith('brew install dormeto/tap/dormeto');
      expect(wrapper.find('.dm-command').text()).toContain('Copied');
    });

    it('links the CLI, its documentation, the manager and its changelog', async () => {
      await mountView();
      const links = wrapper.findAll('.dm-links a');
      expect(links.map((a) => [a.text(), a.attributes('href')])).toEqual([
        ['Dormeto CLI on GitHub', 'https://github.com/Dormeto/cli'],
        ['Documentation', 'https://github.com/Dormeto/cli#updating-from-the-dashboard'],
        ['Manager on GitHub', 'https://github.com/Dormeto/manager'],
        ['Changelog', 'https://github.com/Dormeto/manager/blob/main/CHANGELOG.md'],
      ]);
      expect(links.every((a) => a.attributes('target') === '_blank' && a.attributes('rel') === 'noopener')).toBe(true);
    });
  });

  describe('Check for updates', () => {
    it('reloads the state and the badge at once, and says when it checked', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-18T10:00:00Z'));
      await mountView();
      expect(wrapper.text()).toContain('Checked 0 s ago');
      vi.setSystemTime(new Date('2026-10-18T10:10:00Z'));
      await wrapper.vm.$nextTick();
      h.calls.length = 0;
      await button('Check for updates').trigger('click');
      await flushPromises();
      expect(h.calls.map((c) => c[1])).toEqual(expect.arrayContaining(['/update', '/update/available']));
      expect(wrapper.text()).toContain('Checked 0 s ago');
    });

    it('is disabled while it runs, and a failure shows the notice and keeps the previous time', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-18T10:00:00Z'));
      await mountView();
      let fail!: (e: Error) => void;
      h.answer = (path) => (path === '/update' ? new Promise((_, reject) => { fail = reject; }) : { count: 1 });
      await button('Check for updates').trigger('click');
      expect(button('Check for updates').attributes('disabled')).toBeDefined();
      vi.setSystemTime(new Date('2026-10-18T10:10:00Z'));
      fail(new Error('boom'));
      await flushPromises();
      expect(wrapper.text()).toContain('boom');
      expect(wrapper.text()).toContain('Checked 10 min ago');
      expect(button('Check for updates').attributes('disabled')).toBeUndefined();
    });
  });
});
