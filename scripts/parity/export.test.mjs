// The export of the shared cases (vision docs/specs/2026-10-13-cli-design.md §6): deterministic, every topic with
// cases and every case with its output, the frozen estimate files left as they are, nothing of the run itself.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const TOPICS = ['replay', 'prices', 'scan', 'stopped'];

async function files(dir) {
  const out = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) out[relative(dir, join(entry.parentPath, entry.name))] = await readFile(join(entry.parentPath, entry.name), 'utf8');
  }
  return out;
}

// What the manager's last export with the Node estimate left in the CLI's testdata/parity (Ruling P21): kept as it is.
const FROZEN = {
  'estimate.json': '{\n  "frozen": true\n}\n',
  'cache/o-a1b2c3d4e5/regions/111111111111.json': '{"writtenAt": 1, "value": []}',
  'cache/prices.json': 'not even JSON \u00e9\n',
};

let first;
let second;
let seeded;
let temporary;
before(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'dormeto-parity-'));
  // The command itself, twice, as the release runs it.
  for (const name of ['a', 'b']) await run(process.execPath, ['scripts/parity/export.mjs', '--out', join(temporary, name)], { cwd: ROOT, maxBuffer: 1 << 26 });
  for (const [path, content] of Object.entries(FROZEN)) {
    await mkdir(join(temporary, 'c', path, '..'), { recursive: true });
    await writeFile(join(temporary, 'c', path), content);
  }
  await run(process.execPath, ['scripts/parity/export.mjs', '--out', join(temporary, 'c')], { cwd: ROOT, maxBuffer: 1 << 26 });
  seeded = await files(join(temporary, 'c'));
  first = await files(join(temporary, 'a'));
  second = await files(join(temporary, 'b'));
  await rm(temporary, { recursive: true, force: true });
});

test('the export is deterministic: two runs write the same files', () => {
  assert.deepEqual(Object.keys(second).sort(), Object.keys(first).sort());
  for (const path of Object.keys(first)) assert.equal(second[path], first[path], `${path} differs between two runs`);
});

test('one file per topic, versions.json and the README; no estimate file and no cache of its own', () => {
  for (const topic of TOPICS) assert.ok(first[`${topic}.json`], `${topic}.json`);
  assert.ok(first['versions.json'] && first['README.md']);
  assert.deepEqual(Object.keys(first).filter((p) => p === 'estimate.json' || p.startsWith('cache/')), []);
});

test('an estimate.json and a cache/ already in --out are left byte for byte as they were', () => {
  for (const [path, content] of Object.entries(FROZEN)) assert.equal(seeded[path], content, path);
  assert.deepEqual(Object.keys(seeded).filter((p) => !(p in FROZEN)).sort(), Object.keys(first).sort());
});

test('the README calls the estimate topic frozen, with the manager and the commit that wrote it', () => {
  const section = first['README.md'].split('## `estimate`')[1];
  assert.ok(section, 'an estimate section');
  assert.match(section.split('\n## ')[0], /frozen/i);
  assert.match(first['README.md'], /manager 0\.10\.0, commit 580867f/);
  assert.match(first['README.md'], /no longer exported/);
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
