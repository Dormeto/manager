#!/usr/bin/env node
// Signed-in screenshots of the dashboard (dev): the smoke user's tokens are stored where oidc-client-ts reads them,
// then each view is captured with headless Edge or Chrome (DevTools protocol).
// Usage: node scripts/screenshots.mjs --out <dir> [--env dev] [--width 1440] [--height <px>] [--scale 1] [--theme light|dark]
//   [--format png|webp] [--quality 80] [--mask <file>] [--focus <css selector>] [--route /path ...]
// --height keeps the viewport at width × height (no full page). --mask (JSON { "replacements": [["real", "example"], …] },
// kept outside the repository) replaces real identifiers by example values in the page before each capture (mask.mjs); an
// image in which one of them remains is not written, and the script exits 1.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { smokeTokens } from './smoke-signin.mjs';
import { fromIni } from '@aws-sdk/credential-providers';
import { exampleAccount, identifiers, maskText } from './mask.mjs';

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
const focus = option('focus'); // element to focus before the capture, for example to open its tooltip
const fixedHeight = option('height') ? Number(option('height')) : undefined;
const scale = Number(option('scale', '1'));
const theme = option('theme');
const format = option('format', 'png');
const quality = Number(option('quality', '80'));
const maskFile = option('mask');
const replacements = maskFile ? JSON.parse(readFileSync(maskFile, 'utf8')).replacements ?? [] : [];
const browser = process.env.BROWSER ?? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const region = 'eu-west-1';
const credentials = fromIni({ profile: process.env.AWS_PROFILE ?? 'kloudy-dormeto-prd' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { tokens } = await smokeTokens({ env, region, credentials });
const config = await (await fetch(`${base}/config.json`)).json();
const profile = JSON.parse(Buffer.from(tokens.IdToken.split('.')[1], 'base64url').toString());
const user = {
  id_token: tokens.IdToken, access_token: tokens.AccessToken, refresh_token: tokens.RefreshToken, token_type: 'Bearer',
  scope: 'openid email profile aws.cognito.signin.user.admin', profile, expires_at: Math.floor(Date.now() / 1000) + tokens.ExpiresIn,
};

const port = 9333;
const proc = spawn(browser, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`,
  `--user-data-dir=${join(tmpdir(), `dmt-shots-${Date.now()}`)}`, `--force-device-scale-factor=${scale}`, 'about:blank'], { stdio: 'ignore' });
// The page's text where identifiers show: text nodes, a few attributes, form values.
const PAGE_TEXT = `(() => { const parts = [document.body.textContent]; for (const e of document.querySelectorAll('[title],[aria-label],[placeholder],[alt]')) for (const a of ['title', 'aria-label', 'placeholder', 'alt']) if (e.hasAttribute(a)) parts.push(e.getAttribute(a)); for (const e of document.querySelectorAll('input, textarea')) parts.push(e.value); return parts.join('\\n'); })()`;
const MASK_PAGE = (list) => `(() => { ${exampleAccount}\n${maskText}\n const r = ${JSON.stringify(list)}; const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); for (let n = walker.nextNode(); n; n = walker.nextNode()) { const v = maskText(n.nodeValue, r); if (v !== n.nodeValue) n.nodeValue = v; } for (const e of document.querySelectorAll('[title],[aria-label],[placeholder],[alt]')) for (const a of ['title', 'aria-label', 'placeholder', 'alt']) if (e.hasAttribute(a)) e.setAttribute(a, maskText(e.getAttribute(a), r)); for (const e of document.querySelectorAll('input, textarea')) e.value = maskText(e.value, r); })()`;
let leaked = false;
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
  await send('Emulation.setDeviceMetricsOverride', { width, height: fixedHeight ?? 1000, deviceScaleFactor: scale, mobile });
  await send('Page.navigate', { url: `${base}/favicon.svg` });
  await sleep(1500);
  await send('Runtime.evaluate', { expression: `sessionStorage.setItem(${JSON.stringify(`oidc.user:${config.authority}:${config.clientId}`)}, ${JSON.stringify(JSON.stringify(user))})` });
  if (theme) await send('Runtime.evaluate', { expression: `localStorage.setItem('dmt-theme', ${JSON.stringify(theme)})` });
  mkdirSync(out, { recursive: true });
  for (const route of routes.length ? routes : ['/', '/workloads', '/discovery']) {
    await send('Page.navigate', { url: `${base}${route}` });
    await sleep(5000);
    if (!fixedHeight) {
      const { result } = await send('Runtime.evaluate', { expression: 'document.documentElement.scrollHeight', returnByValue: true });
      const height = Math.min(Math.max(result.value, 800), 6000);
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile });
    }
    if (focus) {
      // Hover the element (tooltips open on hover), after scrolling it into view.
      const { result: box } = await send('Runtime.evaluate', {
        expression: `(() => { const e = document.querySelector(${JSON.stringify(focus)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
        returnByValue: true,
      });
      if (box.value) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.value.x - 30, y: box.value.y });
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.value.x, y: box.value.y });
      }
      // Synthetic pointer events do not always reach the listeners: fire them on the element as well.
      await send('Runtime.evaluate', { expression: `(() => { const e = document.querySelector(${JSON.stringify(focus)}); e?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false })); e?.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false })); e?.focus(); })()` });
      await sleep(600);
      const { result: tip } = await send('Runtime.evaluate', { expression: `[...document.querySelectorAll('.v-overlay__content')].map((e) => e.textContent.trim()).filter(Boolean).join(' | ')`, returnByValue: true });
      console.log(`open overlays: ${tip.value || 'none'}`);
    }
    await sleep(800);
    const textOf = async () => (await send('Runtime.evaluate', { expression: PAGE_TEXT, returnByValue: true })).result.result.value ?? '';
    const real = maskFile ? identifiers(await textOf(), replacements) : [];
    if (maskFile) await send('Runtime.evaluate', { expression: MASK_PAGE(replacements) });
    const shot = await send('Page.captureScreenshot', { format, ...(format === 'png' ? {} : { quality }) });
    const name = `${route === '/' ? 'overview' : route.slice(1).replaceAll('/', '_')}-${width}${theme ? `-${theme}` : ''}.${format}`;
    const after = maskFile ? await textOf() : '';
    const left = real.filter((id) => after.includes(id));
    if (left.length) {
      leaked = true;
      console.error(`${name}: not written, identifiers left after masking: ${left.join(', ')}`);
    } else {
      const file = join(out, name);
      writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
      console.log(file);
    }
    await send('Emulation.setDeviceMetricsOverride', { width, height: fixedHeight ?? 1000, deviceScaleFactor: scale, mobile });
  }
  socket.close();
} finally {
  proc.kill();
}
if (leaked) process.exit(1);
