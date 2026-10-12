// The manager's own IAM where a mistake would widen what a Lambda can do (packaging design §3): discovery stays read-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const discovery = readFileSync(new URL('../infra/terraform/modules/manager/discovery.tf', import.meta.url), 'utf8');
const statement = (sid) => discovery.slice(discovery.indexOf(`sid       = "${sid}"`)).split('statement {')[0];

test('discovery may invoke the access check function only, never the operations function', () => {
  assert.match(statement('CheckCommandRoles'), /resources = \[aws_lambda_function\.access_check\.arn\]/);
  const policy = discovery.slice(discovery.indexOf('data "aws_iam_policy_document" "discovery"'), discovery.indexOf('resource "aws_iam_role_policy" "discovery"'));
  assert.doesNotMatch(policy, /aws_lambda_function\.operations/);
  assert.doesNotMatch(policy, /role\/\$\{var\.command_role_name\}/);
});

// Platform's resources live in the manager module since R5b (B1).
const platform = (file) => readFileSync(new URL(`../infra/terraform/modules/manager/${file}`, import.meta.url), 'utf8');

test('the manager\'s own account gets the organization roles from the access module, optional, trusting a list of environments', () => {
  // R5a review I2: a second environment in the same account (B4's throwaway install) creates none of them, the first
  // one trusts both. (Dev's state moved from module.discovery_role and module.command_role in R5a; B1's moved.tf since.)
  const roles = platform('discovery.tf').slice(platform('discovery.tf').indexOf('module "organization_roles"')).split('\n}\n')[0];
  assert.match(roles, /source\s+= "\.\.\/access"/);
  assert.match(roles, /count\s+= var\.create_organization_roles \? 1 : 0/);
  assert.match(roles, /envs\s+= local\.organization_role_envs/);
  assert.doesNotMatch(platform('operations.tf'), /module "command_role"/);
  assert.match(platform('variables.tf'), /variable "create_organization_roles"/);
  assert.match(platform('variables.tf'), /variable "organization_role_envs"/);
});

test('the access check function, running as the operations role, may write its logs', () => {
  // Found live after the R5a fix pass: the role's logs statement named the operations log group only.
  const operations = platform('operations.tf');
  const policy = operations.slice(operations.indexOf('data "aws_iam_policy_document" "operations"'), operations.indexOf('resource "aws_iam_role_policy" "operations"'));
  const logs = policy.slice(policy.lastIndexOf('statement {', policy.indexOf('logs:PutLogEvents'))).split('statement {')[1];
  assert.match(logs, /aws_cloudwatch_log_group\.access_check\.arn/);
  assert.match(logs, /aws_cloudwatch_log_group\.operations\.arn/);
});
