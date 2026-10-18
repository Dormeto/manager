// The artifacts of a release (packaging design §4, plans B1 and B2): the layout the manager module reads, assembled from
// the manager's builds and the router bundle of the pinned version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { assembleArtifacts } from './artifacts.mjs';
import { fakeRepos } from './fake-repos.mjs';

test('assembles the layout the manager module reads, with the versions in the manifest', () => {
  const repos = fakeRepos();
  const files = assembleArtifacts(repos);
  assert.deepEqual(files, [
    'dashboard/assets/app-1a2b.js', 'dashboard/index.html',
    'lambda/access-check.zip', 'lambda/api.zip', 'lambda/discovery.zip', 'lambda/fleet.zip', 'lambda/operations.zip', 'lambda/savings.zip', 'lambda/update-check.zip', 'lambda/watchdog.zip',
    'manifest.json',
    'router/blueprint.json', 'router/router-boundary.json', 'router/router.zip',
  ]);
  assert.deepEqual(JSON.parse(readFileSync(join(repos.out, 'manifest.json'), 'utf8')), { version: '0.2.0', router: '0.22.6' });
  // Each function's zip, ready to upload: nothing is written at plan time (R5b review M6).
  const entry = (zip) => execFileSync('unzip', ['-Z1', join(repos.out, 'lambda', zip)], { encoding: 'utf8' }).trim();
  assert.equal(entry('api.zip'), 'index.mjs');
  assert.equal(entry('access-check.zip'), 'check.mjs');
  assert.equal(entry('watchdog.zip'), 'watchdog.mjs');
  assert.equal(entry('savings.zip'), 'savings.mjs');
  assert.equal(entry('update-check.zip'), 'update-check.mjs');
  assert.equal(execFileSync('unzip', ['-p', join(repos.out, 'lambda/access-check.zip'), 'check.mjs'], { encoding: 'utf8' }), 'check');
  assert.equal(readFileSync(join(repos.out, 'router/router.zip'), 'utf8'), 'zip');
});

test('the manifest names the given version; without one, the manager package version', () => {
  const repos = fakeRepos();
  assembleArtifacts({ ...repos, version: '9.9.9-dev.1' });
  assert.equal(JSON.parse(readFileSync(join(repos.out, 'manifest.json'), 'utf8')).version, '9.9.9-dev.1');
  assembleArtifacts(repos);
  assert.equal(JSON.parse(readFileSync(join(repos.out, 'manifest.json'), 'utf8')).version, '0.2.0');
});

test('a missing build output stops with its path', () => {
  const repos = fakeRepos({ without: ['manager/packages/operations/dist/check.mjs'] });
  assert.throws(() => assembleArtifacts(repos), /missing build output: .*packages\/operations\/dist\/check\.mjs/);
  const router = fakeRepos({ without: ['router/dist/router-0.22.6.zip'] });
  assert.throws(() => assembleArtifacts(router), /missing build output: .*router\/dist\/router-0\.22\.6\.zip/);
});

test('the router checkout must be the version the manager pins', () => {
  const repos = fakeRepos({ routerVersion: '0.23.0', pin: '0.22.6' });
  assert.throws(() => assembleArtifacts(repos), /router checkout is 0\.23\.0, the manager pins 0\.22\.6/);
});

test('the same builds give the same zips: an unchanged function is never redeployed', () => {
  const repos = fakeRepos();
  assembleArtifacts(repos);
  const first = readFileSync(join(repos.out, 'lambda/api.zip'));
  assembleArtifacts(repos);
  assert.ok(first.equals(readFileSync(join(repos.out, 'lambda/api.zip'))));
});

test('refuses a dashboard build holding the demo mode (its chunk or its markers), before writing anything', () => {
  for (const extra of [
    { 'manager/packages/dashboard/dist/assets/mock-9f8e.js': 'export const demo = 1;' },
    { 'manager/packages/dashboard/dist/assets/app-1a2b.js': 'sessionStorage.getItem("dormeto.demo")' },
    { 'manager/packages/dashboard/dist/assets/config-3c4d.js': 'const c = { authority: "https://example.invalid" };' },
  ]) {
    const repos = fakeRepos({ with: extra });
    assert.throws(() => assembleArtifacts(repos), /dashboard build holds the demo mode \(assets\/(mock-9f8e|app-1a2b|config-3c4d)\.js\): build it without VITE_MOCK/);
    assert.equal(existsSync(repos.out), false);
  }
});
