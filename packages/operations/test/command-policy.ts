// The command role's policy (modules/access/command-role/command-policy.json), evaluated as IAM does for its Allow
// statements: the calls the operations make in a member account checked against it.
import { readFileSync } from 'node:fs';

export const ACCOUNT = '222222222222';
type Policy = { Statement: { Effect: string; Action: string | string[]; Resource: string | string[]; Condition?: Record<string, Record<string, string | string[]>> }[] };
// A policy document of the access module, its placeholders filled, evaluated by `allows`-like functions.
export const load = (file: string): Policy => JSON.parse(readFileSync(new URL(`../../../infra/terraform/modules/access/${file}`, import.meta.url), 'utf8')
  .replaceAll('${account}', ACCOUNT).replaceAll('${partition}', 'aws'));
const policy = load('command-role/command-policy.json');

const like = (pattern: string, value: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(value);
const list = <T>(v: T | T[]) => ([] as T[]).concat(v);

// Allow statements only (the policy has no Deny); StringEquals, ArnLike, ForAllValues:StringEquals and Null conditions, as
// the policy uses (ForAllValues holds for a key the request does not carry, as IAM evaluates it; Null "true" holds only
// for a key it does not carry).
export const allows = (action: string, resource: string, context: Record<string, string | string[]> = {}) => evaluate(policy, action, resource, context);
export function evaluate(policy: Policy, action: string, resource: string, context: Record<string, string | string[]> = {}) {
  return policy.Statement.some((s) => s.Effect === 'Allow' && list(s.Action).some((a) => like(a, action)) && list(s.Resource).some((r) => like(r, resource))
    && Object.entries(s.Condition ?? {}).every(([test, keys]) => Object.entries(keys).every(([key, values]) => {
      const value = context[key];
      if (test === 'Null') return (value === undefined) === (values === 'true');
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

// A private cluster's proxy (R10.6, M2's per-cluster operations): router dmtr-dev, region eu-west-1, cluster eks-demo (its
// part of the names is the cluster's name), created in the order below and removed in the reverse one.
export const KUBE_REGION = 'eu-west-1';
export const kubeRole = `arn:aws:iam::${ACCOUNT}:role/dormeto/router/dmtr-dev-${KUBE_REGION}-kube-eks-demo`;
export const kubeFunction = `arn:aws:lambda:${KUBE_REGION}:${ACCOUNT}:function:dmtr-dev-kube-eks-demo`;
export const kubeLogGroup = `arn:aws:logs:${KUBE_REGION}:${ACCOUNT}:log-group:/aws/lambda/dmtr-dev-kube-eks-demo`;
export const vpc = `arn:aws:ec2:${KUBE_REGION}:${ACCOUNT}:vpc/vpc-0a1b2c3d`;
export const proxyGroup = `arn:aws:ec2:${KUBE_REGION}:${ACCOUNT}:security-group/sg-0proxy000`;
export const clusterGroup = `arn:aws:ec2:${KUBE_REGION}:${ACCOUNT}:security-group/sg-0cluster00`;
const proxyTag = { 'aws:ResourceTag/dormeto:role': 'kubernetes-proxy' };
const clusterTag = { 'aws:ResourceTag/aws:eks:cluster-name': 'eks-demo' };

export const KUBE_PROXY_CALLS: [string, string, Record<string, string>?][] = [
  // The network it reads (and Lambda reads on creating a VPC function), and the interfaces it waits to see released.
  ['ec2:DescribeSecurityGroups', '*'], ['ec2:DescribeSubnets', '*'], ['ec2:DescribeVpcs', '*'], ['ec2:DescribeNetworkInterfaces', '*'],
  // Its security group: created tagged, its default egress revoked, then 443 to the cluster's group.
  ['ec2:CreateSecurityGroup', vpc], ['ec2:CreateSecurityGroup', proxyGroup, { 'aws:RequestTag/dormeto:role': 'kubernetes-proxy' }],
  ['ec2:CreateTags', proxyGroup, { 'ec2:CreateAction': 'CreateSecurityGroup' }],
  ['ec2:RevokeSecurityGroupEgress', proxyGroup, proxyTag], ['ec2:AuthorizeSecurityGroupEgress', proxyGroup, proxyTag],
  // The rule on the cluster's own group (the one EKS tags), from the proxy's.
  ['ec2:AuthorizeSecurityGroupIngress', clusterGroup, clusterTag], ['ec2:RevokeSecurityGroupIngress', clusterGroup, clusterTag],
  // Its role, with the boundary (its trust put back when changed), passed to Lambda.
  ['iam:GetRole', kubeRole], ['iam:ListRolePolicies', kubeRole], ['iam:CreateRole', kubeRole, boundary], ['iam:TagRole', kubeRole], ['iam:UpdateAssumeRolePolicy', kubeRole],
  ['iam:PutRolePolicy', kubeRole, boundary], ['iam:GetRolePolicy', kubeRole], ['iam:DeleteRolePolicy', kubeRole, boundary], ['iam:DeleteRole', kubeRole],
  ['iam:PassRole', kubeRole, { 'iam:PassedToService': 'lambda.amazonaws.com' }],
  // Its log group.
  ['logs:DescribeLogGroups', '*'], ['logs:CreateLogGroup', kubeLogGroup], ['logs:TagResource', kubeLogGroup], ['logs:PutRetentionPolicy', kubeLogGroup],
  ['logs:DeleteLogGroup', kubeLogGroup],
  // Its function (state Active read from its configuration).
  ['lambda:CreateFunction', kubeFunction], ['lambda:TagResource', kubeFunction], ['lambda:GetFunction', kubeFunction],
  ['lambda:GetFunctionConfiguration', kubeFunction], ['lambda:UpdateFunctionCode', kubeFunction], ['lambda:UpdateFunctionConfiguration', kubeFunction],
  ['lambda:InvokeFunction', kubeFunction], ['lambda:DeleteFunction', kubeFunction],
  // Removal: its group deleted last.
  ['ec2:DeleteSecurityGroup', proxyGroup, proxyTag],
];
