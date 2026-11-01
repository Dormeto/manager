// The waiting page's rules (branded waiting page design §4), as the router holds them in lambda/src/lib/page-settings.mjs:
// the organization's level is checked here, and a test runs the same cases through both. A change to one is a change to the
// other. Terraform and a hand-edited settings.json bypass the write's check, so every read goes through cleanPage.
const FIELDS: Record<string, string[]> = { template: ['icon', 'title', 'description'], custom: ['html'] };
const ICON_BYTES = 64 * 1024;
const HTML_BYTES = 256 * 1024;

type Doc = Record<string, unknown>;
const isObject = (value: unknown): value is Doc => typeof value === 'object' && value !== null && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const has = (object: Doc, key: string) => Object.hasOwn(object, key);
// The mode of a document: one of FIELDS' own names, as a string; null for anything else.
const modeOf = (doc: unknown): string | null => (isObject(doc) && typeof doc.mode === 'string' && Object.hasOwn(FIELDS, doc.mode) ? doc.mode : null);
// A string's length in characters against a limit; a string longer than twice the limit is over it, whatever it holds.
const over = (text: string, limit: number) => text.length > 2 * limit || Array.from(text).length > limit;
const SINGLE_LINE = /[\u0000-\u001f\u007f\p{Zl}\p{Zp}]/u;
const MULTI_LINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const startsWith = (bytes: Uint8Array, signature: number[], at = 0) => signature.every((b, i) => bytes[at + i] === b);
const BLANKS = new Set([' ', '\t', '\n', '\r', '\f', '﻿']);
const isBlank = (text: string, at: number) => BLANKS.has(text[at] ?? '');

// The end of a DOCTYPE starting at `at`: after its '>', skipping quoted strings and an internal subset; -1 when unclosed.
function doctypeEnd(text: string, at: number): number {
  let quote: string | null = null;
  let depth = 0;
  for (let i = at + 9; i < text.length; i += 1) {
    const c = text[i];
    if (quote) { if (c === quote) quote = null; } else if (c === '"' || c === "'") quote = c;
    else if (c === '[') depth += 1;
    else if (c === ']') depth = Math.max(0, depth - 1);
    else if (c === '>' && depth === 0) return i + 1;
  }
  return -1;
}

// Whether the first element of an XML text is <svg: a linear scan over a byte order mark, white space, the XML declaration,
// comments and a DOCTYPE, then `<svg` followed by white space, '/' or '>'. No regular expression: nothing can backtrack.
function startsWithSvg(text: string): boolean {
  let i = 0;
  for (;;) {
    while (i < text.length && isBlank(text, i)) i += 1;
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end < 0) return false;
      i = end + 3;
    } else if (text.startsWith('<?xml', i) && isBlank(text, i + 5)) {
      const end = text.indexOf('?>', i + 5);
      if (end < 0) return false;
      i = end + 2;
    } else if (text.slice(i, i + 9).toLowerCase() === '<!doctype') {
      i = doctypeEnd(text, i);
      if (i < 0) return false;
    } else break;
  }
  return text.startsWith('<svg', i) && (isBlank(text, i + 4) || text[i + 4] === '/' || text[i + 4] === '>');
}

const SIGNATURES: Record<string, (bytes: Uint8Array) => boolean> = {
  png: (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpeg: (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]),
  webp: (bytes) => startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8),
  'x-icon': (bytes) => startsWith(bytes, [0, 0, 1, 0]),
  'svg+xml': (bytes) => startsWithSvg(Buffer.from(bytes).toString('utf8')),
};

function checkIcon(icon: unknown): string | null {
  if (icon === 'auto' || icon === 'none') return null;
  const found = typeof icon === 'string' && icon.length <= 100_000 && /^data:image\/(png|jpeg|webp|svg\+xml|x-icon);base64,([A-Za-z0-9+/]*={0,2})$/.exec(icon);
  if (!found) return 'icon must be auto, none, or a data:image/png, jpeg, webp, svg+xml or x-icon base64 URI of at most 64 KiB';
  const [, type, data] = found as unknown as [string, string, string];
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data || bytes.length === 0) return 'icon is not valid base64';
  if (bytes.length > ICON_BYTES) return 'icon must be at most 64 KiB once decoded';
  if (!SIGNATURES[type]!(bytes)) return `icon is not a ${type} image`;
  return null;
}

function checkTitle(title: unknown): string | null {
  if (typeof title !== 'string' || over(title, 80)) return typeof title === 'string' ? 'title must be at most 80 characters' : 'title must be one line of text';
  if (!title.trim() || SINGLE_LINE.test(title)) return 'title must be one line of text';
  return null;
}

function checkDescription(description: unknown): string | null {
  if (typeof description !== 'string' || over(description, 500)) return typeof description === 'string' ? 'description must be at most 500 characters' : 'description must be text';
  return !description.trim() || MULTI_LINE.test(description) ? 'description must be text' : null;
}

function checkHtml(html: unknown): string | null {
  if (typeof html !== 'string') return 'html must be a page, not blank';
  // Each UTF-16 unit is at least one byte, so more units than the limit is over it.
  if (html.length > HTML_BYTES || Buffer.byteLength(html) > HTML_BYTES) return 'html must be at most 256 KiB';
  return html.trim() ? null : 'html must be a page, not blank';
}

const CHECKS: Record<string, (value: unknown) => string | null> = { icon: checkIcon, title: checkTitle, description: checkDescription, html: checkHtml };

// Every problem of a document, as sentences; [] when it is fine.
export function validatePage(doc: unknown): string[] {
  if (!isObject(doc)) return ['the page must be an object'];
  const mode = modeOf(doc);
  if (!mode) return ['mode must be template or custom'];
  const problems: string[] = [];
  for (const key of Object.keys(doc)) if (key !== 'mode' && !FIELDS[mode]!.includes(key)) problems.push(`${key} is not a field of a ${mode} page`);
  for (const key of FIELDS[mode]!) {
    if (has(doc, key)) { const problem = CHECKS[key]!(doc[key]); if (problem) problems.push(problem); }
    else if (key === 'html') problems.push('html is required in a custom page');
  }
  return problems;
}

// The valid document, or null: a custom one with no valid html is no document. Never throws, whatever the value.
export function cleanPage(doc: unknown): Doc | null {
  const mode = modeOf(doc);
  if (!mode || !isObject(doc)) return null;
  const page: Doc = { mode };
  for (const key of FIELDS[mode]!) if (has(doc, key) && !CHECKS[key]!(doc[key])) page[key] = doc[key];
  return mode === 'custom' && !has(page, 'html') ? null : page;
}

const META = /<meta[\s/]/gi;
const HOOK_STATUS = /data-dormeto\s*=\s*(?:"status"|'status'|status(?![^\s>/]))/gi;

// What a custom page should fix, without being refused. Linear in the page: a hook inside a comment counts.
export function pageWarnings(doc: unknown): string[] {
  const page = cleanPage(doc);
  if (page?.mode !== 'custom') return [];
  const html = page.html as string;
  const warnings: string[] = [];
  // The value is case sensitive, as the script's selector is; the attribute's name is not.
  if (![...html.matchAll(HOOK_STATUS)].some((m) => m[0].includes('status'))) warnings.push('the page has no element data-dormeto="status": the visitor will not read why it waits');
  let end = -1;
  for (const m of html.matchAll(META)) {
    if (end < m.index) end = html.indexOf('>', m.index);
    if (end < 0) break;
    if (/http-equiv\s*=\s*["']?content-security-policy/i.test(html.slice(m.index, Math.min(end, m.index + 1000)))) {
      warnings.push('a Content-Security-Policy meta tag may block the script Dormeto adds, and the wake with it in browser mode');
      break;
    }
  }
  return warnings;
}
