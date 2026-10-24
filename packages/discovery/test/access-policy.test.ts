// The discovery role's policy (Terraform module access, CLI procedure) grants every call the scanner makes.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DISCOVERY_ACTIONS } from '../src/scan.js';

const policy = JSON.parse(readFileSync(new URL('../../../infra/terraform/modules/access/discovery-policy.json', import.meta.url), 'utf8')) as { Statement: { Sid?: string; Effect: string; Action: string[] | string; Resource: string; Condition?: unknown }[] };

describe('discovery role policy', () => {
  it('grants every action of the scanner, read-only', () => {
    const granted = policy.Statement.filter((s) => s.Effect === 'Allow').flatMap((s) => [s.Action].flat());
    expect(DISCOVERY_ACTIONS.filter((a) => !granted.includes(a))).toEqual([]);
    expect(granted.filter((a) => !/:(Describe|List|Get)/.test(a) && a !== 'lambda:InvokeFunction')).toEqual([]);
  });

  it('reads its own role only, to know an account set up for discovery only', () => {
    const own = policy.Statement.filter((st) => [st.Action].flat().includes('iam:GetRole'));
    expect(own).toEqual([{ Sid: 'OwnRole', Effect: 'Allow', Action: 'iam:GetRole', Resource: '*', Condition: { StringEquals: { 'aws:ResourceTag/dormeto:component': 'discovery' } } }]);
    expect(DISCOVERY_ACTIONS).toContain('iam:GetRole');
  });

  it('invokes only the Kubernetes proxies: functions named *-kube-* and tagged dormeto:role = kubernetes-proxy', () => {
    const invoke = policy.Statement.filter((st) => [st.Action].flat().includes('lambda:InvokeFunction'));
    expect(invoke).toEqual([{
      Sid: 'InvokeKubernetesProxies', Effect: 'Allow', Action: 'lambda:InvokeFunction', Resource: 'arn:${partition}:lambda:*:${account}:function:*-kube-*',
      Condition: { StringEquals: { 'aws:ResourceTag/dormeto:role': 'kubernetes-proxy' } },
    }]);
  });

  it('reads the CloudTrail trails of each region (event refresh, packaging design §5)', () => {
    expect(DISCOVERY_ACTIONS).toEqual(expect.arrayContaining(['cloudtrail:DescribeTrails', 'cloudtrail:GetTrailStatus', 'cloudtrail:GetEventSelectors']));
  });
});
