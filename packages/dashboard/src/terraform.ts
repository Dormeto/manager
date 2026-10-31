// What a Terraform that writes an onboarded workload's resources must ignore, or every apply removes what onboarding added
// until the router repairs it (website: Workloads, "If Terraform writes these resources"). A Kubernetes workload has its
// GitOps snippet instead (kubernetes.ts).
const lifecycle = (resource: string, fields: string, note?: string) => [
  ...(note ? [`# ${note}`] : []),
  `resource "${resource}" "..." {`,
  '  lifecycle {',
  `    ignore_changes = [${fields}]`,
  '  }',
  '}',
];

const BACKENDS: Record<string, [string, string]> = {
  ecs: ['aws_ecs_service', 'desired_count'],
  asg: ['aws_autoscaling_group', 'min_size, max_size, desired_capacity, suspended_processes'],
};

export function terraformSnippet(backendKind: string | null | undefined, fallbackTypes: boolean): string {
  const backend = backendKind === 'instance' && fallbackTypes ? ['aws_instance', 'instance_type'] : BACKENDS[backendKind ?? ''];
  return [
    'provider "aws" {',
    '  ignore_tags {',
    '    key_prefixes = ["dormeto:"]',
    '  }',
    '}',
    '',
    ...lifecycle('aws_lb_listener_rule', 'action', 'Only a rule that acts before its forward, or that Dormeto could not cover.'),
    ...(backend ? ['', ...lifecycle(backend[0]!, backend[1]!)] : []),
  ].join('\n');
}
