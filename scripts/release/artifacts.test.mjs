// The artifacts of a release (packaging design §4, plans B1 and B2): the layout the manager module reads, assembled from
// the manager's builds and the router bundle of the pinned version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleArtifacts } from './artifacts.mjs';
import { fakeRepos } from './fake-repos.mjs';

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

test('the router checkout must be the version the manager pins', () => {
  const repos = fakeRepos({ routerVersion: '0.23.0', pin: '0.22.6' });
  assert.throws(() => assembleArtifacts(repos), /router checkout is 0\.23\.0, the manager pins 0\.22\.6/);
});
