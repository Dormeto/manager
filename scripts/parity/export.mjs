#!/usr/bin/env node
// The shared test cases that pin the Dormeto CLI (Go) to the product's Node code (vision
// docs/specs/2026-10-13-cli-design.md §6): each topic's Node functions run over the corpus (cases/), one file per topic
// with each case's input (JSON, recorded AWS answers included) and output, versions.json and a README for the Go side.
// The estimate topic (estimate.json and cache/) is frozen since the Node estimate was replaced by the Dormeto CLI
// (manager 0.10.0, commit 580867f): the export neither writes nor deletes them. A case's output is the run over its recorded
// answers alone (what Go replays); it must equal the run that recorded them, with no call left unanswered.
//   node scripts/parity/export.mjs --out ../cli/testdata/parity
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, json, recordedPorts, recorder } from './recorded.mjs';
import { ROOT, loadProduct, versions } from './product.mjs';
import { readme } from './readme.mjs';
import * as replay from './cases/replay.mjs';
import * as prices from './cases/prices.mjs';
import * as scan from './cases/scan.mjs';
import * as stopped from './cases/stopped.mjs';

const TOPICS = [replay, prices, scan, stopped];
// Every case runs at this time (input.now where the function takes it).
const NOW = '2026-10-12T08:00:00.000Z';

// JSON indented by object, an array of plain values (timestamps, counts) on one line: readable diffs, smaller files.
function pretty(value, indent = '') {
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    if (value.every((v) => v === null || typeof v !== 'object')) return `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
    return `[\n${value.map((v) => `${inner}${pretty(v, inner)}`).join(',\n')}\n${indent}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) return '{}';
    return `{\n${keys.map((k) => `${inner}${JSON.stringify(k)}: ${pretty(value[k], inner)}`).join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value);
}
const text = (value) => `${pretty(json(value))}\n`;

// One case: recorded from its model (if it has ports), then run again over the recording alone.
async function runCase(topic, product, c) {
  const scratch = await mkdtemp(join(tmpdir(), 'dormeto-parity-'));
  try {
    let input = json(c.input);
    let recordedOutput;
    if (c.model) {
      const rec = recorder(c.model);
      recordedOutput = json(await topic.run(product, json(input), rec.ports, { scratch: join(scratch, 'recording'), fails: c.fails }));
      if (rec.gaps().length) throw new Error(`calls the model does not answer: ${rec.gaps().map((g) => `${g.call}(${JSON.stringify(g.input)})`).join(', ')}`);
      input = { ...input, answers: rec.answers() };
    }
    const ports = recordedPorts(input.answers);
    const context = { scratch: join(scratch, 'replay'), fails: c.fails };
    const output = json(await topic.run(product, json(input), ports, context));
    if (ports.missed().length) throw new Error(`calls without a recorded answer: ${ports.missed().map((m) => `${m.call}(${JSON.stringify(m.input)})`).join(', ')}`);
    if (recordedOutput !== undefined && canonical(recordedOutput) !== canonical(output)) throw new Error('the run over the recorded answers differs from the run that recorded them');
    if (output === undefined) throw new Error('no output');
    return { name: c.name, input, output };
  } catch (err) {
    err.message = `${topic.name}: ${c.name}: ${err.message}`;
    throw err;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function exportCases({ out }) {
  const product = await loadProduct();
  const { manager, router } = await versions();
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim();
  const head = { manager, router, commit };
  await mkdir(out, { recursive: true });
  const written = [];
  for (const topic of TOPICS) {
    const cases = [];
    for (const c of topic.cases(NOW)) cases.push(await runCase(topic, product, c));
    await writeFile(join(out, `${topic.name}.json`), text({ ...head, cases }));
    written.push({ topic, cases });
  }
  await writeFile(join(out, 'versions.json'), text(head));
  await writeFile(join(out, 'README.md'), readme({ ...head, now: NOW, topics: written }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--out');
  const out = at > 0 ? process.argv[at + 1] : undefined;
  if (!out) {
    console.error('Usage: node scripts/parity/export.mjs --out <dir>   (the CLI\'s testdata/parity: ../cli/testdata/parity)');
    process.exit(2);
  }
  await exportCases({ out: resolve(out) });
  console.log(`Shared cases written to ${resolve(out)}`);
}
