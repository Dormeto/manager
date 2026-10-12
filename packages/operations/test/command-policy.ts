// The command role's policy (modules/access/command-role/command-policy.json), evaluated as IAM does for its Allow
// statements: the calls the operations make in a member account checked against it.
import { readFileSync } from 'node:fs';

export const ACCOUNT = '222222222222';
const policy = JSON.parse(readFileSync(new URL('../../../infra/terraform/modules/access/command-role/command-policy.json', import.meta.url), 'utf8')
  .replaceAll('${account}', ACCOUNT).replaceAll('${partition}', 'aws')) as { Statement: { Effect: string; Action: string | string[]; Resource: string | string[]; Condition?: Record<string, Record<string, string | string[]>> }[] };

const like = (pattern: string, value: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(value);
const list = <T>(v: T | T[]) => ([] as T[]).concat(v);

// Allow statements only (the policy has no Deny); StringEquals, ArnLike and ForAllValues:StringEquals conditions, as the
// policy uses (ForAllValues holds for a key the request does not carry, as IAM evaluates it).
export function allows(action: string, resource: string, context: Record<string, string | string[]> = {}) {
  return policy.Statement.some((s) => s.Effect === 'Allow' && list(s.Action).some((a) => like(a, action)) && list(s.Resource).some((r) => like(r, resource))
    && Object.entries(s.Condition ?? {}).every(([test, keys]) => Object.entries(keys).every(([key, values]) => {
      const value = context[key];
      if (test === 'ForAllValues:StringEquals') return value === undefined || list(value).every((v) => list(values).includes(v));
      if (value === undefined || Array.isArray(value)) return false;
      return list(values).some((v) => (test === 'ArnLike' ? like(v, value) : v === value));
    })));
}

export const role = `arn:aws:iam::${ACCOUNT}:role/dormeto/router/dmtr-dev-forwarder`;
export const rule = `arn:aws:events:eu-west-3:${ACCOUNT}:rule/dmtr-dev-discovery`;
const boundary = { 'iam:PermissionsBoundary': `arn:aws:iam::${ACCOUNT}:policy/DmtRouterBoundary` };

// The forwarder's installation and removal (C2's installer records the same calls).
export const FORWARDER_CALLS: [string, string, Record<string, string>?][] = [
  ['iam:GetRole', role], ['iam:ListRolePolicies', role], ['iam:CreateRole', role, boundary], ['iam:TagRole', role], ['iam:UpdateAssumeRolePolicy', role],
  ['iam:PutRolePolicy', role, boundary], ['iam:GetRolePolicy', role], ['iam:DeleteRolePolicy', role, boundary], ['iam:DeleteRole', role],
  // A rule delivering to another account's bus passes its role to EventBridge.
  ['iam:PassRole', role, { 'iam:PassedToService': 'events.amazonaws.com' }],
  ['events:DescribeRule', rule], ['events:PutRule', rule], ['events:TagResource', rule], ['events:PutTargets', rule],
  ['events:ListTargetsByRule', rule], ['events:RemoveTargets', rule], ['events:DeleteRule', rule],
];


// The installer's port calls (the fake's names) as IAM actions, with what they need besides.
export const ACTIONS: Record<string, [string, Record<string, string>?][]> = {
  getRole: [['iam:GetRole']], listRolePolicies: [['iam:ListRolePolicies']], getRolePolicy: [['iam:GetRolePolicy']],
  createRole: [['iam:CreateRole', boundary], ['iam:TagRole']], updateAssumeRolePolicy: [['iam:UpdateAssumeRolePolicy']],
  putRolePolicy: [['iam:PutRolePolicy', boundary]], deleteRolePolicy: [['iam:DeleteRolePolicy', boundary]], deleteRole: [['iam:DeleteRole']],
  describeRule: [['events:DescribeRule']], putRule: [['events:PutRule'], ['events:TagResource']], listTargetsByRule: [['events:ListTargetsByRule']],
  putTargets: [['events:PutTargets'], ['iam:PassRole', { 'iam:PassedToService': 'events.amazonaws.com' }]], removeTargets: [['events:RemoveTargets']], deleteEventRule: [['events:DeleteRule']],
};
