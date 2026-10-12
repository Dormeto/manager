#!/usr/bin/env node
// Signed-in screenshots of the dashboard (dev): the smoke user's tokens are stored where oidc-client-ts reads them,
// then each view is captured with headless Edge or Chrome (DevTools protocol).
// Usage: node scripts/screenshots.mjs --out <dir> [--env dev] [--width 1440] [--route /path ...]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { fromIni } from '@aws-sdk/credential-providers';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const env = option('env', 'dev');
const base = `https://app.${env}.dormeto.com`;
const out = option('out', join(tmpdir(), 'dormeto-screenshots'));
const width = Number(option('width', '1440'));
const routes = args.flatMap((a, i) => (a === '--route' ? [args[i + 1]] : []));
const browser = process.env.BROWSER ?? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const region = 'eu-west-1';
const credentials = fromIni({ profile: process.env.AWS_PROFILE ?? 'kloudy-dormeto-prd' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const smoke = JSON.parse((await new SSMClient({ region, credentials }).send(new GetParameterCommand({ Name: `/dmt-${env}/manager/smoke`, WithDecryption: true }))).Parameter.Value);
const tokens = (await new CognitoIdentityProviderClient({ region, credentials }).send(new InitiateAuthCommand({
  ClientId: smoke.clientId, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: smoke.username, PASSWORD: smoke.password },
}))).AuthenticationResult;
const config = await (await fetch(`${base}/config.json`)).json();
const profile = JSON.parse(Buffer.from(tokens.IdToken.split('.')[1], 'base64url').toString());
const user = {
  id_token: tokens.IdToken, access_token: tokens.AccessToken, refresh_token: tokens.RefreshToken, token_type: 'Bearer',
  scope: 'openid email profile', profile, expires_at: Math.floor(Date.now() / 1000) + tokens.ExpiresIn,
};

const port = 9333;
const proc = spawn(browser, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`,
  `--user-data-dir=${join(tmpdir(), `dmt-shots-${Date.now()}`)}`, '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });
try {
  let version;
  for (let i = 0; i < 50 && !version; i += 1) {
    version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).catch(() => null);
    if (!version) await sleep(200);
  }
  const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    id += 1;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });

  const mobile = width < 600;
  await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile });
  await send('Page.navigate', { url: `${base}/favicon.svg` });
  await sleep(1500);
  await send('Runtime.evaluate', { expression: `sessionStorage.setItem(${JSON.stringify(`oidc.user:${config.authority}:${config.clientId}`)}, ${JSON.stringify(JSON.stringify(user))})` });
  mkdirSync(out, { recursive: true });
  for (const route of routes.length ? routes : ['/', '/workloads', '/discovery']) {
    await send('Page.navigate', { url: `${base}${route}` });
    await sleep(5000);
    const { result } = await send('Runtime.evaluate', { expression: 'document.documentElement.scrollHeight', returnByValue: true });
    const height = Math.min(Math.max(result.value, 800), 6000);
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    await sleep(500);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const file = join(out, `${route === '/' ? 'overview' : route.slice(1).replaceAll('/', '_')}-${width}.png`);
    writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
    console.log(file);
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile });
  }
  socket.close();
} finally {
  proc.kill();
}
