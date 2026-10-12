// The AWS CLI procedure of the organization roles (packaging design §3): the same documents as the Terraform modules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { accessCommands } from './access-cli.mjs';

const MODULES = new URL('../infra/terraform/modules/', import.meta.url);
const read = (path) => readFileSync(new URL(path, MODULES), 'utf8');

test('creates the discovery role, the boundary and the command role of an account, with the modules\' documents', () => {
  const lines = accessCommands({
    account: '222222222222', managerAccount: '121014831971', organizationId: 'o-vvk0115ixn', env: 'prod',
    boundary: readFileSync(new URL('../../router/dist/router-boundary.json', import.meta.url), 'utf8'),
  });
  const text = lines.join('\n');
  // The discovery role: trusted by the manager's discovery role within the organization, the module's policy.
  assert.match(text, /aws iam create-role --role-name DmtDiscoveryRole --max-session-duration 3600 --assume-role-policy-document '(.+)'/);
  const trust = JSON.parse(text.match(/create-role --role-name DmtDiscoveryRole --max-session-duration 3600 --assume-role-policy-document '(.+?)'/)[1]);
  assert.deepEqual(trust.Statement[0].Condition, { ArnLike: { 'aws:PrincipalArn': ['arn:aws:iam::121014831971:role/dmt-prod-manager-discovery'] }, StringEquals: { 'aws:PrincipalOrgID': 'o-vvk0115ixn' } });
  const discovery = JSON.parse(text.match(/put-role-policy --role-name DmtDiscoveryRole --policy-name discovery --policy-document '(.+?)'/)[1]);
  assert.deepEqual(discovery, JSON.parse(read('access/discovery-policy.json')));
  // The boundary and the command role, its policy filled for the account.
  assert.match(text, /aws iam create-policy --policy-name DmtRouterBoundary --policy-document '/);
  const command = JSON.parse(text.match(/put-role-policy --role-name DmtCommandRole --policy-name command --policy-document '(.+?)'/)[1]);
  assert.ok(JSON.stringify(command).includes('arn:aws:iam::222222222222:role/dormeto/router/*'));
  assert.ok(!JSON.stringify(command).includes('${account}'));
  const commandTrust = JSON.parse(text.match(/create-role --role-name DmtCommandRole --max-session-duration 3600 --assume-role-policy-document '(.+?)'/)[1]);
  assert.deepEqual(commandTrust.Statement[0].Principal, { AWS: 'arn:aws:iam::121014831971:role/dmt-prod-manager-operations' });
});
