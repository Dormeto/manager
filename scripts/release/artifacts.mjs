#!/usr/bin/env node
// The artifacts of a release (vision docs/specs/2026-10-06-packaging-design.md, section 4): the layout the manager module
// reads (its artifacts_dir), assembled from the manager's builds and the router bundle of the pinned version. Dev plans
// platform from it; the release archive carries it.
//   manifest.json                       { version, router }
//   lambda/<api|discovery|fleet>/index.mjs, lambda/operations/{index,check}.mjs
//   dashboard/…                         the built dashboard
//   router/{router.zip, blueprint.json, router-boundary.json}
// Usage: node scripts/release/artifacts.mjs [--router <router repository>] [--out <directory>]
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;

function list(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? list(join(dir, e.name), base) : [relative(base, join(dir, e.name))]));
}

export function assembleArtifacts({ manager, router, out }) {
  const routerVersion = version(router);
  const sources = {
    'lambda/api/index.mjs': join(manager, 'packages/api/dist/index.mjs'),
    'lambda/discovery/index.mjs': join(manager, 'packages/discovery/dist/index.mjs'),
    'lambda/operations/index.mjs': join(manager, 'packages/operations/dist/index.mjs'),
    'lambda/operations/check.mjs': join(manager, 'packages/operations/dist/check.mjs'),
    'lambda/fleet/index.mjs': join(manager, 'packages/fleet/dist/index.mjs'),
    'dashboard': join(manager, 'packages/dashboard/dist'),
    'router/router.zip': join(router, `dist/router-${routerVersion}.zip`),
    'router/blueprint.json': join(router, `dist/blueprint-${routerVersion}.json`),
    'router/router-boundary.json': join(router, 'dist/router-boundary.json'),
  };
  // Every output is checked before anything is written: a partial layout never replaces a complete one.
  for (const source of Object.values(sources)) {
    if (!existsSync(source)) throw new Error(`missing build output: ${source} (npm run build here, npm run package in the router)`);
  }
  rmSync(out, { recursive: true, force: true });
  for (const [target, source] of Object.entries(sources)) {
    mkdirSync(dirname(join(out, target)), { recursive: true });
    cpSync(source, join(out, target), { recursive: true });
  }
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify({ version: version(manager), router: routerVersion })}\n`);
  return list(out).sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => { const at = args.indexOf(`--${name}`); return at < 0 ? fallback : args[at + 1]; };
  const manager = fileURLToPath(new URL('../..', import.meta.url));
  const files = assembleArtifacts({ manager, router: option('router', join(manager, '../router')), out: option('out', join(manager, 'dist/artifacts')) });
  console.log(`${files.length} files`);
}
