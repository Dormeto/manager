// The CHANGELOG, as dormeto-release manager turns it: the Unreleased section becomes the version's, headed by its
// "Router … Access: …" line. The section may hold one "Access: …" paragraph, written with the change that makes the
// member accounts apply something again: the release moves it into that line, so it runs with no --access. These tests
// pass before and after a release: none needs the Unreleased section to be there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url).pathname;
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const unreleased = changelog.split(/^## Unreleased\n/m)[1]?.split(/^## /m)[0] ?? '';
// Every entry of every section: each top-level bullet with its lines.
const entries = changelog.split(/^(?=- \*\*)|^(?=## )/m).filter((e) => e.startsWith('- **'));

test('the Unreleased section has no Router line written by hand, and one Access paragraph at most, before its entries', () => {
  assert.doesNotMatch(unreleased, /^\*\*Router\b|^Router \d/m);
  assert.ok((unreleased.match(/^Access: /gm) ?? []).length <= 1);
  if (/^Access: /m.test(unreleased)) assert.match(unreleased, /^\nAccess: /, 'the paragraph opens the section');
});

// What the member accounts apply, as the release tool compares it with the latest release (the routers' boundary and
// Kubernetes rights come from the router: the tool compares those).
test('a change of the access or organization module since the latest release has its Access paragraph in Unreleased', (t) => {
  if (!/^## Unreleased\n/m.test(changelog)) return t.skip('no Unreleased section: a release is being made');
  const latest = changelog.match(/^## (\d+\.\d+\.\d+) /m)?.[1];
  let changed;
  try {
    changed = execFileSync('git', ['-C', root, 'diff', '--name-only', `v${latest}`, 'HEAD', '--', 'infra/terraform/modules/access', 'infra/terraform/modules/organization',
      'scripts/release/access-script.mjs', ':(exclude)infra/terraform/modules/*/tests/*', ':(exclude)*.terraform.lock.hcl'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return t.skip(`no tag v${latest} in this checkout`);
  }
  if (changed) assert.match(unreleased, /^Access: apply /m, `changed since ${latest}: ${changed.split('\n').join(', ')}`);
});

test('the standalone workloads entry is one, says what to apply, and names no version', () => {
  const standalone = entries.filter((e) => /^- \*\*Standalone workloads on AWS and Google Cloud/.test(e));
  assert.equal(standalone.length, 1, 'one entry for standalone workloads');
  const [entry] = standalone;
  assert.doesNotMatch(entry, /\b\d+\.\d+\.\d+\b/);
  for (const said of ['`standalone`', 'rds:DescribeDBInstances', 'rds:DescribeDBClusters', 'rds:ListTagsForResource', 'Apply the access module', 'must be upgraded first']) assert.ok(entry.includes(said), said);
});
