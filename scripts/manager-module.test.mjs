// The manager module (packaging design §4): dev's manager is a CLI install (adopted 2026-10-18); platform keeps only the
// dev certificate, with no module and no moved block.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const dir = (path) => new URL(`../infra/terraform/${path}/`, import.meta.url);
const hcl = (path) => readdirSync(dir(path)).filter((f) => f.endsWith('.tf')).map((f) => readFileSync(new URL(f, dir(path)), 'utf8')).join('\n');
const addresses = (text) => [...text.matchAll(/^(resource|module) "([^"]+)"(?: "([^"]+)")? \{/gm)].map(([, kind, a, b]) => (kind === 'module' ? `module.${a}` : `${a}.${b}`));
const moves = (text) => [...text.matchAll(/moved \{\s*from\s*=\s*(\S+)\s+to\s*=\s*(\S+)\s*\}/g)].map(([, from, to]) => ({ from, to }));

test('platform keeps the dev certificate only: the manager is a CLI install since its adoption (2026-10-18)', () => {
  const inModule = addresses(hcl('modules/manager'));
  assert.ok(inModule.length > 70, `${inModule.length} resources in the module`);
  assert.deepEqual(moves(hcl('platform')), [], 'no moved block: the module is not in platform');
  assert.deepEqual(addresses(hcl('platform')).sort(), ['aws_acm_certificate.edge', 'aws_acm_certificate_validation.edge', 'aws_route53_record.certificate_validation']);
});
