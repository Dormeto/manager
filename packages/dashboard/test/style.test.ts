// The global style sheet (style.css, PR #1's review): the dashboard's font on the typography classes, never over the
// monospace (the TOTP key, the .mono cells); the glass's blur on the bar, the drawer and the overlays, not on every card.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Read as a file: the tests leave style sheets out.
const css = readFileSync(resolve(import.meta.dirname, '../src/style.css'), 'utf8');

// Its rules (selector and declarations), those of media queries included; font faces and keyframes left out.
function rules(text: string): { selector: string; body: string }[] {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const found: { selector: string; body: string }[] = [];
  const open: { prelude: string; start: number; nested: boolean }[] = [];
  let mark = 0;
  for (let i = 0; i < src.length; i += 1) {
    if (src[i] === '{') {
      if (open.length) open[open.length - 1]!.nested = true;
      open.push({ prelude: src.slice(mark, i).trim(), start: i + 1, nested: false });
      mark = i + 1;
    } else if (src[i] === '}') {
      const block = open.pop()!;
      const atRule = [...open, block].some((b) => b.prelude.startsWith('@font-face') || b.prelude.startsWith('@keyframes'));
      if (!block.nested && !atRule && !block.prelude.startsWith('@')) found.push({ selector: block.prelude, body: src.slice(block.start, i) });
      mark = i + 1;
    }
  }
  return found;
}
// The element at the end of a path of tags with classes ("div.v-application > code.text-body-large"), in the document.
function element(path: string): Element {
  let parent: Element = document.body;
  for (const step of path.split(' > ')) {
    const [tag, ...classes] = step.split('.');
    const child = document.createElement(tag!);
    child.className = classes.join(' ');
    parent.appendChild(child);
    parent = child;
  }
  return parent;
}
// The selectors of the rules with that declaration that the element matches.
function matching(declaration: RegExp, path: string): string[] {
  const target = element(path);
  return rules(css).filter((r) => declaration.test(r.body) && target.matches(r.selector)).map((r) => r.selector);
}

describe('style.css', () => {
  const FONT = /font-family:\s*var\(--dm-font\)\s*!important/;
  it('gives the dashboard\'s font to the typography classes, never over the monospace (PR #1)', () => {
    expect(rules(css).some((r) => FONT.test(r.body))).toBe(true);
    expect(matching(FONT, 'div.v-application > div.text-body-small')).not.toEqual([]);
    expect(matching(FONT, 'div.v-application > h1.text-headline-small')).not.toEqual([]);
    // The TOTP key (a code with a typography class), a .mono cell with an emphasis class, any other text- class: theirs.
    expect(matching(FONT, 'div.v-application > code.text-body-large')).toEqual([]);
    expect(matching(FONT, 'div.v-application > span.text-body-small.text-medium-emphasis.mono')).toEqual([]);
    expect(matching(FONT, 'div.v-application > span.mono.text-medium-emphasis')).toEqual([]);
    expect(matching(FONT, 'div.v-application > span.text-error')).toEqual([]);
  });

  const BLUR = /backdrop-filter\s*:/;
  it('blurs behind the bar, the drawer and the overlays only, not every card or table (PR #1)', () => {
    expect(matching(BLUR, 'div.v-application.v-theme--dark > div.v-card')).toEqual([]);
    expect(matching(BLUR, 'div.v-application.v-theme--dark > div.v-card > div.v-table')).toEqual([]);
    expect(matching(BLUR, 'div.v-application.v-theme--dark > header.v-app-bar.dm-bar')).not.toEqual([]);
    expect(matching(BLUR, 'div.v-application.v-theme--dark > nav.v-navigation-drawer.dm-drawer')).not.toEqual([]);
    expect(matching(BLUR, 'div.v-overlay > div.v-overlay__content > div.v-card')).not.toEqual([]);
  });
});
