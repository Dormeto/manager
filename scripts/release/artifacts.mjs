#!/usr/bin/env node
// The artifacts of a release (vision docs/specs/2026-10-06-packaging-design.md, section 4): the layout the manager module
// reads (its artifacts_dir), assembled from the manager's builds and the router bundle of the pinned version (package.json
// dormeto.router). Dev plans
// platform from it; the release archive carries it.
//   manifest.json                       { version, router } (the release's version, else the manager's package.json)
//   lambda/<api|discovery|operations|fleet>.zip (index.mjs), lambda/access-check.zip (check.mjs), lambda/watchdog.zip
//                                       (watchdog.mjs), lambda/savings.zip (savings.mjs), lambda/update-check.zip
//                                       (update-check.mjs): ready to upload, so that nothing is written at plan time (a plan applied elsewhere works)
//   dashboard/…                         the built dashboard
//   router/{router.zip, blueprint.json, router-boundary.json}
// Usage: node scripts/release/artifacts.mjs [--router <router repository>] [--out <directory>]
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;

// One file per zip, its time fixed and no extra attributes: the same build gives the same bytes, so an unchanged function
// keeps its code hash.
function zipOne(source, target) {
  const dir = mkdtempSync(join(tmpdir(), 'dmt-zip-'));
  const file = join(dir, basename(source));
  cpSync(source, file);
  utimesSync(file, new Date('1980-01-01T00:00:00Z'), new Date('1980-01-01T00:00:00Z'));
  mkdirSync(dirname(target), { recursive: true });
  execFileSync('zip', ['-X', '-q', target, basename(source)], { cwd: dir });
  rmSync(dir, { recursive: true, force: true });
}

function list(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? list(join(dir, e.name), base) : [relative(base, join(dir, e.name))]));
}

// The dashboard's demo mode (src/mock, npm run dev:mock) never ships: a build holding its chunk (mock-…) or its markers (the
// demo's storage key, its sign-in's address) is refused. The build refuses VITE_MOCK and leaves src/mock out anyway.
const DEMO_MARKERS = ['dormeto.demo', 'example.invalid'];
export function demoIn(dist) {
  return list(dist).filter((file) => /(^|\/)mock-[^/]*$/.test(file)
    || (/\.(m?js|html|css|json|map)$/.test(file) && DEMO_MARKERS.some((marker) => readFileSync(join(dist, file), 'utf8').includes(marker)))).sort();
}

export function assembleArtifacts({ manager, router, out, version: releaseVersion = version(manager) }) {
  // The router bundle of the version the manager pins (package.json dormeto.router), never another checkout's.
  const routerVersion = version(router);
  const pinned = JSON.parse(readFileSync(join(manager, 'package.json'), 'utf8')).dormeto?.router;
  if (routerVersion !== pinned) throw new Error(`router checkout is ${routerVersion}, the manager pins ${pinned} (package.json dormeto.router)`);
  const bundles = {
    'lambda/api.zip': join(manager, 'packages/api/dist/index.mjs'),
    'lambda/discovery.zip': join(manager, 'packages/discovery/dist/index.mjs'),
    'lambda/operations.zip': join(manager, 'packages/operations/dist/index.mjs'),
    'lambda/access-check.zip': join(manager, 'packages/operations/dist/check.mjs'),
    'lambda/fleet.zip': join(manager, 'packages/fleet/dist/index.mjs'),
    'lambda/watchdog.zip': join(manager, 'packages/api/dist/watchdog.mjs'),
    'lambda/savings.zip': join(manager, 'packages/api/dist/savings.mjs'),
    'lambda/update-check.zip': join(manager, 'packages/api/dist/update-check.mjs'),
  };
  const sources = {
    'dashboard': join(manager, 'packages/dashboard/dist'),
    'router/router.zip': join(router, `dist/router-${routerVersion}.zip`),
    'router/blueprint.json': join(router, `dist/blueprint-${routerVersion}.json`),
    'router/router-boundary.json': join(router, 'dist/router-boundary.json'),
  };
  // Every output is checked before anything is written: a partial layout never replaces a complete one.
  for (const source of [...Object.values(bundles), ...Object.values(sources)]) {
    if (!existsSync(source)) throw new Error(`missing build output: ${source} (npm run build here, npm run package in the router)`);
  }
  const demo = demoIn(sources.dashboard);
  if (demo.length) throw new Error(`the dashboard build holds the demo mode (${demo.join(', ')}): build it without VITE_MOCK`);
  rmSync(out, { recursive: true, force: true });
  for (const [target, source] of Object.entries(bundles)) zipOne(source, join(out, target));
  for (const [target, source] of Object.entries(sources)) {
    mkdirSync(dirname(join(out, target)), { recursive: true });
    cpSync(source, join(out, target), { recursive: true });
  }
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify({ version: releaseVersion, router: routerVersion })}\n`);
  return list(out).sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => { const at = args.indexOf(`--${name}`); return at < 0 ? fallback : args[at + 1]; };
  const manager = fileURLToPath(new URL('../..', import.meta.url));
  const files = assembleArtifacts({ manager, router: option('router', join(manager, '../router')), out: option('out', join(manager, 'dist/artifacts')) });
  console.log(`${files.length} files`);
}
