// The discovery role's policy (Terraform module access, CLI procedure) grants every call the scanner makes.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DISCOVERY_ACTIONS } from '../src/scan.js';

const policy = JSON.parse(readFileSync(new URL('../../../infra/terraform/modules/access/discovery-policy.json', import.meta.url), 'utf8')) as { Statement: { Effect: string; Action: string[] | string; Resource: string }[] };

describe('discovery role policy', () => {
  it('grants every action of the scanner, read-only', () => {
    const granted = policy.Statement.filter((s) => s.Effect === 'Allow').flatMap((s) => [s.Action].flat());
    expect(DISCOVERY_ACTIONS.filter((a) => !granted.includes(a))).toEqual([]);
    expect(granted.filter((a) => !/:(Describe|List|Get)/.test(a))).toEqual([]);
  });

  it('reads the CloudTrail trails of each region (event refresh, packaging design §5)', () => {
    expect(DISCOVERY_ACTIONS).toEqual(expect.arrayContaining(['cloudtrail:DescribeTrails', 'cloudtrail:GetTrailStatus', 'cloudtrail:GetEventSelectors']));
  });
});
