// Markdown drawn with Vue render functions: nothing here makes HTML from the text (release notes and descriptions are
// written by others and may be hostile; raw HTML in them shows as text). The subset: headings, paragraphs (a line break
// inside one), bulleted and numbered lists, block quotes, fenced code blocks, `code`, **bold**, *italic* and links whose
// address starts with https:// (any other link, and anything else, stays text). Linear time: one pass per line, and a
// delimiter that has no closer is looked for once.
import { h, type VNodeChild } from 'vue';

export interface MarkdownOptions {
  // Join the lines of a paragraph with a space instead of a line break (the release notes).
  joinLines?: boolean;
}

const MAX_QUOTE_DEPTH = 3; // nested quotes beyond it stay text (a deep tree of elements helps nobody)
const MAX_URL = 2000;

// --- Inline -----------------------------------------------------------------------------------------------------------

function inline(text: string, nested = false): VNodeChild[] {
  const out: VNodeChild[] = [];
  let plain = '';
  const flush = () => { if (plain) out.push(plain); plain = ''; };
  // Each search runs again only from the last place it found something; once a closer is known absent it is never sought.
  const finder = (find: (from: number) => number) => {
    let at = -2;
    let last = -1;
    return (from: number): number => {
      if (at === -1) return -1;
      if (at >= from && last <= from) return at;
      at = find(from);
      last = from;
      return at;
    };
  };
  const tick = finder((from) => text.indexOf('`', from));
  const strong = finder((from) => text.indexOf('**', from));
  const star = finder((from) => {
    for (let j = text.indexOf('*', from); j !== -1; j = text.indexOf('*', j + 1)) {
      if (text[j - 1] !== ' ' && text[j + 1] !== '*' && text[j - 1] !== '*') return j;
    }
    return -1;
  });
  const bracket = finder((from) => text.indexOf(']', from));
  const paren = finder((from) => text.indexOf(')', from));

  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === '`') {
      const end = tick(i + 1);
      if (end > i + 1) { flush(); out.push(h('code', text.slice(i + 1, end))); i = end + 1; continue; }
    } else if (c === '*' && text[i + 1] === '*') {
      const end = strong(i + 3);
      if (end > i + 2) { flush(); out.push(h('strong', nested ? text.slice(i + 2, end) : inline(text.slice(i + 2, end), true))); i = end + 2; continue; }
    } else if (c === '*' && text[i + 1] !== ' ' && text[i + 1] !== '*' && text[i - 1] !== '*') {
      const end = star(i + 2);
      if (end > i + 1) { flush(); out.push(h('em', nested ? text.slice(i + 1, end) : inline(text.slice(i + 1, end), true))); i = end + 1; continue; }
    } else if (c === '[') {
      const close = bracket(i + 2);
      if (close > i + 1 && text[close + 1] === '(') {
        const end = paren(close + 2);
        const url = end === -1 || end - close > MAX_URL ? '' : text.slice(close + 2, end);
        if (url && !/\s/.test(url)) {
          flush();
          const label = text.slice(i + 1, close);
          if (url.startsWith('https://')) out.push(h('a', { href: url, rel: 'noopener', target: '_blank' }, label));
          else out.push(text.slice(i, end + 1));
          i = end + 1;
          continue;
        }
      }
    }
    plain += c;
    i += 1;
  }
  flush();
  return out;
}

// --- Blocks -----------------------------------------------------------------------------------------------------------

const HEADING = /^(#{1,6})\s+(\S.*)$/;
const BULLET = /^[-*+]\s+(\S.*)$/;
const NUMBER = /^\d{1,9}[.)]\s+(\S.*)$/;

export function renderMarkdown(text: string, options: MarkdownOptions = {}): VNodeChild[] {
  return blocksOf(text, options, 0);
}

// The blocks of a text; `depth` counts the quotes around it.
function blocksOf(text: string, options: MarkdownOptions, depth: number): VNodeChild[] {
  const blocks: VNodeChild[] = [];
  let paragraph: string[] = [];
  let items: string[] = [];
  let ordered = false;
  const flush = () => {
    if (paragraph.length) {
      const parts = options.joinLines ? [inline(paragraph.join(' '))] : paragraph.map((l) => inline(l));
      blocks.push(h('p', parts.flatMap((p, i) => (i === 0 ? p : [h('br'), ...p]))));
    }
    if (items.length) blocks.push(h(ordered ? 'ol' : 'ul', items.map((i) => h('li', inline(i)))));
    paragraph = [];
    items = [];
  };
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let n = 0; n < lines.length; n += 1) {
    const line = lines[n]!;
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      flush();
      const code: string[] = [];
      for (n += 1; n < lines.length && !lines[n]!.trim().startsWith('```'); n += 1) code.push(lines[n]!);
      blocks.push(h('pre', { class: 'dm-md__code' }, [h('code', code.join('\n'))]));
      continue;
    }
    if (trimmed.startsWith('>') && depth < MAX_QUOTE_DEPTH) {
      flush();
      const quoted: string[] = [];
      for (; n < lines.length && lines[n]!.trim().startsWith('>'); n += 1) quoted.push(lines[n]!.trim().slice(1).replace(/^ /, ''));
      n -= 1;
      blocks.push(h('blockquote', blocksOf(quoted.join('\n'), options, depth + 1)));
      continue;
    }
    const heading = HEADING.exec(trimmed);
    const bullet = BULLET.exec(trimmed);
    const number = bullet ? null : NUMBER.exec(trimmed);
    if (!trimmed) flush();
    else if (heading) {
      flush();
      blocks.push(h(heading[1]!.length <= 2 ? 'h4' : 'h5', { class: 'dm-md__heading' }, inline(heading[2]!)));
    } else if (bullet || number) {
      if (paragraph.length || (items.length && ordered !== !bullet)) flush();
      ordered = !bullet;
      items.push((bullet ?? number)![1]!);
    } else if (items.length && /^\s/.test(line)) items[items.length - 1] += ` ${trimmed}`;
    else {
      if (items.length) flush();
      paragraph.push(trimmed);
    }
  }
  flush();
  return blocks;
}
