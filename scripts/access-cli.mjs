#!/usr/bin/env node
// The AWS CLI procedure of Dormeto's organization roles in one member account (vision docs/specs/2026-10-06-packaging-
// design.md, section 3), for teams without Terraform: the same documents as the access module.
// Usage: node scripts/access-cli.mjs --account <id> --manager-account <id> --env <env>[,<env>…] [--organization o-…] --boundary <file>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MODULES = new URL('../infra/terraform/modules/', import.meta.url);
const read = (path) => readFileSync(new URL(path, MODULES), 'utf8');
const compact = (json) => JSON.stringify(JSON.parse(json));
const fill = (json, account) => json.replaceAll('${account}', account).replaceAll('${partition}', 'aws');

export function accessCommands({ account, managerAccount, organizationId = null, envs, boundary, discoveryRole = 'DmtDiscoveryRole', commandRole = 'DmtCommandRole' }) {
  // Every environment sharing the account's roles, each trusted by its own roles, by name (as the access module).
  const roles = (suffix) => envs.map((env) => `arn:aws:iam::${managerAccount}:role/dmt-${env}-manager-${suffix}`);
  const discoveryTrust = {
    Version: '2012-10-17',
    Statement: [{
      Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${managerAccount}:root` }, Action: 'sts:AssumeRole',
      Condition: { ArnLike: { 'aws:PrincipalArn': roles('discovery') }, ...(organizationId ? { StringEquals: { 'aws:PrincipalOrgID': organizationId } } : {}) },
    }],
  };
  const commandTrust = {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${managerAccount}:root` }, Action: 'sts:AssumeRole', Condition: { ArnLike: { 'aws:PrincipalArn': roles('operations') } } }],
  };
  const q = (value) => `'${typeof value === 'string' ? value : JSON.stringify(value)}'`;
  return [
    `# In account ${account}, with administrator credentials of that account.`,
    `aws iam create-role --role-name ${discoveryRole} --max-session-duration 3600 --assume-role-policy-document ${q(discoveryTrust)} --tags Key=dormeto:component,Value=discovery`,
    `aws iam put-role-policy --role-name ${discoveryRole} --policy-name discovery --policy-document ${q(compact(read('access/discovery-policy.json')))}`,
    `aws iam create-policy --policy-name DmtRouterBoundary --policy-document ${q(compact(fill(boundary, account)))}`,
    `aws iam create-role --role-name ${commandRole} --max-session-duration 3600 --assume-role-policy-document ${q(commandTrust)}`,
    `aws iam put-role-policy --role-name ${commandRole} --policy-name command --policy-document ${q(compact(fill(read('command-role/command-policy.json'), account)))}`,
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name) => { const at = args.indexOf(`--${name}`); return at < 0 ? undefined : args[at + 1]; };
  console.log(accessCommands({
    account: option('account'), managerAccount: option('manager-account'), envs: (option('env') ?? '').split(','), organizationId: option('organization') ?? null,
    boundary: readFileSync(option('boundary') ?? new URL('../../router/dist/router-boundary.json', import.meta.url), 'utf8'),
  }).join('\n'));
}
