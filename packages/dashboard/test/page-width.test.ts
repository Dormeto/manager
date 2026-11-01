// Every view takes the whole width of the content area (the user, 2026-11-01): none caps its page wrapper. A line of prose
// may still have its own measure.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const views = resolve(import.meta.dirname, '../src/views');

describe('page width', () => {
  for (const file of readdirSync(views).filter((f) => f.endsWith('.vue'))) {
    it(`${file} does not cap its page`, () => {
      const text = readFileSync(resolve(views, file), 'utf8');
      const roots = [...text.matchAll(/^ {2}<div\s+class="([^"]*)"/gm)].flatMap((m) => m[1]!.split(/\s+/));
      for (const name of roots) expect(text).not.toMatch(new RegExp(`\\.${name}\\s*\\{[^}]*max-width`));
    });
  }
});
