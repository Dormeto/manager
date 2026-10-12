// The artifacts of a release (packaging design §4, plans B1 and B2): the layout the manager module reads, assembled from
// the manager's builds and the router bundle of the pinned version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { assembleArtifacts } from './artifacts.mjs';

function fakeRepos({ without = [] } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'dmt-artifacts-'));
  const files = {
    'manager/package.json': JSON.stringify({ version: '0.2.0' }),
    'manager/packages/api/dist/index.mjs': 'api',
    'manager/packages/discovery/dist/index.mjs': 'discovery',
    'manager/packages/operations/dist/index.mjs': 'operations',
    'manager/packages/operations/dist/check.mjs': 'check',
    'manager/packages/fleet/dist/index.mjs': 'fleet',
    'manager/packages/dashboard/dist/index.html': '<html>',
    'manager/packages/dashboard/dist/assets/app-1a2b.js': 'app',
    'router/package.json': JSON.stringify({ version: '0.22.6' }),
    'router/dist/router-0.22.6.zip': 'zip',
    'router/dist/blueprint-0.22.6.json': '{}',
    'router/dist/router-boundary.json': '{"Version":"2012-10-17"}',
  };
  for (const [path, content] of Object.entries(files)) {
    if (without.includes(path)) continue;
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), content);
  }
  return { manager: join(base, 'manager'), router: join(base, 'router'), out: join(base, 'out') };
}

test('assembles the layout the manager module reads, with the versions in the manifest', () => {
  const repos = fakeRepos();
  const files = assembleArtifacts(repos);
  assert.deepEqual(files, [
    'dashboard/assets/app-1a2b.js', 'dashboard/index.html',
    'lambda/api/index.mjs', 'lambda/discovery/index.mjs', 'lambda/fleet/index.mjs', 'lambda/operations/check.mjs', 'lambda/operations/index.mjs',
    'manifest.json',
    'router/blueprint.json', 'router/router-boundary.json', 'router/router.zip',
  ]);
  assert.deepEqual(JSON.parse(readFileSync(join(repos.out, 'manifest.json'), 'utf8')), { version: '0.2.0', router: '0.22.6' });
  assert.equal(readFileSync(join(repos.out, 'lambda/operations/check.mjs'), 'utf8'), 'check');
  assert.equal(readFileSync(join(repos.out, 'router/router.zip'), 'utf8'), 'zip');
});

test('a missing build output stops with its path', () => {
  const repos = fakeRepos({ without: ['manager/packages/operations/dist/check.mjs'] });
  assert.throws(() => assembleArtifacts(repos), /missing build output: .*packages\/operations\/dist\/check\.mjs/);
  const router = fakeRepos({ without: ['router/dist/router-0.22.6.zip'] });
  assert.throws(() => assembleArtifacts(router), /missing build output: .*router\/dist\/router-0\.22\.6\.zip/);
});
