// Test helper: a manager and a router checkout with their build outputs, in a temporary directory.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

export function fakeRepos({ without = [], with: extra = {}, routerVersion = '0.22.6', pin = '0.22.6' } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'dmt-release-'));
  const files = {
    'manager/package.json': JSON.stringify({ version: '0.2.0', dormeto: { router: pin } }),
    'manager/CHANGELOG.md': '# Changelog\n\n## 0.2.0 — 2026-10-06\n\n- The manager as a Terraform module.\n\n## 0.1.0 — 2026-10-04\n\n- First version.\n',
    'manager/packages/api/dist/index.mjs': 'api',
    'manager/packages/api/dist/watchdog.mjs': 'watchdog',
    'manager/packages/api/dist/savings.mjs': 'savings',
    'manager/packages/discovery/dist/index.mjs': 'discovery',
    'manager/packages/operations/dist/index.mjs': 'operations',
    'manager/packages/operations/dist/check.mjs': 'check',
    'manager/packages/fleet/dist/index.mjs': 'fleet',
    'manager/packages/dashboard/dist/index.html': '<html>',
    'manager/packages/dashboard/dist/assets/app-1a2b.js': 'app',
    'router/package.json': JSON.stringify({ version: routerVersion }),
    [`router/dist/router-${routerVersion}.zip`]: 'zip',
    [`router/dist/blueprint-${routerVersion}.json`]: '{}',
    'router/dist/router-boundary.json': '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:GetObject","Resource":"arn:${partition}:s3:::dmtr-${account}-*"}]}',
    ...extra,
  };
  for (const [path, content] of Object.entries(files)) {
    if (without.includes(path)) continue;
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), content);
  }
  return { base, manager: join(base, 'manager'), router: join(base, 'router'), out: join(base, 'out') };
}
