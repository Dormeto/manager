#!/usr/bin/env node
// Smoke test of a deployed manager: signs in as the smoke user (dev only) and checks the API through CloudFront,
// as the dashboard calls it. Usage: node scripts/smoke.mjs [--env dev] [--wake <router>/<workload>]
import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { fromIni } from '@aws-sdk/credential-providers';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const env = option('env', 'dev');
const base = option('url', `https://app.${env === 'prod' ? '' : `${env}.`}dormeto.com`);
const region = 'eu-west-1';
const credentials = fromIni({ profile: process.env.AWS_PROFILE ?? 'kloudy-dormeto-prd' });

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

async function call(path, { token, method = 'GET' } = {}) {
  const started = performance.now();
  const res = await fetch(`${base}/api${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const body = await res.json().catch(() => null);
  return { status: res.status, body, ms: Math.round(performance.now() - started) };
}

const smoke = JSON.parse((await new SSMClient({ region, credentials }).send(new GetParameterCommand({ Name: `/dmt-${env}/manager/smoke`, WithDecryption: true }))).Parameter.Value);
const auth = await new CognitoIdentityProviderClient({ region, credentials }).send(new InitiateAuthCommand({
  ClientId: smoke.clientId, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: smoke.username, PASSWORD: smoke.password },
}));
const token = auth.AuthenticationResult.IdToken;
console.log(`Manager ${base} · signed in as ${smoke.username}`);

const health = await call('/health');
check(health.status === 200 && health.body?.status === 'ok', 'health without token', `${health.status} version ${health.body?.version} (${health.ms} ms)`);
const anonymous = await call('/workloads');
check(anonymous.status === 401, 'workloads without token are refused', String(anonymous.status));
const me = await call('/me', { token });
check(me.status === 200 && me.body?.role === 'admin', 'identity and role', `${me.body?.email} ${me.body?.role}`);
const routers = await call('/routers', { token });
check(routers.status === 200 && routers.body?.routers?.every((r) => !r.error), 'routers reachable', (routers.body?.routers ?? []).map((r) => `${r.name} ${r.version} (${r.workloads})`).join(', '));
const workloads = await call('/workloads', { token });
check(workloads.status === 200 && workloads.body?.workloads?.length > 0 && workloads.body.errors.length === 0, 'workloads',
  `${(workloads.body?.workloads ?? []).map((w) => `${w.workloadId} ${w.state}`).join(', ')} (${workloads.ms} ms)`);
const first = workloads.body?.workloads?.[0];
if (first) {
  const status = await call(`/workloads/${first.router}/${first.workloadId}`, { token });
  check(status.status === 200 && status.body?.workloadId === first.workloadId && Array.isArray(status.body?.backends), `status of ${first.workloadId}`,
    `${status.body?.state}, route ${status.body?.route}, ${status.body?.backends?.length} backends (${status.ms} ms)`);
}
for (const router of routers.body?.routers ?? []) {
  const discovery = await call(`/discovery/${router.name}`, { token });
  const managed = (discovery.body?.candidates ?? []).filter((c) => c.status === 'managed').length;
  check(discovery.status === 200 && managed === router.workloads, `discovery of ${router.name}`, `${discovery.body?.candidates?.length} rules, ${managed} managed (${discovery.ms} ms)`);
}
const wake = option('wake');
if (wake) {
  const result = await call(`/workloads/${wake}/wake`, { token, method: 'POST' });
  check(result.status === 200, `wake ${wake}`, JSON.stringify(result.body));
}
const cycle = option('cycle');
if (cycle) {
  // Nap then wake through the API, as an operator would from the dashboard.
  const waitFor = async (wanted, seconds) => {
    const started = Date.now();
    for (;;) {
      const state = (await call(`/workloads/${cycle}`, { token })).body?.state;
      if (state === wanted) return Math.round((Date.now() - started) / 1000);
      if (Date.now() - started > seconds * 1000) throw new Error(`${cycle} is ${state}, expected ${wanted} within ${seconds} s`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  };
  const nap = await call(`/workloads/${cycle}/nap`, { token, method: 'POST' });
  check(nap.status === 202, `nap ${cycle} requested`, String(nap.status));
  check(true, `${cycle} asleep`, `after ${await waitFor('ASLEEP', 300)} s`);
  const wake = await call(`/workloads/${cycle}/wake`, { token, method: 'POST' });
  check(wake.status === 200 && wake.body?.state === 'WAKING', `wake ${cycle}`, JSON.stringify(wake.body));
  check(true, `${cycle} awake`, `after ${await waitFor('AWAKE', 600)} s`);
  const entries = (await call('/audit', { token })).body?.entries ?? [];
  check(['nap', 'wake'].every((a) => entries.some((e) => e.action === a && e.target === cycle)), 'nap and wake audited');
}
const users = await call('/users', { token });
check(users.status === 200 && users.body?.users?.some((u) => u.email === smoke.username && u.role === 'admin'), 'users', (users.body?.users ?? []).map((u) => `${u.email} ${u.role}`).join(', '));
const audit = await call('/audit', { token });
check(audit.status === 200 && Array.isArray(audit.body?.entries), 'audit', `${audit.body?.entries?.length} entries`);

console.log(failures ? `RESULT: ${failures} failed` : 'RESULT: PASSED');
process.exit(failures ? 1 : 0);
