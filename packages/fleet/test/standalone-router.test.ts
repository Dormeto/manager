// The first router that knows standalone workloads (the review's M8): one constant, used by the API's gate, the operations'
// preview and the dashboard, tied to the router's checkout beside the manager: its docs' "Not released yet: router X" while
// unreleased, else its package's version at least that one.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STANDALONE_ROUTER, STANDALONE_ROUTERS } from '../src/idle-signals.js';

const ROUTER = resolve(import.meta.dirname, '../../../../router');
const DOC = resolve(ROUTER, 'docs/scenarios/standalone.md');
const core = (v: string) => v.split(/[-+]/)[0]!.split('.').map(Number);
const atLeast = (a: string, b: string) => {
  const [x, y] = [core(a), core(b)];
  const i = x.findIndex((n, k) => n !== y[k]);
  return i < 0 || x[i]! > y[i]!;
};

// What the floors must be, from the router's docs and package (final review, tests' honesty): unreleased, the version its docs
// name for both clouds; released, a version the package has reached, the same for both clouds (its one release line).
function floorProblems(doc: string, packageVersion: string, floors: { one: string; aws: string; gcp: string }): string[] {
  const named = /Not released yet: router (\d+\.\d+\.\d+)/.exec(doc)?.[1];
  const problems = [floors.aws, floors.gcp].filter((v) => v !== floors.one).map((v) => `a cloud's floor ${v} is not ${floors.one}`);
  if (named) return [...problems, ...(floors.one === named ? [] : [`${floors.one} is not the docs' ${named}`])];
  return [...problems, ...(atLeast(packageVersion, floors.one) ? [] : [`${floors.one} is past the package's ${packageVersion}`])];
}

describe('the floors\' check itself', () => {
  it('fails a drift before and after the release', () => {
    expect(floorProblems('Not released yet: router 0.42.0', '0.41.0', { one: '0.42.0', aws: '0.42.0', gcp: '0.42.0' })).toEqual([]);
    expect(floorProblems('', '0.42.0', { one: '0.42.0', aws: '0.42.0', gcp: '0.42.0' })).toEqual([]);
    expect(floorProblems('', '0.42.0', { one: '0.42.0', aws: '0.42.0', gcp: '0.43.0' })).toEqual(['a cloud\'s floor 0.43.0 is not 0.42.0']);
    expect(floorProblems('', '0.41.0', { one: '0.42.0', aws: '0.42.0', gcp: '0.42.0' })).toEqual(['0.42.0 is past the package\'s 0.41.0']);
  });
});

describe.skipIf(!existsSync(DOC))('the first router that knows standalone workloads', () => {
  it('is the router\'s, on both clouds, before and after its release', () => {
    const version = (JSON.parse(readFileSync(resolve(ROUTER, 'package.json'), 'utf8')) as { version: string }).version;
    expect(floorProblems(readFileSync(DOC, 'utf8'), version, { one: STANDALONE_ROUTER, aws: STANDALONE_ROUTERS.aws, gcp: STANDALONE_ROUTERS.gcp })).toEqual([]);
  });
});
