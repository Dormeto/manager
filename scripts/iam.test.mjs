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
