// @vitest-environment node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { napMessage } from '../src/waiting-page/page.mjs';
import { PAGE_STATES, checkHtml, checkIcon, editRights, fromLine, htmlWarnings, organizationView, previewHtml, resolveDraft, whyNoIcon } from '../src/waiting-page';

const routerRules = resolve(import.meta.dirname, '../../../../router/lambda/src/lib/page-settings.mjs');
interface RouterRules { validatePage(d: unknown): string[]; cleanPage(d: unknown): { html?: string } | null }
const router = (existsSync(routerRules) ? await import(/* @vite-ignore */ routerRules) : null) as RouterRules | null;
const bytes = (...b: number[]) => new Uint8Array(b);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3);
const text = (s: string) => new TextEncoder().encode(s);

describe('checkIcon', () => {
  it('reads the whole SVG, as the router does: a long comment before <svg is fine', () => {
    const svg = `<?xml version="1.0"?><!-- ${'x'.repeat(6000)} --><svg xmlns="http://www.w3.org/2000/svg"/>`;
    expect(checkIcon(text(svg))).toHaveProperty('uri');
  });
  it('takes the type from the bytes, never from the name or the browser, and gives a data URI', () => {
    const png = checkIcon(PNG);
    expect(png).toEqual({ uri: `data:image/png;base64,${btoa(String.fromCharCode(...PNG))}` });
    expect(checkIcon(bytes(0xff, 0xd8, 0xff, 0xe0))).toMatchObject({ uri: expect.stringMatching(/^data:image\/jpeg;base64,/) });
    expect(checkIcon(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50))).toMatchObject({ uri: expect.stringMatching(/^data:image\/webp;/) });
    expect(checkIcon(bytes(0, 0, 1, 0, 1, 0))).toMatchObject({ uri: expect.stringMatching(/^data:image\/x-icon;/) });
    expect(checkIcon(text('﻿ <?xml version="1.0"?><!-- c --><!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>'))).toMatchObject({ uri: expect.stringMatching(/^data:image\/svg\+xml;/) });
  });
  it('refuses a file of no known type, an SVG not starting with <svg, an empty file and one over 64 KiB', () => {
    expect(checkIcon(text('GIF89a'))).toEqual({ problem: expect.stringContaining('PNG, JPEG, WebP, SVG or ICO') });
    expect(checkIcon(text('<script>alert(1)</script><svg/>'))).toHaveProperty('problem');
    expect(checkIcon(bytes())).toHaveProperty('problem');
    const big = new Uint8Array(64 * 1024 + 1);
    big.set(PNG);
    expect(checkIcon(big)).toEqual({ problem: expect.stringContaining('64 KiB') });
    const edge = new Uint8Array(64 * 1024);
    edge.set(PNG);
    expect(checkIcon(edge)).toHaveProperty('uri');
  });
});

describe('checkHtml', () => {
  it('keeps a byte order mark: the saved page is the uploaded text', () => {
    expect(checkHtml(bytes(0xef, 0xbb, 0xbf, 0x3c, 0x70, 0x3e))).toEqual({ html: '\uFEFF<p>' });
    expect(checkHtml(bytes(0xef, 0xbb, 0xbf))).toEqual({ problem: expect.stringContaining('blank') });
  });
  it.skipIf(!existsSync(routerRules))('is accepted by the router\'s rules, a byte order mark included', async () => {
    const rules = router!;
    const found = checkHtml(bytes(0xef, 0xbb, 0xbf, ...text('<!doctype html><p data-dormeto="status">')));
    const html = (found as { html: string }).html;
    expect(rules.validatePage({ mode: 'custom', html })).toEqual([]);
    expect(rules.cleanPage({ mode: 'custom', html })!.html).toBe(html);
    expect(rules.validatePage({ mode: 'custom', html: '\uFEFF' })).not.toEqual([]);
  });
  it('refuses a blank page and one over 256 KiB in bytes, and keeps the text', () => {
    expect(checkHtml(text('  \n'))).toEqual({ problem: expect.stringContaining('blank') });
    expect(checkHtml(text('<p>é</p>'))).toEqual({ html: '<p>é</p>' });
    expect(checkHtml(new Uint8Array(256 * 1024 + 1).fill(97))).toEqual({ problem: expect.stringContaining('256 KiB') });
    expect(checkHtml(new Uint8Array(256 * 1024).fill(97))).toHaveProperty('html');
    expect(checkHtml(text('é'.repeat(131_073)))).toHaveProperty('problem');
  });
  it('refuses bytes that are not UTF-8', () => {
    expect(checkHtml(bytes(0xff, 0xfe, 0x3c))).toEqual({ problem: expect.stringContaining('UTF-8') });
  });
});

describe('resolveDraft', () => {
  const inherited = { mode: 'template' as const, icon: 'auto', title: 'Acme', from: { mode: 'organization', icon: 'default', title: 'organization' } };
  it('takes each field of a template from the draft, then from what it inherits', () => {
    expect(resolveDraft({ mode: 'template', description: 'Sleeps at night.' }, inherited)).toMatchObject({ mode: 'template', icon: 'auto', title: 'Acme', description: 'Sleeps at night.' });
    expect(resolveDraft({ mode: 'template', title: 'Mine', icon: 'none' }, inherited)).toMatchObject({ icon: 'none', title: 'Mine' });
  });
  it('drops an inherited field the draft does not have when the inherited page is custom', () => {
    expect(resolveDraft({ mode: 'template' }, { mode: 'custom', html: '<p>x</p>' })).toEqual({ mode: 'template', icon: 'auto' });
  });
  it('takes the fields a custom page in the middle skips from the template beneath it, as the router does', () => {
    const beneath = { mode: 'template' as const, icon: 'none', title: 'ORG-T', description: 'ORG-D', from: { mode: 'organization' } };
    const custom = { mode: 'custom' as const, html: '<p>x</p>', from: { mode: 'router' } };
    expect(resolveDraft({ mode: 'template', icon: 'auto' }, custom, beneath)).toEqual({ mode: 'template', icon: 'auto', title: 'ORG-T', description: 'ORG-D' });
    expect(resolveDraft({ mode: 'template', title: 'Mine' }, custom, beneath)).toEqual({ mode: 'template', icon: 'none', title: 'Mine', description: 'ORG-D' });
    expect(resolveDraft({ mode: 'template' }, custom, null)).toEqual({ mode: 'template', icon: 'auto' });
    expect(resolveDraft({ mode: 'template' }, { mode: 'template', icon: 'auto', title: 'R' }, beneath)).toEqual({ mode: 'template', icon: 'auto', title: 'R' });
  });
  it('is the custom page itself for a custom draft', () => {
    expect(resolveDraft({ mode: 'custom', html: '<p>x</p>' }, inherited)).toEqual({ mode: 'custom', html: '<p>x</p>' });
  });
});

describe('previewHtml', () => {
  const page = { mode: 'template' as const, icon: 'none', title: 'Acme portal', description: 'Our <b>test</b> site sleeps.' };
  it('draws the four states with fixed numbers', () => {
    const waking = previewHtml({ page, state: 'waking', language: 'en', dark: false });
    expect(waking).toContain('aria-valuenow="60"');
    expect(waking).toContain('Waking up the application…');
    expect(waking).toContain('Acme portal');
    expect(waking).toContain('Our &lt;b&gt;test&lt;/b&gt; site sleeps.');
    const longer = previewHtml({ page, state: 'longer', language: 'en', dark: false });
    expect(longer).toContain('This is taking longer than usual.');
    expect(longer).toContain('aria-valuenow="95"');
    const failed = previewHtml({ page, state: 'failed', language: 'en', dark: false });
    expect(failed).toContain('has no capacity for this application right now');
    expect(failed).toMatch(/next attempt in 2 minutes/);
    expect(failed).not.toContain('role="progressbar"');
    const nap = previewHtml({ page, state: 'nap', language: 'en', dark: false });
    expect(nap).toMatch(/Napping on schedule until Mon 08:00/);
    expect(PAGE_STATES.map((s) => s.value)).toEqual(['waking', 'longer', 'failed', 'nap']);
  });
  it('speaks French on request', () => {
    expect(previewHtml({ page, state: 'waking', language: 'fr', dark: false })).toContain('Démarrage de l&#39;application…');
    expect(previewHtml({ page, state: 'nap', language: 'fr', dark: false })).toContain('En pause programmée jusqu&#39;à lun. 08:00');
  });
  it('forces the color scheme the dialog asks for, whatever the browser prefers', () => {
    const light = previewHtml({ page, state: 'waking', language: 'en', dark: false });
    const dark = previewHtml({ page, state: 'waking', language: 'en', dark: true });
    expect(light).not.toMatch(/prefers-color-scheme/);
    expect(dark).not.toMatch(/prefers-color-scheme/);
    expect(dark).toContain('(min-width:0)');
    expect(light).toContain('(min-width:100000px)');
  });
  it('shows an uploaded icon or the cached favicon for auto, and the page of a custom document as it is plus the router\'s script', () => {
    const icon = 'data:image/png;base64,iVBORw0KGgo=';
    expect(previewHtml({ page: { ...page, icon }, state: 'waking', language: 'en', dark: false })).toContain(`src="${icon}"`);
    expect(previewHtml({ page: { ...page, icon: 'auto' }, favicon: icon, state: 'waking', language: 'en', dark: false })).toContain(`src="${icon}"`);
    expect(previewHtml({ page: { ...page, icon: 'auto' }, state: 'waking', language: 'en', dark: false })).toContain('class="dot"');
    const custom = previewHtml({ page: { mode: 'custom', html: '<!doctype html><p data-dormeto="status"></p>' }, state: 'waking', language: 'en', dark: false });
    expect(custom.startsWith('<!doctype html>')).toBe(true);
    expect(custom).toContain('<p data-dormeto="status"></p>');
  });
});

describe('words', () => {
  it('names the level of a field', () => {
    expect(fromLine('organization')).toBe('Organization');
    expect(fromLine('router')).toBe('Router');
    expect(fromLine('workload')).toBe('This workload');
    expect(fromLine('default')).toBe('Built-in');
  });
  it('says why a workload has no cached favicon', () => {
    expect(whyNoIcon(null)).toMatch(/not read yet/);
    expect(whyNoIcon({ icon: null, fetchedAt: '2026-11-01T10:00:00Z', error: 'no host name' })).toBe('no host name');
    expect(whyNoIcon({ icon: null, fetchedAt: null, error: null })).toMatch(/not read yet/);
  });
  it('does not say a favicon is waiting to be read when the page never reads it', () => {
    const auto = { mode: 'template' as const, icon: 'auto' };
    expect(whyNoIcon(null, auto)).toMatch(/not read yet/);
    expect(whyNoIcon(null, { mode: 'custom' })).toBe('not read: the page is a custom one');
    expect(whyNoIcon(null, { mode: 'template', icon: 'none' })).toBe('not read: the icon is none');
    expect(whyNoIcon(null, { mode: 'template', icon: 'data:image/png;base64,AAAA' })).toBe('not read: an uploaded image is shown');
    expect(whyNoIcon({ icon: null, fetchedAt: '2026-11-01T10:00:00Z', error: 'no rule for the whole of a host name' }, { mode: 'custom' })).toBe('not read: the page is a custom one');
  });
});

describe('editRights', () => {
  const template = { mode: 'template' as const, title: 'x' };
  const custom = { mode: 'custom' as const, html: '<p>x</p>' };
  const NONE = { edit: false, custom: false, reset: false, reason: '' };
  it('lets viewers and members read only, without a reason to give', () => {
    expect(editRights('workload', 'viewer', false, template, 'a@b')).toEqual(NONE);
    expect(editRights('router', 'member', false, null, null)).toEqual(NONE);
  });
  it('gives operators the workload\'s template and administrators every level and Custom HTML', () => {
    expect(editRights('workload', 'operator', false, null, null)).toEqual({ edit: true, custom: false, reset: false, reason: '' });
    expect(editRights('workload', 'operator', false, template, 'a@b')).toEqual({ edit: true, custom: false, reset: true, reason: '' });
    expect(editRights('router', 'operator', false, null, null)).toEqual(NONE);
    expect(editRights('organization', 'operator', false, null, null)).toEqual(NONE);
    expect(editRights('organization', 'admin', false, custom, 'a@b')).toEqual({ edit: true, custom: true, reset: true, reason: '' });
    expect(editRights('workload', 'admin', false, custom, 'a@b')).toEqual({ edit: true, custom: true, reset: true, reason: '' });
  });
  it('gives an operator the reason, not the buttons, on a stored custom page', () => {
    const r = editRights('workload', 'operator', false, custom, 'a@b');
    expect(r).toMatchObject({ edit: false, custom: false, reset: false });
    expect(r.reason).toMatch(/only an administrator/);
  });
  it('names the variable of a Terraform workload, for everyone who could write', () => {
    for (const role of ['operator', 'admin'] as const) {
      const r = editRights('workload', role, true, null, null);
      expect(r).toMatchObject({ edit: false, reset: false });
      expect(r.reason).toContain('waiting_page');
    }
    expect(editRights('workload', 'viewer', true, null, null).reason).toBe('');
  });
  it('lets a page the manager wrote before the workload moved to Terraform be reset, not one Terraform wrote', () => {
    const left = editRights('workload', 'admin', true, template, 'ops@example.com');
    expect(left).toMatchObject({ edit: false, reset: true });
    expect(left.reason).toContain('waiting_page');
    expect(editRights('workload', 'admin', true, template, null)).toMatchObject({ edit: false, reset: false });
    expect(editRights('workload', 'operator', true, template, 'ops@example.com')).toMatchObject({ reset: true });
    expect(editRights('workload', 'operator', true, custom, 'ops@example.com')).toMatchObject({ reset: false });
    expect(editRights('workload', 'admin', true, custom, 'ops@example.com')).toMatchObject({ reset: true });
    expect(editRights('workload', 'viewer', true, template, 'ops@example.com')).toMatchObject({ reset: false });
  });
});

describe('organizationView', () => {
  it('reads the organization\'s answer as a level with nothing above it', () => {
    const v = organizationView({ page: { mode: 'template', title: 'Acme' }, warnings: [], at: '2026-11-01T10:00:00Z', by: 'fab@example.com' });
    expect(v).toMatchObject({ own: { title: 'Acme' }, effective: { mode: 'template', icon: 'auto', title: 'Acme', from: { mode: 'organization', title: 'organization', icon: 'default' } }, by: 'fab@example.com', at: '2026-11-01T10:00:00Z', terraform: false });
    expect(organizationView({ page: null, warnings: [], at: null, by: null }).effective).toEqual({ mode: 'template', icon: 'auto', from: { mode: 'default', icon: 'default' } });
  });
});

describe('htmlWarnings', () => {
  it('is linear in the page: a file of repeated <meta is read in a blink', () => {
    const hostile = '<meta '.repeat(40_000);
    const t = performance.now();
    expect(htmlWarnings(hostile)).toEqual([expect.stringContaining('data-dormeto="status"')]);
    expect(performance.now() - t).toBeLessThan(250);
    const spaced = `<meta ${' '.repeat(100_000)}`.repeat(2);
    const u = performance.now();
    htmlWarnings(spaced + 'data-dormeto'.repeat(10_000));
    expect(performance.now() - u).toBeLessThan(250);
  });
  it('matches the router\'s warnings: the attribute\'s name in any case, the value\'s case kept, linear', () => {
    const pages = ['<p DATA-DORMETO="status"></p>', '<p data-dormeto="STATUS"></p>', "<p data-dormeto='Status'>", '<p data-dormeto=status>', '<p data-dormeto=statusx>', '<!-- data-dormeto="status" -->', '<META HTTP-EQUIV="Content-Security-Policy" content="x">', '<p>x</p>'];
    expect(htmlWarnings('<p data-dormeto="STATUS"></p>')).toEqual([expect.stringContaining('data-dormeto="status"')]);
    expect(htmlWarnings('<p DATA-DORMETO="status"></p>')).toEqual([]);
    if (router) for (const page of pages) expect(htmlWarnings(page), page).toEqual((router as unknown as { pageWarnings(d: unknown): string[] }).pageWarnings({ mode: 'custom', html: page }));
    const t = performance.now();
    htmlWarnings('data-dormeto="STATUS"'.repeat(12_000));
    expect(performance.now() - t).toBeLessThan(250);
  });
  it('asks for the status hook and flags a Content-Security-Policy meta tag', () => {
    expect(htmlWarnings('<p>wait</p>')).toEqual([expect.stringContaining('data-dormeto="status"')]);
    expect(htmlWarnings('<p data-dormeto="status"></p>')).toEqual([]);
    expect(htmlWarnings('<meta http-equiv="Content-Security-Policy" content="x"><p data-dormeto=status></p>')).toEqual([expect.stringContaining('Content-Security-Policy')]);
  });
});

describe('a nap whose end is not known', () => {
  it('says no end, in each language, and a known end as the router writes it', () => {
    expect(napMessage({ at: null, local: null, timeZone: 'Europe/Paris' })).toBe('Napping on schedule.');
    expect(napMessage({ at: null, local: null, timeZone: 'Europe/Paris' }, 'fr')).toBe('En pause programmée.');
    expect(napMessage({ local: 'Tue 2027-01-19 23:45', timeZone: 'Europe/Paris' })).toBe('Napping on schedule until Tue 2027-01-19 23:45 (Europe/Paris).');
  });
});
