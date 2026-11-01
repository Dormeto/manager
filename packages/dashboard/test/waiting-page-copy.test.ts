// The preview draws the waiting page with a copy of the router's renderer (src/waiting-page/page.mjs): it must be the
// router's file byte for byte. The router's checkout beside the manager's is compared when it is there, as scripts/parity
// reaches ../router, and the test is skipped when it is absent.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const router = resolve(import.meta.dirname, '../../../../router/lambda/src/lib/page.mjs');
const copy = resolve(import.meta.dirname, '../src/waiting-page/page.mjs');

describe('the waiting page renderer copy', () => {
  it('exists', () => {
    expect(existsSync(copy)).toBe(true);
  });
  it.skipIf(!existsSync(router))('is the router\'s page.mjs, byte for byte', () => {
    expect(readFileSync(copy).equals(readFileSync(router))).toBe(true);
  });
});
