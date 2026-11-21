// The CHANGELOG's Unreleased section, which the release tool heads with the version and gives its "Router … Access: …"
// paragraph (never written by hand): non-empty, and its standalone workloads entry names no version (the user's rule: the
// release notes say which versions bring and need what).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const unreleased = changelog.split(/^## Unreleased\n/m)[1]?.split(/^## /m)[0] ?? '';
// Its entries: each top-level bullet with its lines.
const entries = unreleased.split(/^(?=- \*\*)/m).filter((e) => e.startsWith('- **'));

test('the Unreleased section has entries and no Router or Access paragraph written by hand', () => {
  assert.ok(entries.length > 0);
  assert.doesNotMatch(unreleased, /^\*\*Router\b|^Router \d|^Access:/m);
});

test('the standalone workloads entry is one, says what to apply, and names no version', () => {
  const standalone = entries.filter((e) => /standalone/i.test(e.split('\n')[0]));
  assert.equal(standalone.length, 1, 'one entry for standalone workloads');
  const [entry] = standalone;
  assert.doesNotMatch(entry, /\b\d+\.\d+\.\d+\b/);
  for (const said of ['`standalone`', 'rds:DescribeDBInstances', 'rds:DescribeDBClusters', 'rds:ListTagsForResource', 'Apply the access module', 'must be upgraded first']) assert.ok(entry.includes(said), said);
});
