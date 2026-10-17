// The demo mode never reaches a build (PR #1's review, must fix 1): a production build of the dashboard holds none of it, as
// the release checks it (artifacts.mjs); the build refuses VITE_MOCK; and even past that refusal, src/mock is loaded only
// in development (src/mock/enabled.ts), so a build leaves it out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
import vuetify from 'vite-plugin-vuetify';
import { demoIn } from './artifacts.mjs';

const dashboard = fileURLToPath(new URL('../../packages/dashboard', import.meta.url));
const viteBin = fileURLToPath(new URL('../../node_modules/vite/bin/vite.js', import.meta.url));
const outDir = () => mkdtempSync(join(tmpdir(), 'dmt-dashboard-'));
// vite build as npm run build runs it (in the dashboard's directory), without the caller's VITE_MOCK or NODE_ENV.
function viteBuild(out, env = {}, ...args) {
  const { VITE_MOCK: _mock, NODE_ENV: _node, ...inherited } = process.env;
  return spawnSync(process.execPath, [viteBin, 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'error', ...args],
    { cwd: dashboard, env: { ...inherited, ...env }, encoding: 'utf8' });
}

test('a production build of the dashboard holds no demo mode, as the release checks it', () => {
  const out = outDir();
  const built = viteBuild(out);
  assert.equal(built.status, 0, built.stderr);
  assert.deepEqual(demoIn(out), []);
});

test('the build refuses VITE_MOCK, in any mode', () => {
  for (const args of [[], ['--mode', 'development']]) {
    const out = outDir();
    const built = viteBuild(out, { VITE_MOCK: '1' }, ...args);
    assert.notEqual(built.status, 0, `built with VITE_MOCK=1 ${args.join(' ')}`);
    assert.match(built.stderr, /VITE_MOCK is set: the demo mode .* never goes into a build/);
    assert.deepEqual(demoIn(out), []);
  }
});

test('past that refusal, a build with VITE_MOCK=1 still leaves the demo mode out: it is loaded only in development', async () => {
  // The dashboard's plugins without its configuration (and its refusal), VITE_MOCK in the environment.
  const out = outDir();
  const saved = { mock: process.env.VITE_MOCK, node: process.env.NODE_ENV };
  process.env.VITE_MOCK = '1';
  delete process.env.NODE_ENV;
  try {
    await build({ root: dashboard, configFile: false, logLevel: 'silent', plugins: [vue(), vuetify({ autoImport: true })], build: { outDir: out, emptyOutDir: true } });
  } finally {
    if (saved.mock === undefined) delete process.env.VITE_MOCK; else process.env.VITE_MOCK = saved.mock;
    if (saved.node === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.node;
  }
  assert.deepEqual(demoIn(out), []);
});
