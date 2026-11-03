import { describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useSession } from '../src/stores/session';
import { flushPromises, mount } from '@vue/test-utils';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import { VSelect } from 'vuetify/components';
import OnboardDialog from '../src/components/OnboardDialog.vue';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});

async function openDialog(extra: Record<string, unknown> = {}, role: 'admin' | 'operator' = 'admin') {
  setActivePinia(createPinia());
  useSession().role = role;
  const wrapper = mount(OnboardDialog, { props: { modelValue: false, title: 'shop.example.com', defaultName: 'shop', ...extra }, attachTo: document.body, global: { plugins: [createVuetify({ components, directives })] } });
  await wrapper.setProps({ modelValue: true });
  await flushPromises();
  return wrapper;
}
const input = (label: string) => [...document.querySelectorAll('.v-dialog .v-input')].find((i) => i.querySelector('label')?.textContent?.includes(label))!.querySelector('input')!;
const onboardButton = () => [...document.querySelectorAll('.v-dialog button')].find((b) => b.textContent?.trim() === 'Onboard') as HTMLButtonElement;

describe('OnboardDialog', () => {
  // Settings at scale (vision design §9): the idle window and the wake mode inherit unless set.
  it('sends no idle window or wake mode by default: the levels decide; a value set is sent', async () => {
    const wrapper = await openDialog();
    onboardButton().click();
    const first = (wrapper.emitted('submit')![0]![0] as { settings: Record<string, unknown> }).settings;
    expect([first.idleMinutes, first.wakeMode]).toEqual([undefined, undefined]);
    const idle = input('Idle window');
    expect(idle.placeholder).toBe('Inherit');
    idle.value = '30';
    idle.dispatchEvent(new Event('input'));
    await flushPromises();
    onboardButton().click();
    expect((wrapper.emitted('submit')![1]![0] as { settings: Record<string, unknown> }).settings.idleMinutes).toBe(30);
    wrapper.unmount();
  });

  it('sends the fallback instance types (R7b), none when empty', async () => {
    const wrapper = await openDialog();
    onboardButton().click();
    expect((wrapper.emitted('submit')![0]![0] as { settings: Record<string, unknown> }).settings).not.toHaveProperty('fallbackInstanceTypes');
    const field = input('Fallback instance types');
    field.value = ' t3a.medium, m6i.large ';
    field.dispatchEvent(new Event('input'));
    await flushPromises();
    onboardButton().click();
    expect((wrapper.emitted('submit')![1]![0] as { settings: Record<string, unknown> }).settings.fallbackInstanceTypes).toEqual(['t3a.medium', 'm6i.large']);
    wrapper.unmount();
  });

  it('refuses a list that is not EC2 instance types, or more than 5', async () => {
    const wrapper = await openDialog();
    const field = input('Fallback instance types');
    for (const value of ['t3a medium', 't3.small, t3.medium, t3.large, t3a.small, t3a.medium, t3a.large']) {
      field.value = value;
      field.dispatchEvent(new Event('input'));
      await flushPromises();
      expect(onboardButton().disabled, value).toBe(true);
    }
    wrapper.unmount();
  });

  it('leaves hibernate out on Inherit and sends false on Off, true on On', async () => {
    const wrapper = await openDialog();
    const select = wrapper.findAllComponents(VSelect).find((s) => s.props('label') === 'Hibernate')!;
    expect(select.props('modelValue')).toBe('inherit');
    expect(select.props('hint')).toContain('Standalone EC2 instances (not Auto Scaling groups or ECS) launched with hibernation');
    onboardButton().click();
    expect((wrapper.emitted('submit')![0]![0] as { settings: Record<string, unknown> }).settings).not.toHaveProperty('hibernate');
    select.vm.$emit('update:modelValue', 'off');
    await flushPromises();
    onboardButton().click();
    expect((wrapper.emitted('submit')![1]![0] as { settings: Record<string, unknown> }).settings.hibernate).toBe(false);
    select.vm.$emit('update:modelValue', 'on');
    await flushPromises();
    onboardButton().click();
    expect((wrapper.emitted('submit')![2]![0] as { settings: Record<string, unknown> }).settings.hibernate).toBe(true);
    wrapper.unmount();
  });

  // Kubernetes candidates (vision docs/specs/2026-10-11-kubernetes-design.md, section 10).
  const kube = (over: Record<string, unknown> = {}) => ({
    cluster: 'eks-demo', namespace: 'demo', owner: { kind: 'Deployment', name: 'web' }, switch: 'ingress',
    ingress: { name: 'web', ruleIndex: 0, groupOrder: -1, service: { name: 'web', port: { number: 80 } } }, hpa: true, keda: false, capacity: 'nodes', autoscaler: 'karpenter', ...over,
  });
  const dialogText = () => document.querySelector('.v-dialog')!.textContent!.replace(/\s+/g, ' ');

  it('a Kubernetes candidate in an IngressGroup: Dormeto adds its own Ingress before the customer\'s, never changed; no EC2 fallback types', async () => {
    const wrapper = await openDialog({ kubernetes: kube() });
    expect(dialogText()).toContain('Dormeto adds its own Ingress to the IngressGroup of Ingress demo/web, before it: it sends the requests to Service web, or to the waker while Deployment demo/web naps at 0 replicas. Ingress demo/web is never changed.');
    expect(dialogText()).toContain('Its HPA is left alone (it does nothing at 0 replicas).');
    expect(dialogText()).not.toContain('tags its backends');
    expect(document.querySelector('.v-dialog')!.textContent).not.toContain('Fallback instance types');
    wrapper.unmount();
  });

  it('a lone Ingress is patched, and given back at offboarding; KEDA is paused while it naps', async () => {
    const wrapper = await openDialog({ kubernetes: kube({ switch: 'patched-ingress', ingress: { name: 'solo', ruleIndex: 0, service: { name: 'solo', port: { number: 80 } } }, keda: true, hpa: false }) });
    expect(dialogText()).toContain('Dormeto patches Ingress demo/solo: its path to Service solo goes through the annotation alb.ingress.kubernetes.io/actions.dormeto, to the Service or to the waker. Offboarding gives the Ingress back as it was.');
    expect(dialogText()).toContain('Its KEDA ScaledObject is paused while it naps (autoscaling.keda.sh/paused-replicas: "0").');
    wrapper.unmount();
  });

  it('gives the Terraform lines of the backend, and says a rule that acts first gets the waker itself', async () => {
    const lines = () => document.querySelector('[data-test="terraform"]')?.textContent ?? '';
    for (const [kind, wanted] of [
      ['ecs', 'aws_ecs_service'], ['asg', 'aws_autoscaling_group'],
    ] as const) {
      const wrapper = await openDialog({ backendKind: kind });
      expect(lines()).toContain('key_prefixes = ["dormeto:"]');
      expect(lines()).toContain('resource "aws_lb_listener_rule"');
      expect(lines()).toContain('ignore_changes = [action]');
      expect(lines()).toContain(wanted);
      wrapper.unmount();
    }
    const asg = await openDialog({ backendKind: 'asg' });
    expect(lines()).toContain('ignore_changes = [min_size, max_size, desired_capacity, suspended_processes]');
    expect(document.querySelector('.v-dialog')!.textContent).toContain('acts before its forward');
    asg.unmount();
    const ecs = await openDialog({ backendKind: 'ecs' });
    expect(lines()).toContain('ignore_changes = [desired_count]');
    ecs.unmount();
    expect(document.querySelector('[data-test="terraform"]')).toBeNull();
  });

  it('adds an instance\'s type to the Terraform lines only with fallback types', async () => {
    const wrapper = await openDialog({ backendKind: 'instance' });
    const lines = () => document.querySelector('[data-test="terraform"]')!.textContent!;
    expect(lines()).not.toContain('aws_instance');
    const field = input('Fallback instance types');
    field.value = 't3a.medium';
    field.dispatchEvent(new Event('input'));
    await flushPromises();
    expect(lines()).toContain('resource "aws_instance"');
    expect(lines()).toContain('ignore_changes = [instance_type]');
    wrapper.unmount();
  });

  it('gives no Terraform lines for a Kubernetes workload: its GitOps snippet says what to keep', async () => {
    const wrapper = await openDialog({ backendKind: 'k8s', kubernetes: kube({ gitops: 'flux' }) });
    expect(document.querySelector('[data-test="terraform"]')).toBeNull();
    wrapper.unmount();
  });

  it('gives the GitOps snippet that keeps Argo CD or Flux from undoing a nap', async () => {
    const argo = await openDialog({ kubernetes: kube({ gitops: 'argocd', switch: 'patched-ingress', ingress: { name: 'solo', ruleIndex: 0, service: { name: 'solo', port: { number: 80 } } } }) });
    const snippet = document.querySelector('[data-test="gitops"]')!.textContent!;
    expect(snippet).toContain('ignoreDifferences:');
    expect(snippet).toContain('kind: Deployment\n      name: web\n      namespace: demo\n      jsonPointers:\n        - /spec/replicas');
    expect(snippet).toContain('kind: Ingress\n      name: solo');
    expect(snippet).toContain('/metadata/annotations/alb.ingress.kubernetes.io~1actions.dormeto');
    argo.unmount();
    const flux = await openDialog({ kubernetes: kube({ gitops: 'flux' }) });
    expect(document.querySelector('[data-test="gitops"]')!.textContent).toContain('spec.replicas');
    flux.unmount();
  });

  it('says what the router lacks in the cluster, with the procedure; or that the check runs before onboarding', async () => {
    const missing = await openDialog({ kubernetes: kube(), access: { reachable: true, allowed: false, missing: ['get nodes', 'get, patch deployments/scale (apps)'] } });
    expect(dialogText()).toContain('The router may not get nodes; get, patch deployments/scale (apps) in cluster eks-demo: apply dormeto-kubernetes-<version>.yaml of the release (the ClusterRole and its binding to the group dormeto:router): https://dormeto.com/organization-access.html#kubernetes. The onboarding stops until then.');
    missing.unmount();
    const unknown = await openDialog({ kubernetes: kube() });
    expect(dialogText()).toContain('The router checks its access to cluster eks-demo before onboarding.');
    unknown.unmount();
  });

  // R11: the workload's tags, chosen at onboarding; nothing is copied unless asked.
  const fill = async (el: HTMLInputElement, value: string) => { el.value = value; el.dispatchEvent(new Event('input')); await flushPromises(); };
  const button = (text: string) => [...document.querySelectorAll('.v-dialog button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
  const tagInputs = () => [...document.querySelectorAll<HTMLInputElement>('.v-dialog [data-test="tags-editor"] input')];

  it('sends the tags written in its Tags section, and none when there are none', async () => {
    const wrapper = await openDialog();
    onboardButton().click();
    expect(wrapper.emitted('submit')![0]![0]).not.toHaveProperty('tags');
    button('Add a tag')!.click();
    await flushPromises();
    await fill(tagInputs()[0]!, 'team');
    await fill(tagInputs()[1]!, 'payments');
    onboardButton().click();
    expect((wrapper.emitted('submit')![1]![0] as { tags: unknown }).tags).toEqual({ team: 'payments' });
    wrapper.unmount();
  });

  it('shows the Tags section and the copy button to administrators only, and sends no tags for an operator', async () => {
    const operator = await openDialog({ awsTags: { team: ['payments'] } }, 'operator');
    expect(document.querySelector('.v-dialog')!.textContent).not.toContain('Tags');
    expect(button("Copy the target group's AWS tags")).toBeUndefined();
    expect(button('Add a tag')).toBeUndefined();
    onboardButton().click();
    expect(operator.emitted('submit')![0]![0]).not.toHaveProperty('tags');
    operator.unmount();
    const admin = await openDialog({ awsTags: { team: ['payments'] } });
    expect(button("Copy the target group's AWS tags")).toBeDefined();
    admin.unmount();
  });

  it('copies nothing from the target group\'s AWS tags by default, and the first value of each key on request, for the administrator to edit', async () => {
    const wrapper = await openDialog({ awsTags: { team: ['payments', 'platform'], env: ['staging'], 'dormeto:workload': ['x'], 'bad*key': ['v'] } });
    expect(tagInputs()).toHaveLength(0);
    button("Copy the target group's AWS tags")!.click();
    await flushPromises();
    expect(tagInputs().map((i) => i.value)).toEqual(['env', 'staging', 'team', 'payments']);
    // What the rules refuse is left out, and said.
    expect(document.querySelector('.v-dialog')!.textContent).toContain('2 AWS tags left out');
    await fill(tagInputs()[3]!, 'billing');
    onboardButton().click();
    expect((wrapper.emitted('submit')![0]![0] as { tags: unknown }).tags).toEqual({ env: 'staging', team: 'billing' });
    wrapper.unmount();
  });

  it('offers the copy only when the candidate has AWS tags, and refuses tags the rules refuse', async () => {
    const wrapper = await openDialog();
    expect(button("Copy the target group's AWS tags")).toBeUndefined();
    button('Add a tag')!.click();
    await flushPromises();
    await fill(tagInputs()[0]!, 'dormeto:x');
    expect(onboardButton().disabled).toBe(true);
    wrapper.unmount();
  });
});
