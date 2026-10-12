// The manager's own IAM where a mistake would widen what a Lambda can do (packaging design §3): discovery stays read-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const discovery = readFileSync(new URL('../infra/terraform/platform/discovery.tf', import.meta.url), 'utf8');
const statement = (sid) => discovery.slice(discovery.indexOf(`sid       = "${sid}"`)).split('statement {')[0];

test('discovery may invoke the access check function only, never the operations function', () => {
  assert.match(statement('CheckCommandRoles'), /resources = \[aws_lambda_function\.access_check\.arn\]/);
  const policy = discovery.slice(discovery.indexOf('data "aws_iam_policy_document" "discovery"'), discovery.indexOf('resource "aws_iam_role_policy" "discovery"'));
  assert.doesNotMatch(policy, /aws_lambda_function\.operations/);
  assert.doesNotMatch(policy, /role\/\$\{var\.command_role_name\}/);
});

const platform = (file) => readFileSync(new URL(`../infra/terraform/platform/${file}`, import.meta.url), 'utf8');

test('the manager\'s own account gets the organization roles from the access module, optional, trusting a list of environments', () => {
  // R5a review I2: a second environment in the same account (B4's throwaway install) creates none of them, the first
  // one trusts both.
  const roles = platform('discovery.tf').slice(platform('discovery.tf').indexOf('module "organization_roles"')).split('\n}\n')[0];
  assert.match(roles, /source\s+= "\.\.\/modules\/access"/);
  assert.match(roles, /count\s+= var\.create_organization_roles \? 1 : 0/);
  assert.match(roles, /envs\s+= local\.organization_role_envs/);
  assert.doesNotMatch(platform('operations.tf'), /module "command_role"/);
  // Their state is kept: moved, not recreated.
  assert.match(platform('discovery.tf'), /moved \{\s+from = module\.discovery_role\s+to\s+= module\.organization_roles\[0\]\s+\}/);
  assert.match(platform('discovery.tf'), /moved \{\s+from = module\.command_role\s+to\s+= module\.organization_roles\[0\]\.module\.command_role\[0\]\s+\}/);
  assert.match(platform('variables.tf'), /variable "create_organization_roles"/);
  assert.match(platform('variables.tf'), /variable "organization_role_envs"/);
});
