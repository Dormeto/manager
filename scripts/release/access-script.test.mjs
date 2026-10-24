// The AWS CLI procedure of a release (packaging design §3): one script with its settings at the top, run with
// administrator credentials of a member account, creating or updating the same roles as the access module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accessScript, organizationPolicy } from './access-script.mjs';

const MODULES = new URL('../../infra/terraform/modules/', import.meta.url);
const read = (path) => readFileSync(new URL(path, MODULES), 'utf8');
const BOUNDARY = '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:GetObject","Resource":"arn:${partition}:s3:::dmtr-${account}-*"}]}';

// A fake aws on the PATH: records each call, answers the reads from FAKE_* settings.
function run(settings, { existing = false, versions = '', caller = settings.ACCOUNT } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dmt-aws-'));
  const log = join(dir, 'calls.jsonl');
  writeFileSync(join(dir, 'aws'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const [service, command] = args;
if (service === 'sts' && command === 'get-caller-identity') { console.log(${JSON.stringify(caller)}); process.exit(0); }
if (['get-role', 'get-policy'].includes(command)) process.exit(${existing ? 0 : 254});
if (command === 'list-policy-versions') { console.log(${JSON.stringify(versions)}); process.exit(0); }
process.exit(0);
`);
  chmodSync(join(dir, 'aws'), 0o755);
  const script = join(dir, 'access.sh');
  writeFileSync(script, accessScript({ version: '0.2.0', discoveryPolicy: read('access/discovery-policy.json'), commandPolicy: read('access/command-role/command-policy.json'), boundary: BOUNDARY }));
  const result = spawnSync('bash', [script], { env: { PATH: `${dir}:${process.env.PATH}`, ...settings }, encoding: 'utf8' });
  let calls = [];
  try { calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* no call */ }
  return { ...result, calls };
}
const option = (call, name) => call[call.indexOf(`--${name}`) + 1];
const find = (calls, command, role) => calls.find((c) => c[1] === command && (!role || option(c, 'role-name') === role));
const SETTINGS = { ACCOUNT: '222222222222', MANAGER_ACCOUNT: '111111111111', ENVS: 'prod staging', ORGANIZATION: 'o-abcdefghij' };

test('creates the roles and the boundary of a fresh account with the access module\'s documents', () => {
  const { status, stderr, calls } = run({ ...SETTINGS, DISCOVERY_ROLE: 'team/DmtDiscoveryRole' });
  assert.equal(status, 0, stderr);
  const discovery = find(calls, 'create-role', 'DmtDiscoveryRole');
  assert.equal(option(discovery, 'path'), '/team/');
  assert.deepEqual(JSON.parse(option(discovery, 'assume-role-policy-document')).Statement, [{
    Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { AWS: 'arn:aws:iam::111111111111:root' },
    Condition: { ArnLike: { 'aws:PrincipalArn': ['arn:aws:iam::111111111111:role/dmt-prod-manager-discovery', 'arn:aws:iam::111111111111:role/dmt-staging-manager-discovery'] }, StringEquals: { 'aws:PrincipalOrgID': 'o-abcdefghij' } },
  }]);
  assert.deepEqual(JSON.parse(option(find(calls, 'put-role-policy', 'DmtDiscoveryRole'), 'policy-document')), JSON.parse(read('access/discovery-policy.json').replaceAll('${account}', '222222222222').replaceAll('${partition}', 'aws')));
  const command = find(calls, 'create-role', 'DmtCommandRole');
  assert.equal(option(command, 'path'), '/');
  assert.deepEqual(JSON.parse(option(command, 'assume-role-policy-document')).Statement[0].Condition, { ArnLike: { 'aws:PrincipalArn': ['arn:aws:iam::111111111111:role/dmt-prod-manager-operations', 'arn:aws:iam::111111111111:role/dmt-staging-manager-operations'] } });
  const policy = option(find(calls, 'put-role-policy', 'DmtCommandRole'), 'policy-document');
  assert.deepEqual(JSON.parse(policy), JSON.parse(read('access/command-role/command-policy.json').replaceAll('${account}', '222222222222').replaceAll('${partition}', 'aws')));
  const boundary = find(calls, 'create-policy');
  assert.equal(option(boundary, 'policy-name'), 'DmtRouterBoundary');
  assert.equal(JSON.parse(option(boundary, 'policy-document')).Statement[0].Resource, 'arn:aws:s3:::dmtr-222222222222-*');
});

test('updates the roles and the boundary of an account set up before: the trusts, the policies, a new default boundary version', () => {
  const { status, stderr, calls } = run(SETTINGS, { existing: true, versions: 'v1\tv2\tv3\tv4' });
  assert.equal(status, 0, stderr);
  assert.equal(find(calls, 'create-role'), undefined);
  assert.ok(find(calls, 'update-assume-role-policy', 'DmtDiscoveryRole'));
  assert.ok(find(calls, 'update-assume-role-policy', 'DmtCommandRole'));
  assert.ok(find(calls, 'put-role-policy', 'DmtCommandRole'));
  // IAM keeps five versions: the oldest non-default one goes first.
  assert.equal(option(find(calls, 'delete-policy-version'), 'version-id'), 'v1');
  assert.ok(find(calls, 'create-policy-version').includes('--set-as-default'));
});

test('without a command role: the discovery role only, tagged discovery only; the tag removed once a command role is set up', () => {
  const { status, calls } = run({ ...SETTINGS, COMMAND_ROLE: '' });
  assert.equal(status, 0);
  assert.ok(find(calls, 'create-role', 'DmtDiscoveryRole'));
  assert.ok(find(calls, 'tag-role', 'DmtDiscoveryRole').includes('Key=dormeto:command-role,Value=none'));
  const again = run({ ...SETTINGS }, { existing: true, versions: '' });
  assert.ok(find(again.calls, 'untag-role', 'DmtDiscoveryRole').includes('dormeto:command-role'));
  assert.equal(find(calls, 'create-role', 'DmtCommandRole'), undefined);
  assert.equal(find(calls, 'create-policy'), undefined);
});

test('refuses bad settings, or credentials of another account, before any change', () => {
  for (const bad of [{ ACCOUNT: '2222' }, { MANAGER_ACCOUNT: '' }, { ENVS: '' }, { ENVS: 'prod Bad' }, { ORGANIZATION: 'org' }, { DISCOVERY_ROLE: '/x/' }, { COMMAND_ROLE: "a'b" }]) {
    const { status, calls } = run({ ...SETTINGS, ...bad });
    assert.notEqual(status, 0, JSON.stringify(bad));
    assert.ok(calls.every((c) => c[0] !== 'iam'), JSON.stringify(bad));
  }
  const other = run(SETTINGS, { caller: '333333333333' });
  assert.notEqual(other.status, 0);
  assert.match(other.stderr, /credentials are of account 333333333333, not 222222222222/);
  assert.ok(other.calls.every((c) => c[0] !== 'iam'));
});

test('the organization policy of a release is the module\'s, its principal to fill', () => {
  const policy = JSON.parse(organizationPolicy(read('organization/organization-policy.json')));
  const module = JSON.parse(read('organization/organization-policy.json').replace('"${principals}"', '[]'));
  assert.deepEqual(policy.Statement[0].Principal, { AWS: ['arn:aws:iam::MANAGER_ACCOUNT:role/dmt-ENV-manager-discovery'] });
  assert.deepEqual({ ...policy.Statement[0], Principal: null }, { ...module.Statement[0], Principal: null });
});
