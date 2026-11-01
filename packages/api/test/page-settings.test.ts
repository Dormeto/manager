// The waiting page's rules in the manager (branded waiting page design §4): the organization's level is checked here, so
// the verdicts must be the router's. The shared cases run through both validators when the router's checkout is beside
// the manager's (as scripts/parity reaches ../router), and are skipped when it is absent.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanPage, pageWarnings, validatePage } from '../src/page-settings.js';

const file = resolve(import.meta.dirname, '../../../../router/lambda/src/lib/page-settings.mjs');
interface RouterRules { validatePage(doc: unknown): string[]; cleanPage(doc: unknown): unknown; pageWarnings(doc: unknown): string[] }
const router = (existsSync(file) ? await import(/* @vite-ignore */ file) : null) as RouterRules | null;

const png = (extra = 0) => `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(extra)]).toString('base64')}`;
const sized = (bytes: number) => `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(bytes - 8)]).toString('base64')}`;
const svg = (text: string) => `data:image/svg+xml;base64,${Buffer.from(text).toString('base64')}`;
const HTML = '<!doctype html><p data-dormeto="status"></p>';

// [name, document]: each is a verdict of the router's rules.
const CASES: [string, unknown][] = [
  ['template with everything', { mode: 'template', icon: 'auto', title: 'Acme portal', description: 'Our test\nenvironment sleeps.' }],
  ['template with nothing', { mode: 'template' }],
  ['icon none', { mode: 'template', icon: 'none' }],
  ['icon png', { mode: 'template', icon: png() }],
  ['icon at 64 KiB', { mode: 'template', icon: sized(64 * 1024) }],
  ['icon one byte over 64 KiB', { mode: 'template', icon: sized(64 * 1024 + 1) }],
  ['icon of the wrong type', { mode: 'template', icon: `data:image/jpeg;base64,${Buffer.from('not a jpeg').toString('base64')}` }],
  ['icon png holding svg', { mode: 'template', icon: `data:image/png;base64,${Buffer.from('<svg/>').toString('base64')}` }],
  ['icon svg after xml, comment and doctype', { mode: 'template', icon: svg('﻿ <?xml version="1.0"?><!-- c --><!DOCTYPE svg [<!ENTITY a "b">]><svg xmlns="http://www.w3.org/2000/svg"/>') }],
  ['icon svg starting with a script', { mode: 'template', icon: svg('<script>alert(1)</script><svg/>') }],
  ['icon bad base64', { mode: 'template', icon: 'data:image/png;base64,!!!' }],
  ['icon not a data uri', { mode: 'template', icon: 'https://example.com/a.png' }],
  ['icon a number', { mode: 'template', icon: 5 }],
  ['title of 80 characters', { mode: 'template', title: 'é'.repeat(80) }],
  ['title of 81 characters', { mode: 'template', title: 'a'.repeat(81) }],
  ['title with a line break', { mode: 'template', title: 'a\nb' }],
  ['title blank', { mode: 'template', title: '  ' }],
  ['title a number', { mode: 'template', title: 3 }],
  ['description of 500 characters', { mode: 'template', description: 'a'.repeat(500) }],
  ['description of 501 characters', { mode: 'template', description: 'a'.repeat(501) }],
  ['description with a control character', { mode: 'template', description: 'a\u0007b' }],
  ['description blank', { mode: 'template', description: '\n ' }],
  ['custom with a status hook', { mode: 'custom', html: HTML }],
  ['custom without a status hook', { mode: 'custom', html: '<p>Hello</p>' }],
  ['custom with a csp meta', { mode: 'custom', html: `<meta http-equiv="Content-Security-Policy" content="default-src 'self'">${HTML}` }],
  ['custom at 256 KiB', { mode: 'custom', html: 'a'.repeat(256 * 1024) }],
  ['custom one byte over 256 KiB', { mode: 'custom', html: 'a'.repeat(256 * 1024 + 1) }],
  ['custom within 256 KiB in characters, over in bytes', { mode: 'custom', html: 'é'.repeat(131_073) }],
  ['custom blank', { mode: 'custom', html: ' \n' }],
  ['custom without html', { mode: 'custom' }],
  ['custom html a number', { mode: 'custom', html: 4 }],
  ['custom with a template field', { mode: 'custom', html: HTML, title: 'x' }],
  ['template with html', { mode: 'template', html: HTML }],
  ['unknown key', { mode: 'template', color: 'red' }],
  ['unknown key, long and with markup', { mode: 'template', [`<!doctype html><script>${'k'.repeat(3000)}</script>`]: 1 }],
  ['title of 80 emoji (80 characters, 160 code units)', { mode: 'template', title: '😀'.repeat(80) }],
  ['title of 81 emoji', { mode: 'template', title: '😀'.repeat(81) }],
  ['description of 500 emoji', { mode: 'template', description: '😀'.repeat(500) }],
  ['description of 501 emoji', { mode: 'template', description: '😀'.repeat(501) }],
  ['title with a line separator', { mode: 'template', title: 'a\u2028b' }],
  ['title with a paragraph separator', { mode: 'template', title: 'a\u2029b' }],
  ['title with a delete character', { mode: 'template', title: 'a\u007fb' }],
  ['icon with canonical base64 padding wrong', { mode: 'template', icon: 'data:image/png;base64,iVBORw0KGgp=' }],
  ['icon with canonical base64', { mode: 'template', icon: 'data:image/png;base64,iVBORw0KGgo=' }],
  ['icon with no data', { mode: 'template', icon: 'data:image/png;base64,' }],
  ['icon of 100 KB of base64', { mode: 'template', icon: `data:image/png;base64,${'A'.repeat(100_000)}` }],
  ['icon of 100 KB of base64, valid and over 64 KiB', { mode: 'template', icon: sized(75_000) }],
  ['icon svg with a quoted > in the doctype', { mode: 'template', icon: svg('<!DOCTYPE svg PUBLIC "a>b"><svg/>') }],
  ['icon svg with a doctype in lower case', { mode: 'template', icon: svg('<!doctype svg><svg/>') }],
  ['icon svg with an unclosed comment', { mode: 'template', icon: svg('<!-- <svg/>') }],
  ['icon svgx', { mode: 'template', icon: svg('<svgx/>') }],
  ['icon svg followed by a name character', { mode: 'template', icon: svg('<svg-a/>') }],
  ['icon svg followed by a tab', { mode: 'template', icon: svg('<svg\txmlns="http://www.w3.org/2000/svg"/>') }],
  ['icon svg followed by >', { mode: 'template', icon: svg('<svg>') }],
  ['icon svg after an xml declaration', { mode: 'template', icon: svg('<?xml version="1.0"?><svg/>') }],
  ['icon svg after xml-stylesheet', { mode: 'template', icon: svg('<?xml-stylesheet href="a"?><svg/>') }],
  ['icon jpeg', { mode: 'template', icon: `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64')}` }],
  ['icon webp', { mode: 'template', icon: `data:image/webp;base64,${Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]).toString('base64')}` }],
  ['icon webp without WEBP', { mode: 'template', icon: `data:image/webp;base64,${Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBX')]).toString('base64')}` }],
  ['icon x-icon', { mode: 'template', icon: `data:image/x-icon;base64,${Buffer.from([0, 0, 1, 0, 1]).toString('base64')}` }],
  ['icon x-icon with a wrong signature', { mode: 'template', icon: `data:image/x-icon;base64,${Buffer.from([0, 0, 2, 0, 1]).toString('base64')}` }],
  ['icon gif', { mode: 'template', icon: `data:image/gif;base64,${Buffer.from('GIF89a').toString('base64')}` }],
  ['custom with a single-quoted hook', { mode: 'custom', html: "<p data-dormeto='status'></p>" }],
  ['custom with a bare hook', { mode: 'custom', html: '<p data-dormeto=status></p>' }],
  ['custom with a bare hook followed by a name character', { mode: 'custom', html: '<p data-dormeto=statusx></p>' }],
  ['custom with a capitalized attribute name', { mode: 'custom', html: '<p DATA-DORMETO="status"></p>' }],
  ['custom with a capitalized value', { mode: 'custom', html: '<p data-dormeto="Status"></p>' }],
  ['custom with spaces around the equals sign', { mode: 'custom', html: '<p data-dormeto = "status"></p>' }],
  ['custom with a hook of another name', { mode: 'custom', html: '<p data-dormeto="elapsed"></p>' }],
  ['custom with a csp meta in single quotes', { mode: 'custom', html: `<META HTTP-EQUIV='Content-Security-Policy' content="x">${HTML}` }],
  ['custom with a csp meta unquoted', { mode: 'custom', html: `<meta http-equiv=content-security-policy content="x">${HTML}` }],
  ['custom with a meta that is not a csp', { mode: 'custom', html: `<meta http-equiv="refresh" content="1">${HTML}` }],
  ['custom with an unclosed meta', { mode: 'custom', html: `<meta http-equiv="Content-Security-Policy" ${HTML}` }],
  ['custom of 256 KiB with a late csp meta', { mode: 'custom', html: `${HTML}${'a'.repeat(200_000)}<meta http-equiv="Content-Security-Policy" content="x">` }],
  ['unknown mode', { mode: 'both' }],
  ['mode a number', { mode: 1 }],
  ['no mode', { title: 'x' }],
  ['an array', []],
  ['null', null],
  ['a string', 'template'],
  ['a number', 7],
];

// The cases the rules accept (warnings aside).
const VALID = new Set(['template with everything', 'template with nothing', 'icon none', 'icon png', 'icon at 64 KiB', 'icon svg after xml, comment and doctype', 'title of 80 characters',
  'description of 500 characters',
  'title of 80 emoji (80 characters, 160 code units)', 'description of 500 emoji', 'icon with canonical base64', 'icon svg with a quoted > in the doctype', 'icon svg with a doctype in lower case',
  'icon svg followed by a tab', 'icon svg followed by >', 'icon svg after an xml declaration', 'icon jpeg', 'icon webp', 'icon x-icon',
  'custom with a single-quoted hook', 'custom with a bare hook', 'custom with a capitalized attribute name', 'custom with a capitalized value', 'custom with spaces around the equals sign',
  'custom with a hook of another name', 'custom with a csp meta in single quotes', 'custom with a csp meta unquoted', 'custom with a meta that is not a csp', 'custom with an unclosed meta',
  'custom of 256 KiB with a late csp meta', 'custom with a bare hook followed by a name character', 'custom with a status hook', 'custom without a status hook', 'custom with a csp meta', 'custom at 256 KiB']);

describe('validatePage', () => {
  it('accepts each valid document and says nothing', () => {
    for (const [name, doc] of CASES) if (VALID.has(name)) expect(validatePage(doc), name).toEqual([]);
  });

  it('says each problem as a sentence', () => {
    const problems = (name: string) => validatePage(CASES.find(([n]) => n === name)![1]);
    expect(problems('icon one byte over 64 KiB')).toEqual(['icon must be at most 64 KiB once decoded']);
    expect(problems('title of 81 characters')).toEqual(['title must be at most 80 characters']);
    expect(problems('custom one byte over 256 KiB')).toEqual(['html must be at most 256 KiB']);
    expect(problems('custom without html')).toEqual(['html is required in a custom page']);
    expect(problems('template with html')).toEqual(['html is not a field of a template page']);
    expect(problems('unknown mode')).toEqual(['mode must be template or custom']);
    expect(problems('null')).toEqual(['the page must be an object']);
  });

  it('refuses the rest', () => {
    for (const [name, doc] of CASES) if (!VALID.has(name)) expect(validatePage(doc).length, name).toBeGreaterThan(0);
  });
});

describe('cleanPage', () => {
  it('keeps what is valid and drops what is not, and a custom page without valid html is no page', () => {
    expect(cleanPage({ mode: 'template', title: 'a\nb', description: 'ok', color: 'red' })).toEqual({ mode: 'template', description: 'ok' });
    expect(cleanPage({ mode: 'custom', html: ' ', title: 'x' })).toBeNull();
    expect(cleanPage({ mode: 'custom', html: HTML, title: 'x' })).toEqual({ mode: 'custom', html: HTML });
    for (const value of [null, undefined, 1, 'x', [], { mode: 'x' }]) expect(cleanPage(value)).toBeNull();
  });
});

describe('pageWarnings', () => {
  it('names what a custom page should fix, and nothing for a template', () => {
    expect(pageWarnings({ mode: 'custom', html: HTML })).toEqual([]);
    expect(pageWarnings({ mode: 'custom', html: '<p>Hi</p>' })).toEqual(['the page has no element data-dormeto="status": the visitor will not read why it waits']);
    expect(pageWarnings({ mode: 'custom', html: `<meta http-equiv="Content-Security-Policy" content="x">${HTML}` }))
      .toEqual(['a Content-Security-Policy meta tag may block the script Dormeto adds, and the wake with it in browser mode']);
    expect(pageWarnings({ mode: 'template', title: 'x' })).toEqual([]);
  });
});

describe.skipIf(!router)('the router\'s rules, on the same cases', () => {
  it('agree on every verdict, clean document and warning', () => {
    for (const [name, doc] of CASES) {
      expect(validatePage(doc), name).toEqual(router!.validatePage(doc));
      expect(cleanPage(doc), name).toEqual(router!.cleanPage(doc));
      expect(pageWarnings(doc), name).toEqual(router!.pageWarnings(doc));
    }
  });
});
