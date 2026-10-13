// The product's Node code as the export runs it: the packages' TypeScript sources (their ./x.js specifiers name .ts
// files, which plain Node cannot import) bundled by esbuild, the router's modules with them. The bundle is written inside the
// repository (node_modules/.cache), where the AWS SDK it leaves external resolves, imported, then removed.
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ROUTER = join(ROOT, '..', 'router');

const ENTRY = `
export { IDLE_WINDOWS, checkMinutesOf, idleWindowAdvice, recommendWindow, replayIdle, windowsFor } from './packages/fleet/src/idle.ts';
export { createPriceBook, NO_DISCOUNTS } from './packages/fleet/src/prices.ts';
export { DORMETO_COST, baselineHours, savingsOf } from './packages/fleet/src/savings.ts';
export { scanRegion } from './packages/discovery/src/scan.ts';
export { decide, matches, resourceTagsMatch, scanAccounts, targetPairs } from './packages/discovery/src/filters.ts';
export { clustersOf, kubernetesBackend } from './packages/discovery/src/kubernetes.ts';
export { loadInventory } from './packages/discovery/src/org.ts';
export { describeStopped, strategyCounts } from '../router/lambda/src/lib/stopped.mjs';
`;

let loaded = 0;

export async function loadProduct() {
  const dir = join(ROOT, 'node_modules', '.cache', 'dormeto-parity');
  await mkdir(dir, { recursive: true });
  loaded += 1;
  const file = join(dir, `product-${process.pid}-${loaded}.mjs`);
  await build({
    stdin: { contents: ENTRY, resolveDir: ROOT, sourcefile: 'parity-product.ts', loader: 'ts' },
    bundle: true, platform: 'node', target: 'node24', format: 'esm', outfile: file, external: ['@aws-sdk/*'], logLevel: 'error',
  });
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    await rm(file, { force: true });
  }
}

// The versions the cases pin: the manager's, and the router's whose code ran (the one the manager carries).
export async function versions() {
  const manager = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const router = JSON.parse(await readFile(join(ROUTER, 'package.json'), 'utf8'));
  if (router.version !== manager.dormeto?.router) {
    throw new Error(`the router at ${ROUTER} is ${router.version}, the manager carries ${manager.dormeto?.router}: check out the router it carries`);
  }
  return { manager: manager.version, router: router.version };
}
