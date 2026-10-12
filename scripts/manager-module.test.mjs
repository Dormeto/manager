// The manager module (packaging design §4, plan B1): today's platform resources live in modules/manager, and platform
// keeps their state with one moved block each (review focus 2: no stateful resource replaced).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const dir = (path) => new URL(`../infra/terraform/${path}/`, import.meta.url);
const hcl = (path) => readdirSync(dir(path)).filter((f) => f.endsWith('.tf')).map((f) => readFileSync(new URL(f, dir(path)), 'utf8')).join('\n');
const addresses = (text) => [...text.matchAll(/^(resource|module) "([^"]+)"(?: "([^"]+)")? \{/gm)].map(([, kind, a, b]) => (kind === 'module' ? `module.${a}` : `${a}.${b}`));
const moves = (text) => [...text.matchAll(/moved \{\s*from\s*=\s*(\S+)\s+to\s*=\s*(\S+)\s*\}/g)].map(([, from, to]) => ({ from, to }));

// Optional in the module (count): their one instance is [0].
const CONDITIONAL = ['aws_ses_identity_policy.cognito', 'aws_route53_record.auth'];
// Added in the module, with no platform address: the artifacts' check (R5b review), event-driven refresh (R5c).
const NEW = ['terraform_data.artifacts', 'aws_cloudwatch_event_rule.refresh', 'aws_sqs_queue.refresh_failed', 'aws_sqs_queue.refresh', 'aws_sqs_queue_policy.refresh',
  'aws_cloudwatch_event_target.refresh', 'aws_lambda_event_source_mapping.refresh'];

test('every resource of the manager module has a moved block from its platform address', () => {
  const inModule = addresses(hcl('modules/manager'));
  const moved = moves(hcl('platform'));
  assert.ok(inModule.length > 70, `${inModule.length} resources in the module`);
  for (const address of inModule.filter((a) => !NEW.includes(a))) {
    const to = `module.manager.${address}${CONDITIONAL.includes(address) ? '[0]' : ''}`;
    assert.ok(moved.some((m) => m.from === address && m.to === to), `moved { from = ${address} to = ${to} }`);
  }
  for (const m of moved) assert.ok(inModule.some((a) => m.to === `module.manager.${a}` || m.to === `module.manager.${a}[0]`), `stray moved block to ${m.to}`);
  // Platform's root keeps the dev certificate only (a customer's module is given one).
  assert.deepEqual(addresses(hcl('platform')).sort(), ['aws_acm_certificate.edge', 'aws_acm_certificate_validation.edge', 'aws_route53_record.certificate_validation', 'module.manager']);
});
