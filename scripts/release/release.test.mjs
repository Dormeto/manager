// A release (packaging design §4, plan B2): the manager module with its artifacts, the access and organization modules,
// the CLI procedure, checksums and the changelog; published once per version (review focus 5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildRelease, publishRelease } from './release.mjs';
import { fakeRepos } from './fake-repos.mjs';

const MODULES = new URL('../../infra/terraform/modules/', import.meta.url).pathname;
const entries = (zip) => execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n').filter((e) => !e.endsWith('/')).sort();
const build = (options = {}) => { const repos = fakeRepos(options); return { repos, release: buildRelease({ ...repos, modules: MODULES, version: '0.2.0' }) }; };

test('a release holds the module with its artifacts, the access and organization modules, the CLI procedure, checksums and the changelog', () => {
  const { release } = build();
  assert.deepEqual(readdirSync(release.dir).sort(), [
    'CHANGELOG.md', 'SHA256SUMS', 'dormeto-access-0.2.0.zip', 'dormeto-access-commands-0.2.0.sh', 'dormeto-organization-0.2.0.zip',
    'dormeto-organization-policy.json', 'terraform-aws-dormeto-0.2.0.zip',
  ]);
  const manager = entries(join(release.dir, 'terraform-aws-dormeto-0.2.0.zip'));
  for (const file of ['modules/manager/variables.tf', 'modules/manager/README.md', 'modules/manager/artifacts/manifest.json', 'modules/manager/artifacts/lambda/access-check.zip',
    'modules/manager/artifacts/dashboard/index.html', 'modules/manager/artifacts/router/router.zip', 'modules/access/main.tf', 'modules/access/router-boundary.json',
    'modules/access/command-role/main.tf', 'modules/access/command-role/command-policy.json']) {
    assert.ok(manager.includes(file), file);
  }
  // Nothing of the repository's tests, local state or builds.
  assert.deepEqual(manager.filter((e) => /(^|\/)(tests|\.terraform|\.build)\/|\.lock\.hcl$/.test(e)), []);
  assert.deepEqual(entries(join(release.dir, 'dormeto-access-0.2.0.zip')), ['command-role/command-policy.json', 'command-role/main.tf', 'discovery-policy.json', 'main.tf', 'router-boundary.json']);
  assert.deepEqual(entries(join(release.dir, 'dormeto-organization-0.2.0.zip')), ['main.tf', 'organization-policy.json']);
  assert.equal(readFileSync(join(release.dir, 'CHANGELOG.md'), 'utf8').trim(), '## 0.2.0 — 2026-10-06\n\n- The manager as a Terraform module.');
  // The checksums: every other file, sha256sum's format.
  const sums = readFileSync(join(release.dir, 'SHA256SUMS'), 'utf8').trim().split('\n');
  assert.equal(sums.length, 6);
  for (const line of sums) {
    const [hash, file] = line.split('  ');
    assert.equal(hash, createHash('sha256').update(readFileSync(join(release.dir, file))).digest('hex'), file);
  }
});

test('a release holds no account-specific value', () => {
  assert.throws(() => build({ with: { 'manager/packages/dashboard/dist/assets/app-1a2b.js': 'fetch("https://x.121014831971.example")' } }), /account-specific value 121014831971 in .*dashboard\/assets\/app-1a2b\.js/);
  // Inside a function's bundle too, zipped in the release.
  assert.throws(() => build({ with: { 'manager/packages/api/dist/index.mjs': 'const org = "o-vvk0115ixn";' } }), /account-specific value o-vvk0115ixn in .*api\/dist\/index\.mjs/);
});

test('a missing build output or changelog section stops the release', () => {
  assert.throws(() => build({ without: ['manager/packages/fleet/dist/index.mjs'] }), /missing build output: .*fleet\/dist\/index\.mjs/);
  assert.throws(() => build({ with: { 'manager/CHANGELOG.md': '# Changelog\n\n## 0.1.0\n\n- First.\n' } }), /CHANGELOG\.md has no section for 0\.2\.0/);
});

// A fake S3: objects in a map; conditional puts as S3's (If-None-Match: *).
function fakeS3(objects = {}) {
  const puts = [];
  return {
    objects, puts,
    async send(command) {
      const name = command.constructor.name;
      const input = command.input;
      if (name === 'ListObjectsV2Command') {
        const keys = Object.keys(objects).filter((k) => k.startsWith(input.Prefix));
        return { KeyCount: keys.length, Contents: keys.map((Key) => ({ Key })) };
      }
      if (name === 'GetObjectCommand') {
        if (!(input.Key in objects)) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
        return { Body: { transformToString: async () => objects[input.Key] } };
      }
      if (name === 'PutObjectCommand') {
        if (input.IfNoneMatch === '*' && input.Key in objects) throw Object.assign(new Error('PreconditionFailed'), { name: 'PreconditionFailed' });
        objects[input.Key] = String(input.Body); puts.push(input);
        return {};
      }
      throw new Error(`unexpected ${name}`);
    },
  };
}

test('publishes every file under its version, then moves latest.json forward', async () => {
  const { release } = build();
  const s3 = fakeS3({ 'manager/latest.json': JSON.stringify({ version: '0.1.0' }) });
  await publishRelease({ s3, bucket: 'releases', version: '0.2.0', router: '0.22.6', dir: release.dir, now: () => '2026-10-06T20:00:00.000Z' });
  assert.deepEqual(s3.puts.map((p) => p.Key), [...readdirSync(release.dir).filter((f) => f !== 'SHA256SUMS').sort().map((f) => `manager/0.2.0/${f}`), 'manager/0.2.0/SHA256SUMS', 'manager/latest.json']);
  assert.ok(s3.puts.slice(0, -1).every((p) => p.IfNoneMatch === '*' && p.CacheControl.includes('immutable')));
  assert.equal(s3.puts.find((p) => p.Key.endsWith('.zip')).ContentType, 'application/zip');
  assert.deepEqual(JSON.parse(s3.objects['manager/latest.json']), { version: '0.2.0', router: '0.22.6', published: '2026-10-06T20:00:00.000Z' });
  assert.equal(s3.puts.at(-1).CacheControl, 'no-cache');
});

test('a version present in the bucket is refused before anything is written; an older one never moves latest.json', async () => {
  const { release } = build();
  const present = fakeS3({ 'manager/0.2.0/SHA256SUMS': 'x' });
  await assert.rejects(publishRelease({ s3: present, bucket: 'releases', version: '0.2.0', router: '0.22.6', dir: release.dir }), /0\.2\.0 is already published/);
  assert.equal(present.puts.length, 0);
  const newer = fakeS3({ 'manager/latest.json': JSON.stringify({ version: '0.10.0' }) });
  await publishRelease({ s3: newer, bucket: 'releases', version: '0.2.0', router: '0.22.6', dir: release.dir });
  assert.equal(JSON.parse(newer.objects['manager/latest.json']).version, '0.10.0');
});
