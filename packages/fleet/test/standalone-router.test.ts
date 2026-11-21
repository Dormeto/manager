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

describe.skipIf(!existsSync(DOC))('the first router that knows standalone workloads', () => {
  it('is the router\'s', () => {
    const named = /Not released yet: router (\d+\.\d+\.\d+)/.exec(readFileSync(DOC, 'utf8'))?.[1];
    // The router's one release line names both clouds' (its docs: one sentence for AWS and Google Cloud).
    if (named) expect([STANDALONE_ROUTER, STANDALONE_ROUTERS.aws, STANDALONE_ROUTERS.gcp]).toEqual([named, named, named]);
    else expect(atLeast((JSON.parse(readFileSync(resolve(ROUTER, 'package.json'), 'utf8')) as { version: string }).version, STANDALONE_ROUTER)).toBe(true);
  });
});
