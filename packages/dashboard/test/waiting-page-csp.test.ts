// @vitest-environment node
// The preview frame (a sandboxed srcdoc) inherits the dashboard's content security policy, which is what stops a custom page
// from navigating its frame to a remote address (checked in a browser, with this policy served: "Framing … violates
// default-src 'self'", frame-src not being set). This pins the two facts that holds on.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const edge = readFileSync(resolve(import.meta.dirname, '../../../infra/terraform/modules/manager/edge.tf'), 'utf8');
const policy = edge.slice(edge.indexOf('content_security_policy = join("; ", ['), edge.indexOf('override = true', edge.indexOf('content_security_policy = join')));

describe('the dashboard\'s content security policy, as the preview relies on it', () => {
  it('falls back to default-src \'self\' for frames: no frame-src or child-src opens them to other addresses', () => {
    expect(policy).toContain('"default-src \'self\'"');
    expect(policy).not.toMatch(/frame-src|child-src/);
  });
  it('lets a srcdoc frame hold inline styles and data: images, as the template draws them', () => {
    expect(policy).toContain('"style-src \'self\' \'unsafe-inline\'"');
    expect(policy).toContain('"img-src \'self\' data:"');
  });
});
