import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import HibernateDialog from '../src/components/HibernateDialog.vue';
import IdleBar from '../src/components/IdleBar.vue';
import OnboardDialog from '../src/components/OnboardDialog.vue';
import OrganizationAccess from '../src/components/OrganizationAccess.vue';
import RenameDialog from '../src/components/RenameDialog.vue';
import StateBar from '../src/components/StateBar.vue';
import TagsDialog from '../src/components/TagsDialog.vue';
import GroupsView from '../src/views/GroupsView.vue';
import OperationsView from '../src/views/OperationsView.vue';
import RoutersView from '../src/views/RoutersView.vue';
import WorkloadView from '../src/views/WorkloadView.vue';
import type { Cloud } from '@dormeto/fleet/clouds';
import { cloudWords } from '../src/cloud-words';
import { idleText } from '../src/discovery';
import { failureTitle } from '../src/failures';
import { backendHelp, backendLabel } from '../src/format';
import { exclusionText } from '../src/pause';
import { settingRows } from '../src/settings';
import { useSession } from '../src/stores/session';
import { scanFile, scanSources } from './cloud-switches';

// The words of the places that don't switch on a row's cloud (a page, a card) name both clouds, and a dialog about one workload
// names its own cloud's (M28, design 6.5).
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});
// The workload a view of one reads (every read of /workloads/…), as its router answers.
let workload: Record<string, unknown> = {};
vi.mock('../src/api', () => ({
  api: vi.fn(async (path: string) => (path.startsWith('/operations') ? { operations: [] } : path.startsWith('/workloads/') ? structuredClone(workload) : { routers: [], ipLists: [], groups: [], users: [] })),
}));

const mounted: ReturnType<typeof mount>[] = [];
afterEach(() => { while (mounted.length) mounted.pop()!.unmount(); });
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
const vuetify = () => createVuetify({ components, directives });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bodyText = () => squash(document.body.textContent ?? '');
const lastDialog = () => squash([...document.querySelectorAll('.v-dialog')].at(-1)?.textContent ?? '');
async function hover(el: Element) {
  el.dispatchEvent(new Event('mouseenter'));
  await flushPromises();
  await sleep(300);
}

describe('RenameDialog', () => {
  const open = (cloud?: 'aws' | 'gcp') => {
    const w = mount(RenameDialog, { props: { modelValue: true, name: 'shop', ...(cloud ? { cloud } : {}) }, attachTo: document.body, global: { plugins: [vuetify()] } });
    mounted.push(w);
    return squash(document.body.textContent ?? '');
  };

  it('says nothing changes in Google Cloud for a Google Cloud workload', () => {
    const text = open('gcp');
    expect(text).toContain('Nothing changes in Google Cloud.');
    expect(text).not.toContain('Nothing changes in AWS');
  });

  it('keeps AWS\'s sentence for an AWS workload', () => {
    expect(open('aws')).toContain('Nothing changes in AWS.');
  });
});

describe('the Groups view', () => {
  it('says the tags are set on the workloads, in neither cloud', async () => {
    const w = await mountView(GroupsView, '/groups');
    await w.find('[data-test="new-group"]').trigger('click');
    await flushPromises();
    expect(squash(document.body.textContent ?? '')).toContain('Tags are set on the workloads, not in AWS or Google Cloud.');
  });
});

async function mountView(view: typeof OperationsView | typeof RoutersView | typeof GroupsView, path: string) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path, component: view }] });
  await router.push(path);
  const w = mount(view, { attachTo: document.body, global: { plugins: [vuetify(), pinia, router] } });
  mounted.push(w);
  await flushPromises();
  return w;
}

describe('the Operations view', () => {
  it('says its steps are AWS or Google Cloud API calls', async () => {
    const w = await mountView(OperationsView, '/operations');
    const lead = squash(w.find('.dm-lead').text());
    expect(lead).toContain('in the target account or project and region by AWS or Google Cloud API calls');
  });
});

describe('the Routers view', () => {
  it('names an AWS account and a Google Cloud project in what a router is', async () => {
    const w = await mountView(RoutersView, '/routers');
    const more = w.find('[data-test="routers-more"]');
    await more.trigger('mouseenter');
    await flushPromises();
    const tip = squash(document.querySelector('[data-test="routers-tip"]')?.textContent ?? '');
    expect(tip).toContain('One router per AWS account and region, or per Google Cloud project and region, naps and wakes its workloads.');
    expect(tip).toContain('health comes from its idle check and, on AWS, its Lambda functions and its failure queues.');
  });
});

// The switches on the cloud that choose what to do, not a word: which call, card, field, icon element or id form a cloud has.
// Each is named by its text, with why; a word goes in the words table (src/cloud-words.ts) instead.
const BEHAVIOUR: { file: string; text: string; why: string }[] = [
  { file: 'components/BackendKinds.vue', text: "props.cloud === 'gcp' ? null : backendIcon(kind)", why: 'a kind\'s icon element: AWS\'s product icon, an image' },
  { file: 'components/BackendKinds.vue', text: "props.cloud === 'gcp' ? backendMdi(kind) : null", why: 'a kind\'s icon element: Google Cloud\'s Material Design icon' },
  { file: 'access.ts', text: 'if (isGoogle(row.account))', why: 'a project\'s line is the API\'s reasons as given (they name what is missing and the connect command), an account\'s is made from its roles' },
  { file: 'components/OnboardDialog.vue', text: 'props.kubernetes || gcp.value ? null : terraformSnippet(props.backendKind, fallbackTypes.value.length > 0)', why: 'the lines its Terraform keeps: an AWS candidate\'s only' },
  { file: 'components/OnboardDialog.vue', text: '<template v-else-if="gcp">', why: 'what onboarding changes: Google Cloud\'s two steps (the waker in the URL map, the tag it binds) against AWS\'s one' },
  { file: 'components/OnboardDialog.vue', text: 'gcp.value ? MACHINE_TYPE : INSTANCE_TYPE', why: 'the pattern of a fallback type: a Compute Engine machine type, an EC2 instance type' },
  {
    file: 'components/OnboardDialog.vue', text: "gcp.value ? { kind: 'cloudsql-instance', id: d } : d.startsWith('cluster:') ? { kind: 'rds-cluster', id: d.slice(8) } : { kind: 'rds-instance', id: d }",
    why: 'the companion databases sent: Cloud SQL instances, or RDS instances and Aurora clusters',
  },
  {
    file: 'views/DiscoveryView.vue',
    text: 'isGoogle(c) ? [`${words.target} ${c.targetGroup}`, `${words.loadBalancer} ${c.loadBalancer}`, ...(c.lb ? [lbText(c.lb)] : [])] : [c.loadBalancer, c.listener, c.priority ? `priority ${c.priority}` : null, '
      + 'c.rules?.length > 1 ? `${c.rules.length} rules` : null].filter((s): s is string => Boolean(s))',
    why: 'where a candidate\'s rule is, exported: its backend service and URL map, or its load balancer, listener and priority',
  },
  { file: 'views/DiscoveryView.vue', text: 'isGoogle(c) ? c.backend.id : shortId(c.backend.id)', why: 'a backend\'s id, exported: a Google Cloud name whole, an ARN shortened' },
  { file: 'views/DiscoveryView.vue', text: '<div v-if="isGoogle(item)">', why: 'where a candidate\'s rule is: its backend service and URL map linked to the console, or its listener rule' },
  { file: 'views/DiscoveryView.vue', text: '<span v-if="item.backend && isGoogle(item)">', why: 'a candidate\'s backend: Google Cloud\'s kind icon and resource path, or AWS\'s BackendLabel with its ARN' },
  {
    file: 'hibernation.ts', text: "if (cloud === 'gcp' || (m.url === null && m.readAt))",
    why: 'what Inherit reads: a level the manager pushed (Google Cloud\'s, or an answer without its cloud and with no URL), or a URL the router fetches; their states differ',
  },
  { file: 'pause.ts', text: "if (cloudOf(c.account) === 'gcp')", why: 'which targets: a backend service and a URL map by their paths, or a target group and a load balancer by their ARNs (their nouns are the table\'s)' },
  { file: 'views/WorkloadView.vue', text: 'gcp.value ? backendConsoleUrl(b, project.value) : null', why: 'a backend\'s console link: Google Cloud\'s only' },
  {
    file: 'views/WorkloadView.vue',
    text: "gcp.value && status.value?.backendService ? [{ kind: 'target-group', path: googleResourcePath(status.value.account ?? '', 'backendServices', status.value.backendService, status.value.lb, "
      + "status.value.region ?? ''), label: `${capitalised(words.value.target)} ${resourceName(status.value.backendService)} (this workload)` }] : status.value?.targetGroupArn ? [{ kind: 'target-group', arn: "
      + "status.value.targetGroupArn, label: `${capitalised(cloudWords('aws').target)} ${shortId(status.value.targetGroupArn.replace(/\\/[0-9a-f]+$/, ''))} (this workload)` }] : []",
    why: 'what Exclude offers: the backend service by its path, or the target group by its ARN',
  },
  { file: 'views/WorkloadView.vue', text: 'gcp ? null : backendArn(b, where)', why: 'a backend\'s ARN: AWS\'s only' },
  { file: 'views/WorkloadView.vue', text: 'gcp ? resourceName(b.id) : shortId(b.id)', why: 'a backend\'s name: its resource path\'s last segment, or its ARN shortened' },
  { file: 'views/WorkloadView.vue', text: 'gcp ? backendMdi(b.kind) : backendIcon(b.kind)', why: 'a backend\'s icon element, as BackendKinds\'' },
  { file: 'views/WorkloadView.vue', text: '<v-icon v-if="gcp">', why: 'a backend\'s icon element: a Material Design icon, or AWS\'s product icon as an image' },
  { file: 'views/WorkloadView.vue', text: '<v-card v-if="gcp && status.backendService">', why: 'a Google Cloud workload\'s Load balancing card, an AWS one\'s Targets card' },
  { file: 'views/WorkloadView.vue', text: '<v-card-text v-if="!gcp && status.hibernation && !standalone">', why: 'an AWS workload without a standalone EC2 instance, which hibernation does not apply to' },
];

// Every inline switch on the cloud that chooses a word reads the words table instead (cloud duplication design §5); the demo's
// API (src/mock) is left out: its switches choose its example data and say the API's own words.
describe('the inline switches on the cloud', () => {
  const found = scanSources((file) => file.startsWith('mock/') || file === 'cloud-words.ts');
  const listed = (f: { file: string; text: string }) => BEHAVIOUR.some((b) => b.file === f.file && b.text === f.text);

  it('choose no word: each cloud\'s words are the table\'s', () => {
    expect(found.filter((f) => !listed(f)).map((f) => `${f.file}:${f.line} ${f.text}`)).toEqual([]);
  });

  it('that choose what to do are each still in their file, once', () => {
    expect(BEHAVIOUR.filter((b) => found.filter((f) => f.file === b.file && f.text === b.text).length !== 1).map((b) => `${b.file} ${b.text}`)).toEqual([]);
  });

  it('are found in each form a switch takes', () => {
    const vue = [
      '<script setup lang="ts">',
      "const owner = (cloud: string) => (cloud === 'gcp'",
      "  ? 'Project' : 'Account');",
      "const name = (cloud: string) => { if ('aws' !== cloud) return `Google ${'Cloud'}`; return 'AWS'; };",
      "const MARKS = { aws: 'AWS', 'gcp': 'Google Cloud' };",
      "const notOne = (cloud: string, x: { gcp: boolean }) => (x.gcp ? cloudOf(cloud) === 'gcp' : null) ?? [cloud === 'aws'];",
      '</script>',
      '<template>',
      '  <p v-if="gcp">Google</p>',
      '  <!-- either -->',
      '  <p v-else>AWS</p>',
      '  <span v-if="isGoogle(c)" />',
      '  <div v-else :title="google ? \'a\' : \'b\'">{{ gcp.value ? 1 : 2 }}</div>',
      '  <li v-for="c in (gcp ? a : b)" :key="c" />',
      '</template>',
    ].join('\n');
    expect(scanFile('x.vue', vue)).toEqual([
      { file: 'x.vue', line: 2, text: "cloud === 'gcp' ? 'Project' : 'Account'" },
      { file: 'x.vue', line: 4, text: "if ('aws' !== cloud)" },
      { file: 'x.vue', line: 5, text: "{ aws: 'AWS', 'gcp': 'Google Cloud' }" },
      { file: 'x.vue', line: 9, text: '<p v-if="gcp">' },
      { file: 'x.vue', line: 12, text: '<span v-if="isGoogle(c)">' },
      { file: 'x.vue', line: 13, text: "google ? 'a' : 'b'" },
      { file: 'x.vue', line: 13, text: 'gcp.value ? 1 : 2' },
    ]);
    expect(scanFile('x.ts', "export const hint = (c: Cloud | null) =>\n  (c === 'gcp' && wide) ? 'europe-west2 or global' : 'eu-west-1';")).toEqual([
      { file: 'x.ts', line: 2, text: "(c === 'gcp' && wide) ? 'europe-west2 or global' : 'eu-west-1'" },
    ]);
  });

  // Each form with a look-alike that is not one: what a script's switch is found by, then an element's.
  it('are found as a switch, a word after && or ||, a .has() or an isGcp flag, an if returning texts, and a pair of any two elements', () => {
    const script = (code: string) => scanFile('x.ts', code).map((f) => f.text);
    const SCRIPTS: [string, string[]][] = [
      ["const owner = (cloud: Cloud) => { switch (cloud) { case 'gcp': return 'Project'; default: return 'Account'; } };", ['switch (cloud)']],
      ["const many = (kind: string) => { switch (kind) { case 'k8s': return 'pods'; default: return 'VMs'; } };", []],
      ["const about = cloud === 'gcp' && 'about ';", ["cloud === 'gcp' && 'about '"]],
      ['const holder = isAws || `role`;', ['isAws || `role`']],
      ["const wide = cloud === 'gcp' && narrow;", []],
      ["const holder = listed.has('gcp') ? 'account' : 'role';", ["listed.has('gcp') ? 'account' : 'role'"]],
      ["const name = clouds.includes('aws') ? 'AWS' : 'Google Cloud';", ["clouds.includes('aws') ? 'AWS' : 'Google Cloud'"]],
      ["const many = kinds.has('k8s') ? 'pods' : 'VMs';", []],
      ["const tag = isGcp ? 'label' : 'tag';", ["isGcp ? 'label' : 'tag'"]],
      ["const on = isActive ? 'on' : 'off';", []],
      ["function targets(c: C) { if (cloudOf(c.account) === 'gcp') { const s = c.id; return [{ id: s, label: `Backend service ${s}` }]; } return []; }", ["if (cloudOf(c.account) === 'gcp')"]],
      ["function name(c: C) { if (gcp) return compute(c); else return 'AWS'; }", ['if (gcp)']],
      ['function line(c: C) { if (isGoogle(c)) return c.reasons.join(sep); return other(c); }', []],
      ["function later(c: C) { if (gcp) { const f = () => 'x'; return f; } return null; }", []],
    ];
    for (const [code, found] of SCRIPTS) expect(script(code), code).toEqual(found);
    const template = (body: string) => scanFile('x.vue', `<template>\n  ${body}\n</template>`).map((f) => f.text);
    expect(template('<span v-if="gcp">Google</span><div v-else>AWS</div>')).toEqual(['<span v-if="gcp">']);
    expect(template('<span v-if="ready">Google</span><div v-else>AWS</div>')).toEqual([]);
    expect(template('<span v-if="gcp">Google</span><div>AWS</div>')).toEqual([]);
  });
});

// Each cloud's words where the dashboard switches on the cloud, as they read: what the words table (src/cloud-words.ts) holds.
describe('each cloud\'s words', () => {
  it('are AWS\'s for a row that names no cloud, or one the dashboard does not know, as every switch said', () => {
    for (const cloud of [null, undefined, 'azure', 'constructor'] as (Cloud | null | undefined)[]) expect(cloudWords(cloud), String(cloud)).toBe(cloudWords('aws'));
    expect([cloudWords('aws').name, cloudWords('gcp').name]).toEqual(['AWS', 'Google Cloud']);
  });

  it('name the kinds of backends, with their help', () => {
    const kinds = ['instance', 'asg', 'ecs', 'k8s', 'rds-instance', 'rds-cluster', 'cloudsql-instance', 'other'];
    expect(kinds.map((k) => backendLabel(k, 'aws'))).toEqual(['EC2 instance', 'Auto Scaling group', 'ECS service', 'Kubernetes workload', 'RDS instance', 'Aurora cluster', 'cloudsql-instance', 'other']);
    expect(kinds.map((k) => backendLabel(k, 'gcp'))).toEqual(['Compute Engine VM', 'Managed instance group', 'ECS service', 'Kubernetes workload', 'RDS instance', 'Aurora cluster', 'Cloud SQL instance', 'other']);
    const database = 'a companion database, stopped after the application and started before it';
    expect(kinds.map((k) => backendHelp(k, 'aws'))).toEqual([
      'EC2 instance: started and stopped by Dormeto', 'Auto Scaling group: its instances are started and stopped through the group',
      'ECS service: scaled to zero tasks when it naps, and back when it wakes',
      'Kubernetes workload: a Deployment or StatefulSet on Amazon EKS, scaled to zero replicas when it naps, back to its replicas when it wakes',
      `RDS instance: ${database}`, `Aurora cluster: ${database}`, 'cloudsql-instance', 'other',
    ]);
    expect(kinds.map((k) => backendHelp(k, 'gcp'))).toEqual([
      'Compute Engine VM: started and stopped by Dormeto', 'Managed instance group: its instances are started and stopped through the group',
      'ECS service: scaled to zero tasks when it naps, and back when it wakes',
      'Kubernetes workload: a Deployment or StatefulSet on Google Kubernetes Engine, scaled to zero replicas when it naps, back to its replicas when it wakes',
      `RDS instance: ${database}`, `Aurora cluster: ${database}`, `Cloud SQL instance: ${database}`, 'other',
    ]);
  });

  it('say an idle share and what it was read on', () => {
    expect(idleText({ idleHours7d: 154, requests7d: 1 }, 'aws')).toEqual({ title: 'Idle 92 % of the last 7 days', detail: '154 of 168 hours without any request to its target group (1 request in 7 days).' });
    expect(idleText({ idleHours7d: 154, requests7d: 1 }, 'gcp')).toEqual({ title: 'Idle about 92 % of the last 7 days', detail: '154 of 168 hours without any request to its backend service (1 request in 7 days).' });
  });

  it('explain the settings Google Cloud fixes or runs its own way, the others as AWS\'s', () => {
    const settings = { waitSeconds: 0, idleMinutes: 15, drainSeconds: 0, wakeTimeoutSeconds: 600, maxHolders: 0, failedRetrySeconds: 60 };
    const texts = (cloud: 'aws' | 'gcp') => Object.fromEntries(settingRows(settings, undefined, cloud).map((r) => [r.key, [r.help, r.range]]));
    const aws = texts('aws');
    const fixed = 'Fixed at 0 on Google Cloud.';
    expect(texts('gcp')).toEqual({
      ...aws,
      waitSeconds: ['The waker holds no request on Google Cloud: it answers the waiting page at once, and the page waits for the wake.', fixed],
      drainSeconds: ['A nap\'s switch on Google Cloud is a URL map change, and the backend service\'s own connection draining applies.', fixed],
      maxHolders: ['No request is held on Google Cloud: visitors get the waiting page at once.', fixed],
      wakeTimeoutSeconds: [
        'Longest a wake may take before the workload is marked FAILED; the next request then retries the wake. Wakes continue across the router\'s Cloud Tasks, so long starts such as Cloud SQL databases are supported.',
        'Longer than the slowest start of the backends (VMs, managed instance groups, a Cloud SQL database), at most 1,700 s.',
      ],
    });
  });

  it('name an exclusion\'s load balancer or URL map', () => {
    expect(exclusionText({ kind: 'load-balancer', arn: 'arn:aws:elasticloadbalancing:eu-west-1:121014831971:loadbalancer/app/shop/0123', account: '121014831971', region: 'eu-west-1', name: 'shop' })).toBe('load balancer shop · 121014831971 · eu-west-1');
  });

  it('title a failed wake with no healthy target or backend, the other failures alike', () => {
    const failed = (kind: string) => ({ kind, step: 'wake' as const, message: '', at: '' });
    expect(['unhealthy', 'capacity', 'nope'].map((k) => failureTitle(failed(k), 'aws'))).toEqual(['Last wake failed: no healthy target', 'Last wake failed: no capacity', 'Last wake failed: unknown error']);
    expect(['unhealthy', 'capacity', 'nope'].map((k) => failureTitle(failed(k), 'gcp'))).toEqual(['Last wake failed: no healthy backend', 'Last wake failed: no capacity', 'Last wake failed: unknown error']);
  });

  it('say where an idle bar\'s figures come from', async () => {
    const sources = [];
    for (const cloud of ['aws', 'gcp'] as const) {
      const w = mount(IdleBar, { props: { idleHours7d: 154, requests7d: 1, cloud }, attachTo: document.body, global: { plugins: [vuetify()] } });
      mounted.push(w);
      await hover(w.find('.idle-bar').element);
      sources.push(squash(document.querySelector('.v-tooltip .note')?.textContent ?? ''));
      w.unmount();
      mounted.pop();
    }
    expect(sources).toEqual([
      'From the load balancer\'s CloudWatch metric RequestCount for this target group, hour by hour, read by discovery: no onboarding needed. Every request counts, bots and scanners included: an estimate of how long it could sleep.',
      'From Cloud Monitoring\'s request count of the load balancer for this backend service, hour by hour, read by discovery: no onboarding needed. Google samples these metrics, and every request counts, bots and scanners included: an estimate of how long it could sleep.',
    ]);
  });

  it('say what the estimates of a 7-day bar are', async () => {
    const STATES = { from: '2026-10-02T12:00:00.000Z', to: '2026-10-09T12:00:00.000Z', totals: { ASLEEP: 432_000, AWAKE: 86_000 } };
    const notes = [];
    for (const cloud of ['aws', 'gcp'] as const) {
      const w = mount(StateBar, { props: { states: STATES, cloud, savings: { saved: { usd: 3.2, hours: 600, unpricedHours: 0 }, hourly: 0.02, monthly: 13, discounts: null } }, attachTo: document.body, global: { plugins: [vuetify()] } });
      mounted.push(w);
      await hover(w.find('[data-test="state-bar"]').element);
      notes.push(bodyText());
      w.unmount();
      mounted.pop();
    }
    expect(notes[0]).toContain('Estimates: AWS list prices of what the naps stopped, Spot at Spot prices, for the time asleep the baseline would have run.');
    expect(notes[0]).not.toContain('Windows');
    expect(notes[1]).toContain('Estimates: Google Cloud list prices of what the naps stopped, Spot VMs at Spot prices, for the time asleep the baseline would have run. Windows licenses are not counted; a suspended VM\'s memory, which Google still bills, is subtracted; Cloud SQL (MySQL and PostgreSQL) is priced for custom, shared-core and Enterprise Plus N tiers (others not priced).');
  });

  it('title and explain the hibernation dialog', () => {
    const open = (cloud: 'aws' | 'gcp') => {
      const w = mount(HibernateDialog, { props: { modelValue: true, subject: 'shop', current: null, cloud }, attachTo: document.body, global: { plugins: [vuetify()] } });
      mounted.push(w);
      const text = lastDialog();
      w.unmount();
      mounted.pop();
      return text;
    };
    const aws = open('aws');
    expect(aws).toContain('Hibernate shop');
    expect(aws).toContain('Decides whether the standalone EC2 instances (not Auto Scaling groups or ECS) that were launched with hibernation are hibernated instead of stopped when the workload naps. Dormeto does not enable hibernation on an instance: it is chosen when the instance is launched. A workload with fallback instance types does not hibernate unless it is set to On on the workload itself.');
    const google = open('gcp');
    expect(google).toContain('Suspend instead of stop shop');
    expect(google).toContain('Decides whether the VMs of the workload are suspended instead of stopped when it naps: a suspended VM keeps its memory and resumes faster. A VM that cannot be suspended (with a GPU or a TPU, confidential, or with more than 208 GB of memory) is stopped. After 60 days Compute Engine stops a suspended VM itself. A workload with fallback machine types is not suspended unless it is set to On on the workload itself.');
  });

  it('say whose tags a workload\'s are not', () => {
    const open = (cloud: 'aws' | 'gcp') => {
      const w = mount(TagsDialog, { props: { modelValue: true, tags: {}, name: 'shop', cloud }, attachTo: document.body, global: { plugins: [vuetify()] } });
      mounted.push(w);
      const text = lastDialog();
      w.unmount();
      mounted.pop();
      return text;
    };
    expect(open('aws')).toContain('Dormeto\'s own labels, not AWS tags: the groups\' grants pick workloads by them. Nothing changes in AWS.');
    expect(open('gcp')).toContain('Dormeto\'s own labels, not Google Cloud labels: the groups\' grants pick workloads by them. Nothing changes in Google Cloud.');
  });

  it('link each listed cloud\'s procedure, the roles\' while the delegation policy is missing or nothing is listed', () => {
    const project = { account: 'shop-prod', name: 'shop-prod', discovery: { ok: true as const }, command: { ok: false as const, reason: 'the command service account cannot act in shop-prod' } };
    const links = (delegation: 'ok' | 'missing', accounts: (typeof project)[]) => {
      const report = { counts: { ready: 0, discoveryMissing: 0, commandMissing: 1, unchecked: 0 }, accounts, cursor: null, delegation, checkedAt: null };
      const w = mount(OrganizationAccess, { props: { report }, attachTo: document.body, global: { plugins: [vuetify()] } });
      mounted.push(w);
      return w.findAll('.v-card-actions a').map((a) => [a.text(), a.attributes('href')]);
    };
    const roles = ['How to set up the roles', 'https://dormeto.com/organization-access.html'];
    const connection = ['How to connect Google Cloud', 'https://dormeto.com/configuration.html#connection'];
    expect(links('ok', [])).toEqual([roles]);
    expect(links('ok', [project])).toEqual([connection]);
    expect(links('missing', [project])).toEqual([roles, connection]);
  });

  it('word the onboarding dialog\'s fields, its tags and what a copy leaves out', async () => {
    const open = async (cloud: 'aws' | 'gcp', awsTags: Record<string, string[]>) => {
      setActivePinia(createPinia());
      useSession().role = 'admin';
      const w = mount(OnboardDialog, { props: { modelValue: false, title: 'shop.example.com', defaultName: null, cloud, awsTags }, attachTo: document.body, global: { plugins: [vuetify()] } });
      mounted.push(w);
      await w.setProps({ modelValue: true });
      await flushPromises();
      const field = [...document.querySelectorAll('.v-dialog .v-input')].find((i) => /^Fallback/.test(i.querySelector('label')?.textContent ?? ''))!.querySelector('input')!;
      field.value = 'x';
      field.dispatchEvent(new Event('input'));
      await flushPromises();
      ([...document.querySelectorAll('.v-dialog button')].find((b) => b.textContent?.startsWith('Copy')) as HTMLButtonElement).click();
      await flushPromises();
      const text = lastDialog();
      const labels = [...document.querySelectorAll('.v-dialog .v-input')].map((i) => squash(i.querySelector('label')?.textContent ?? ''));
      w.unmount();
      mounted.pop();
      return { text, labels };
    };
    const aws = await open('aws', { team: ['payments'], 'dormeto:x': ['1'], 'bad!': ['2'] });
    for (const words of [
      'Shown in the manager; the target group name if empty. It can be changed later.',
      'RDS instance identifiers, or cluster:<identifier>, comma separated: stopped after the application, started before it',
      'At most 5 EC2 instance types, for example t3a.medium, m6i.large',
      'Standalone EC2 instances (not Auto Scaling groups or ECS) launched with hibernation are hibernated instead of stopped at a nap; with fallback instance types, only if On',
      'Dormeto\'s own labels for this workload, not AWS tags: the groups\' grants pick workloads by them. Administrators can change them later.',
      'Copy the target group\'s AWS tags', '2 AWS tags left out: reserved or with characters the tags do not allow.',
    ]) expect(aws.text).toContain(words);
    expect(aws.labels).toEqual(['Name', 'Idle window (minutes)', 'Wake mode', 'Companion databases (optional)', 'Fallback instance types (optional)', 'Hibernate', 'Key', 'Value']);
    const google = await open('gcp', { team: ['payments'], 'dormeto:x': ['1'] });
    for (const words of [
      'Shown in the manager; the backend service name if empty. It can be changed later.',
      'Cloud SQL instance names, comma separated: stopped after the application, started before it',
      'At most 5 Compute Engine machine types, each once, for example e2-medium, n2-standard-4',
      'The VMs are suspended instead of stopped at a nap, and resume faster; one that cannot be suspended is stopped; with fallback machine types, only if On',
      'Dormeto\'s own labels for this workload, not Google Cloud labels: the groups\' grants pick workloads by them. Administrators can change them later.',
      'Copy the VMs\' labels', '1 label left out: reserved or with characters the tags do not allow.',
    ]) expect(google.text).toContain(words);
    expect(google.labels).toEqual(['Name', 'Idle window (minutes)', 'Wake mode', 'Companion Cloud SQL instances (optional)', 'Fallback machine types (optional)', 'Suspend instead of stop', 'Key', 'Value']);
  });
});

// A workload's page on each cloud: asleep, its VM hibernated or suspended, on a fallback type, with its costs and energy.
describe('a workload\'s page in each cloud\'s words', () => {
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const common = {
    workloadId: 'w1', name: 'shop', url: null, router: { version: '0.40.0', build: 'b' }, state: 'ASLEEP', hibernated: true, source: 'manager',
    updatedAt: ago(5), awakeSince: null, wakeStartedAt: ago(36), failedAt: null, wakeCount: 2, holders: 0, pendingWake: false, pauses: [], drift: [],
    lastRequestAt: ago(40), nap: null, route: 'waker', rules: [], issues: [], ignoredTargets: [], recommendations: [], targets: [], stats: null, ipLists: [],
    settings: { waitSeconds: 60, idleMinutes: 30, drainSeconds: 30, wakeTimeoutSeconds: 300, maxHolders: 100 }, wakeMode: 'any', wakeRules: [], noWakeRules: [],
    fallbacks: [{ instance: 'vm-1', from: 'type-a', to: 'type-b' }],
    hibernation: { hibernate: true, from: 'router', workload: null, router: true, manager: null, instances: null, freshBoot: false },
    costs: { baseline: { kind: 'always' }, from: '2026-09-09T12:00:00.000Z', to: '2026-10-09T12:00:00.000Z', napAt: '2026-10-09T04:51:00.000Z', savedShare: 0.9, items: [], saved: { usd: 0, hours: 600, unpricedHours: 0 } },
    energy: { kwh: 4.14, co2Kg: 0.211, estimated: 1 },
  };
  const PROJECT = 'projects/dormeto-dev';
  const AWS = { ...common, account: '111122223333', region: 'eu-west-1', backends: [{ kind: 'instance', id: 'i-0abc', status: 'stopped' }] };
  const GOOGLE = {
    ...common, cloud: 'gcp', account: 'dormeto-dev', region: 'europe-west2', backendService: `${PROJECT}/global/backendServices/vm-demo`, urlMap: `${PROJECT}/global/urlMaps/dormeto-lb`, lb: { kind: 'global' },
    backends: [{ kind: 'instance', id: `${PROJECT}/zones/europe-west2-a/instances/vm-demo`, status: 'stopped' }],
  };
  const PODS = { backends: [{ kind: 'k8s', id: 'cluster-a/demo/Deployment/web', status: 'running', cluster: 'cluster-a', namespace: 'demo', owner: { kind: 'Deployment', name: 'web' }, replicas: 2 }] };
  async function page(answer: Record<string, unknown>) {
    while (mounted.length) mounted.pop()!.unmount();
    workload = answer;
    setActivePinia(createPinia());
    useSession().role = 'operator';
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/workloads/:router/:id', component: WorkloadView }] });
    await router.push('/workloads/dmtr-dev/w1');
    const w = mount(WorkloadView, { props: { router: 'dmtr-dev', id: 'w1' }, attachTo: document.body, global: { plugins: [vuetify(), router] } });
    mounted.push(w);
    await flushPromises();
    return w;
  }
  async function confirmation(answer: Record<string, unknown>, action: string) {
    const w = await page(answer);
    await w.find('[data-test="actions"]').trigger('click');
    await flushPromises();
    ([...document.querySelectorAll<HTMLElement>('[data-test="action"]')].find((i) => i.textContent?.trim() === action))!.click();
    await flushPromises();
    return lastDialog();
  }

  it('says hibernated or suspended beside its state', async () => {
    expect((await page(AWS)).find('[data-test="hibernated"]').text()).toBe('hibernated');
    expect((await page(GOOGLE)).find('[data-test="hibernated"]').text()).toBe('suspended');
  });

  it('says which VMs run on a fallback type and that their cloud had no capacity', async () => {
    const aws = squash((await page(AWS)).find('[data-test="fallbacks"]').text());
    expect(aws).toContain('On fallback instance types');
    expect(aws).toContain('vm-1 on type-b instead of type-a: AWS had no capacity for their own types at the last wake; the next nap gives them back.');
    const google = squash((await page(GOOGLE)).find('[data-test="fallbacks"]').text());
    expect(google).toContain('On fallback machine types');
    expect(google).toContain('vm-1 on type-b instead of type-a: Google Cloud had no capacity for their own types at the last wake; the next nap gives them back.');
  });

  it('names its backend\'s kind and service, and its energy\'s coefficients', async () => {
    const words = async (answer: Record<string, unknown>) => {
      const w = await page(answer);
      const backend = w.find('[data-test="backend"]');
      const kind = squash(backend.find('.v-list-item-subtitle').text());
      await hover(backend.element);
      const tip = squash(document.querySelector('.v-tooltip .resource')?.textContent ?? '');
      return [kind, tip.match(/Service(.*?)(Base cost|Cost|$)/)?.[1], squash(w.find('.dm-energy__note').text())];
    };
    expect(await words(AWS)).toEqual(['EC2 instance', 'Amazon EC2', 'Cloud Carbon Footprint\'s coefficients for AWS; not a measure.']);
    expect(await words(GOOGLE)).toEqual(['Compute Engine VM', 'Compute Engine', 'Cloud Carbon Footprint\'s coefficients for Google Cloud; not a measure.']);
    expect((await words({ ...GOOGLE, ...PODS }))[1]).toBe('Google Kubernetes Engine');
  });

  it('says its prices\' notes, and what of Kubernetes keeps running', async () => {
    const pods = ' Pods count as the pods\' share of their nodes, where an autoscaler removes the nodes they free;';
    expect(squash((await page({ ...AWS, ...PODS })).find('.dm-costs__note').text())).toBe(
      `AWS list prices of what its last nap stopped, Spot at Spot prices; a month is 730 hours.${pods} the EKS control plane and the nodes' DaemonSets keep running.`);
    expect(squash((await page({ ...GOOGLE, ...PODS })).find('.dm-costs__note').text())).toBe(
      'Google Cloud list prices of what its last nap stopped, Spot VMs at Spot prices; a month is 730 hours. Windows licenses are not counted; a suspended VM\'s memory, which '
      + `Google still bills, is subtracted; Cloud SQL (MySQL and PostgreSQL) is priced for custom, shared-core and Enterprise Plus N tiers (others not priced).${pods} the GKE control plane and the nodes' DaemonSets keep running.`);
  });

  it('names its hibernation setting, where a Terraform workload sets it, and says it saved', async () => {
    const line = async (answer: Record<string, unknown>) => squash((await page(answer)).find('[data-test="hibernate"]').text());
    expect(await line(AWS)).toContain('Hibernate On, from the router');
    expect(await line(GOOGLE)).toContain('Suspend instead of stop On, from the router');
    expect(await line({ ...AWS, source: 'terraform' })).toContain('set hibernate in its workload module');
    expect(await line({ ...GOOGLE, source: 'terraform' })).toContain('set it in its workload module');
    const saved = async (answer: Record<string, unknown>) => {
      const w = await page(answer);
      await w.find('[data-test="edit-hibernate"]').trigger('click');
      await flushPromises();
      ([...document.querySelectorAll<HTMLElement>('.v-dialog button')].find((b) => b.textContent?.trim() === 'Save'))!.click();
      await flushPromises();
      return squash(w.text());
    };
    expect(await saved(AWS)).toContain('Hibernation saved: it applies from the next nap.');
    expect(await saved(GOOGLE)).toContain('Suspension saved: it applies from the next nap.');
  });

  it('says what an offboarding and a wake do', async () => {
    expect(await confirmation(AWS, 'Offboard')).toContain('The workload is woken, then Dormeto removes what onboarding added: the waker from its rules, the waker target group, the tags. A workload written in Terraform is offboarded by removing its workload module.');
    expect(await confirmation(GOOGLE, 'Offboard')).toContain('The workload is woken, then Dormeto removes what onboarding added: its waker backend service, its routing in the URL map, the tags.');
    expect(await confirmation(AWS, 'Wake')).toContain('The backends start now; the route switches back to the application once a target is healthy.');
    expect(await confirmation(GOOGLE, 'Wake')).toContain('The backends start now; the route switches back to the application once its backend service\'s health check passes.');
  });
});
