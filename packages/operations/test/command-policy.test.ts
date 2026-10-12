// The command role's policy (modules/access/command-role/command-policy.json) against the calls the operations make in a
// member account: every one allowed, with its resource and conditions (packaging design §5: the forwarder).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ACCOUNT = '222222222222';
const policy = JSON.parse(readFileSync(new URL('../../../infra/terraform/modules/access/command-role/command-policy.json', import.meta.url), 'utf8')
  .replaceAll('${account}', ACCOUNT).replaceAll('${partition}', 'aws')) as { Statement: { Effect: string; Action: string | string[]; Resource: string | string[]; Condition?: Record<string, Record<string, string | string[]>> }[] };

const like = (pattern: string, value: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(value);
const list = <T>(v: T | T[]) => ([] as T[]).concat(v);

// Allow statements only (the policy has no Deny); StringEquals and ArnLike conditions, as the policy uses.
export function allows(action: string, resource: string, context: Record<string, string> = {}) {
  return policy.Statement.some((s) => s.Effect === 'Allow' && list(s.Action).some((a) => like(a, action)) && list(s.Resource).some((r) => like(r, resource))
    && Object.entries(s.Condition ?? {}).every(([test, keys]) => Object.entries(keys).every(([key, values]) => {
      const value = context[key];
      if (value === undefined) return false;
      return list(values).some((v) => (test === 'ArnLike' ? like(v, value) : v === value));
    })));
}

const role = `arn:aws:iam::${ACCOUNT}:role/dormeto/router/dmtr-dev-forwarder`;
const rule = `arn:aws:events:eu-west-3:${ACCOUNT}:rule/dmtr-dev-discovery`;
const boundary = { 'iam:PermissionsBoundary': `arn:aws:iam::${ACCOUNT}:policy/DmtRouterBoundary` };

// The forwarder's installation and removal (C2's installer records the same calls).
export const FORWARDER_CALLS: [string, string, Record<string, string>?][] = [
  ['iam:GetRole', role], ['iam:CreateRole', role, boundary], ['iam:TagRole', role], ['iam:UpdateAssumeRolePolicy', role],
  ['iam:PutRolePolicy', role, boundary], ['iam:GetRolePolicy', role], ['iam:DeleteRolePolicy', role, boundary], ['iam:DeleteRole', role],
  // A rule delivering to another account's bus passes its role to EventBridge.
  ['iam:PassRole', role, { 'iam:PassedToService': 'events.amazonaws.com' }],
  ['events:DescribeRule', rule], ['events:PutRule', rule], ['events:TagResource', rule], ['events:PutTargets', rule],
  ['events:ListTargetsByRule', rule], ['events:RemoveTargets', rule], ['events:DeleteRule', rule],
];

describe('the command role\'s policy', () => {
  it('allows every call the forwarder\'s installation and removal make, and passes router roles to EventBridge only as such', () => {
    for (const [action, resource, context] of FORWARDER_CALLS) expect(allows(action, resource, context), `${action} ${resource}`).toBe(true);
    // Never a role outside the routers' path, never to another service than those the routers use.
    expect(allows('iam:PassRole', `arn:aws:iam::${ACCOUNT}:role/Admin`, { 'iam:PassedToService': 'events.amazonaws.com' })).toBe(false);
    expect(allows('iam:PassRole', role, { 'iam:PassedToService': 'ec2.amazonaws.com' })).toBe(false);
    expect(allows('iam:CreateRole', role)).toBe(false);
    expect(allows('events:PutRule', `arn:aws:events:eu-west-3:${ACCOUNT}:rule/customer-rule`)).toBe(false);
  });
});
