import { describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import OnboardDialog from '../src/components/OnboardDialog.vue';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'visualViewport', {
  configurable: true,
  value: { width: 1280, height: 800, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
});

async function openDialog(extra: Record<string, unknown> = {}) {
  const wrapper = mount(OnboardDialog, { props: { modelValue: false, title: 'shop.example.com', defaultName: 'shop', ...extra }, attachTo: document.body, global: { plugins: [createVuetify({ components, directives })] } });
  await wrapper.setProps({ modelValue: true });
  await flushPromises();
  return wrapper;
}
const input = (label: string) => [...document.querySelectorAll('.v-dialog .v-input')].find((i) => i.querySelector('label')?.textContent?.includes(label))!.querySelector('input')!;
const onboardButton = () => [...document.querySelectorAll('.v-dialog button')].find((b) => b.textContent?.trim() === 'Onboard') as HTMLButtonElement;

describe('OnboardDialog', () => {
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
    expect(dialogText()).toContain('The router may not get nodes; get, patch deployments/scale (apps) in cluster eks-demo: apply the ClusterRole Dormeto publishes (kubernetes/dormeto-router.yaml) and its binding to the group dormeto:router. The onboarding stops until then.');
    missing.unmount();
    const unknown = await openDialog({ kubernetes: kube() });
    expect(dialogText()).toContain('The router checks its access to cluster eks-demo before onboarding.');
    unknown.unmount();
  });
});
