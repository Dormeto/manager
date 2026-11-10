// The README's Terraform example installs the newest released manager. The release scripts don't rewrite it: this test
// fails at a release until the README names the new version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
// a after b, by major.minor.patch.
const after = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  const i = x.findIndex((n, k) => n !== y[k]);
  return i >= 0 && x[i] > y[i];
};

test('the README\'s Terraform example names the newest released version of the CHANGELOG', () => {
  const released = [...read('CHANGELOG.md').matchAll(/^## (\d+\.\d+\.\d+)\b/gm)].map(([, version]) => version);
  assert.ok(released.length > 0, 'the CHANGELOG has a released section');
  const newest = released.reduce((a, b) => (after(b, a) ? b : a));
  const named = [...read('README.md').matchAll(/releases\.dormeto\.com\/manager\/([^/"]+)\/terraform-aws-dormeto-([^/"]+)\.zip/g)];
  assert.ok(named.length > 0, 'the README has a Terraform example from a release');
  for (const [, folder, archive] of named) assert.deepEqual([folder, archive], [newest, newest]);
});
