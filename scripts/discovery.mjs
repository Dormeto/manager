#!/usr/bin/env node
// Organization discovery through the manager API, as the smoke user (dev): save a perimeter, run, print the result.
// Usage: node scripts/discovery.mjs [--env dev] [--config <file.json>] [--run] [--show] [--dismiss <id> --note <text>] [--restore <id>]
import { readFileSync } from 'node:fs';
import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { fromIni } from '@aws-sdk/credential-providers';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(`--${name}`);
  return at < 0 ? undefined : args[at + 1]?.startsWith('--') || args[at + 1] === undefined ? true : args[at + 1];
};
const env = option('env') ?? 'dev';
const base = `https://app.${env}.dormeto.com/api`;
const region = 'eu-west-1';
const credentials = fromIni({ profile: process.env.AWS_PROFILE ?? 'kloudy-dormeto-prd' });
const smoke = JSON.parse((await new SSMClient({ region, credentials }).send(new GetParameterCommand({ Name: `/dmt-${env}/manager/smoke`, WithDecryption: true }))).Parameter.Value);
const token = (await new CognitoIdentityProviderClient({ region, credentials }).send(new InitiateAuthCommand({
  ClientId: smoke.clientId, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: smoke.username, PASSWORD: smoke.password },
}))).AuthenticationResult.IdToken;
const call = async (path, init = {}) => {
  const res = await fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${JSON.stringify(body)}`);
  return body;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const file = option('config');
if (typeof file === 'string') {
  const saved = await call('/discovery/config', { method: 'PUT', body: readFileSync(file, 'utf8') });
  console.log(`perimeter saved: ${saved.config.filters.length} filters, ${saved.config.globalExcludes.length} global excludes`);
  for (const f of saved.lint) console.log(`  lint ${f.level}: ${f.message}`);
}
for (const action of ['dismiss', 'restore']) {
  const id = option(action);
  if (typeof id !== 'string') continue;
  const note = option('note');
  const { candidates } = await call(`/discovery/${action}`, { method: 'POST', body: JSON.stringify({ ids: [id], ...(typeof note === 'string' ? { note } : {}) }) });
  for (const c of candidates) console.log(`${action}: ${c.id} → ${c.status} (${c.statusReason}), history ${c.history.map((h) => h.status).join(' > ')}`);
}
if (option('run')) {
  const before = (await call('/discovery')).lastRun?.startedAt;
  await call('/discovery/run', { method: 'POST' });
  for (let i = 0; i < 180; i += 1) {
    await sleep(5000);
    if ((await call('/discovery')).lastRun?.startedAt !== before) break;
  }
}
if (option('show') || option('run')) {
  const { lastRun, candidates } = await call('/discovery');
  if (!lastRun) {
    console.log('no run yet');
    process.exit(0);
  }
  const seconds = Math.round((Date.parse(lastRun.finishedAt) - Date.parse(lastRun.startedAt)) / 1000);
  console.log(`last run ${lastRun.startedAt} (${lastRun.trigger}${lastRun.by ? ` by ${lastRun.by}` : ''}): ${lastRun.status}${lastRun.error ? ` ${lastRun.error}` : ''}, ${seconds} s, counts ${JSON.stringify(lastRun.counts)}`);
  for (const t of lastRun.targets.filter((t) => t.status !== 'skipped')) console.log(`  ${t.account}/${t.region} ${t.status}${t.error ? `: ${t.error}` : ` ${t.rules} rules, ${t.ms} ms`}`);
  for (const s of lastRun.skipped ?? []) console.log(`  ${s.pairs} pairs of ${s.accounts} accounts skipped: ${s.reason}`);
  for (const f of lastRun.lint) console.log(`  lint ${f.level}: ${f.message}`);
  for (const c of candidates.sort((a, b) => a.account.localeCompare(b.account) || a.region.localeCompare(b.region))) {
    console.log(`  ${c.status.padEnd(19)} ${c.account} ${c.region} ${c.loadBalancer} ${c.conditions} — ${c.statusReason}`);
  }
}
