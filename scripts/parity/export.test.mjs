// The export of the shared cases (vision docs/specs/2026-10-13-cli-design.md §6): deterministic, every topic with
// cases and every case with its output, the estimate's world with what its report must show, nothing of the run itself.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const TOPICS = ['replay', 'prices', 'scan', 'stopped', 'estimate'];

async function files(dir) {
  const out = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) out[relative(dir, join(entry.parentPath, entry.name))] = await readFile(join(entry.parentPath, entry.name), 'utf8');
  }
  return out;
}

let first;
let second;
let temporary;
before(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'dormeto-parity-'));
  // The command itself, twice, as the release runs it.
  for (const name of ['a', 'b']) await run(process.execPath, ['scripts/parity/export.mjs', '--out', join(temporary, name)], { cwd: ROOT, maxBuffer: 1 << 26 });
  first = await files(join(temporary, 'a'));
  second = await files(join(temporary, 'b'));
  await rm(temporary, { recursive: true, force: true });
});

test('the export is deterministic: two runs write the same files', () => {
  assert.deepEqual(Object.keys(second).sort(), Object.keys(first).sort());
  for (const path of Object.keys(first)) assert.equal(second[path], first[path], `${path} differs between two runs`);
});

test('one file per topic, versions.json, the README and the estimate\'s cache', () => {
  for (const topic of TOPICS) assert.ok(first[`${topic}.json`], `${topic}.json`);
  assert.ok(first['versions.json'] && first['README.md']);
  assert.ok(Object.keys(first).some((p) => /^cache\/[^/]+\/discovery\/\d{12}-[a-z0-9-]+\.json$/.test(p)), 'a discovery file in the cache');
  for (const kind of ['regions', 'requests', 'uptime']) assert.ok(Object.keys(first).some((p) => p.includes(`/${kind}/`)), `${kind} in the cache`);
  assert.ok(Object.keys(first).some((p) => /^cache\/[^/]+\/prices\.json$/.test(p)), 'the prices in the cache');
});

test('each topic names the versions and the commit, has cases, and each case a name, an input and an output', async () => {
  const commit = (await run('git', ['rev-parse', 'HEAD'], { cwd: ROOT })).stdout.trim();
  const manager = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const versions = { manager: manager.version, router: manager.dormeto.router, commit };
  assert.deepEqual(JSON.parse(first['versions.json']), versions);
  for (const topic of TOPICS) {
    const file = JSON.parse(first[`${topic}.json`]);
    assert.deepEqual({ manager: file.manager, router: file.router, commit: file.commit }, versions, topic);
    assert.ok(file.cases.length > 0, `${topic} has cases`);
    const names = new Set();
    for (const c of file.cases) {
      assert.ok(c.name && !names.has(c.name), `${topic}: a unique name (${c.name})`);
      names.add(c.name);
      assert.ok(c.input && typeof c.input === 'object', `${topic}/${c.name}: an input`);
      assert.ok('output' in c && c.output !== undefined, `${topic}/${c.name}: an output`);
    }
    assert.match(first['README.md'], new RegExp(`## \`${topic}\``), `the README describes ${topic}`);
  }
});

test('the estimate case\'s report has workloads, exclusions, companions and an EKS workload', () => {
  const [world] = JSON.parse(first['estimate.json']).cases;
  const report = world.output.report;
  assert.equal(world.output.exitCode, 0);
  assert.ok(report.workloads.length > 0, 'workloads');
  assert.ok(report.excluded.length > 0, 'workloads excluded by tags');
  assert.ok(report.leftOut.length > 0 && report.busy.length > 0 && report.small.length > 0, 'left out, too many wakes, too small a saving');
  assert.ok(report.workloads.some((w) => w.databases?.length), 'a companion database attached');
  assert.ok(report.databasesLeftOut.some((d) => d.code === 'shared') && report.databasesLeftOut.some((d) => d.code === 'tags'), 'companions shared and excluded by tags');
  assert.ok(report.workloads.some((w) => w.workload.backend.kind === 'k8s'), 'an EKS workload');
  for (const kind of ['asg', 'ec2', 'ecs', 'eks']) assert.ok(report.totals.kinds[kind] > 0, `a workload of kind ${kind}`);
  assert.ok(report.ineligible.length && report.unreachable.length && report.failedRegions.length && report.unreadableClusters.length, 'ineligible, unreachable, failed, unreadable');
  assert.ok(world.output.markdown.includes('## Workloads'), 'the Markdown report');
});

// The fields of each kind of item a nap stops (fleet src/prices.ts StoppedItem): Go's stopped.Item holds no others.
const ITEM_FIELDS = {
  ec2: ['kind', 'type', 'count', 'os', 'spot'],
  fargate: ['kind', 'vcpu', 'memoryGb', 'count', 'arch', 'os', 'spot'],
  rds: ['kind', 'class', 'engine', 'multiAz'],
  'aurora-serverless': ['kind', 'engine', 'acu'],
  'k8s-pods': ['kind', 'count', 'cpu', 'memoryGb', 'nodeType', 'os', 'spot', 'autoscaled', 'allocatable'],
  unknown: ['kind', 'backend', 'reason'],
};

test('every item a case gives or expects is one the product describes: its kind\'s fields, no others', () => {
  const items = [];
  for (const topic of ['replay', 'prices']) {
    for (const { input } of JSON.parse(first[`${topic}.json`]).cases) {
      items.push(...(input.stopped ?? []), ...(input.prices ?? []).map((p) => p.item), ...(input.lookups ?? []).map((l) => l.item), ...(input.phases ?? []).flatMap((p) => p.stopped ?? []));
    }
  }
  for (const { output } of JSON.parse(first['stopped.json']).cases) if (Array.isArray(output)) items.push(...output);
  assert.ok(items.length > 50);
  for (const item of items) {
    const fields = ITEM_FIELDS[item.kind];
    assert.ok(fields, `an item of kind ${item.kind}`);
    assert.deepEqual(Object.keys(item).filter((k) => !fields.includes(k)), [], `fields of ${JSON.stringify(item)}`);
  }
});

test('nothing of the run itself: no temporary path, no run time', () => {
  for (const [path, text] of Object.entries(first)) {
    assert.ok(!text.includes(tmpdir()) && !text.includes(ROOT), `${path}: a local path`);
    if (path.endsWith('.json') && !path.startsWith('cache/')) assert.ok(!text.includes('"generatedAt"'), `${path}: a run time`);
  }
});
