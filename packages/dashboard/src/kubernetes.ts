// What the dashboard says of a Kubernetes workload (vision docs/specs/2026-10-11-kubernetes-design.md, sections 6, 8 and
// 10): what onboarding adds, the GitOps snippet that keeps a nap, the router's access to the cluster.
export interface KubernetesCandidate {
  cluster: string;
  namespace: string;
  owner: { kind: string; name: string };
  switch: 'rule' | 'ingress' | 'patched-ingress';
  ingress?: { name: string; ruleIndex: number; groupOrder?: number; service: { name: string; port: { number?: number; name?: string } } };
  gitops?: 'argocd' | 'flux';
  hpa: boolean;
  keda: boolean | null;
  capacity: 'fargate' | 'nodes';
  autoscaler: 'karpenter' | 'cluster-autoscaler' | null;
}
export interface ClusterAccess { reachable: boolean; allowed: boolean; missing: string[]; reason?: string }

const ANNOTATION = 'alb.ingress.kubernetes.io/actions.dormeto';
export const CLUSTER_ROLE = 'apply the ClusterRole Dormeto publishes (kubernetes/dormeto-router.yaml) and its binding to the group dormeto:router';

// What onboarding adds, and what it leaves alone.
export function onboardingTexts(k: KubernetesCandidate): string[] {
  const owner = `${k.owner.kind} ${k.namespace}/${k.owner.name}`;
  const ingress = k.ingress ? `Ingress ${k.namespace}/${k.ingress.name}` : '';
  const texts = [
    k.switch === 'ingress' && k.ingress
      ? `Dormeto adds its own Ingress to the IngressGroup of ${ingress}, before it: it sends the requests to Service ${k.ingress.service.name}, or to the waker while ${owner} naps at 0 replicas. ${ingress} is never changed.`
      : k.switch === 'patched-ingress' && k.ingress
        ? `Dormeto patches ${ingress}: its path to Service ${k.ingress.service.name} goes through the annotation ${ANNOTATION}, to the Service or to the waker. Offboarding gives the Ingress back as it was.`
        : `The router adds the waker before every rule forwarding to its target group (traffic unchanged); ${owner} naps at 0 replicas.`,
  ];
  if (k.hpa) texts.push('Its HPA is left alone (it does nothing at 0 replicas).');
  if (k.keda) texts.push('Its KEDA ScaledObject is paused while it naps (autoscaling.keda.sh/paused-replicas: "0").');
  return texts;
}

// The GitOps snippet that keeps Argo CD or Flux from setting the replicas (and the patch) back while the workload naps.
export function gitopsSnippet(k: KubernetesCandidate): string | null {
  const patched = k.switch === 'patched-ingress' && k.ingress;
  if (k.gitops === 'argocd') {
    return [
      '# The Argo CD Application of the workload',
      'spec:',
      '  ignoreDifferences:',
      '    - group: apps',
      `      kind: ${k.owner.kind}`,
      `      name: ${k.owner.name}`,
      `      namespace: ${k.namespace}`,
      '      jsonPointers:',
      '        - /spec/replicas',
      ...(patched ? [
        '    - group: networking.k8s.io',
        '      kind: Ingress',
        `      name: ${k.ingress!.name}`,
        `      namespace: ${k.namespace}`,
        '      jsonPointers:',
        `        - /metadata/annotations/${ANNOTATION.replace('/', '~1')}`,
        '        - /spec/rules',
      ] : []),
      '  syncPolicy:',
      '    syncOptions:',
      '      - RespectIgnoreDifferences=true',
    ].join('\n');
  }
  if (k.gitops === 'flux') {
    return [
      `# Flux applies Git again at each reconciliation: remove spec.replicas from ${k.owner.kind} ${k.namespace}/${k.owner.name} in Git, or annotate it`,
      `${patched ? `# (and Ingress ${k.namespace}/${k.ingress!.name})` : '#'} so that Flux creates it but no longer overwrites it:`,
      'metadata:',
      '  annotations:',
      '    kustomize.toolkit.fluxcd.io/ssa: IfNotPresent',
    ].join('\n');
  }
  return null;
}

// The router's access to the cluster, as its last check found it (null: not checked yet).
export function accessText(cluster: string, access: ClusterAccess | null | undefined): { level: 'info' | 'warning'; text: string } {
  if (!access) return { level: 'info', text: `The router checks its access to cluster ${cluster} before onboarding.` };
  if (access.allowed) return { level: 'info', text: `The router reaches cluster ${cluster} and has the rights it needs.` };
  if (!access.reachable) return { level: 'warning', text: `The router cannot reach cluster ${cluster}: ${access.reason ?? 'no answer'}. The onboarding stops until then.` };
  if (access.missing.length) return { level: 'warning', text: `The router may not ${access.missing.join('; ')} in cluster ${cluster}: ${CLUSTER_ROLE}. The onboarding stops until then.` };
  return { level: 'warning', text: `${access.reason ?? `The router may not use cluster ${cluster}`}. The onboarding stops until then.` };
}
