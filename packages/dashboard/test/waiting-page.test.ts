import { describe, expect, it } from 'vitest';
import { PAGE_STATES, checkHtml, checkIcon, editRights, fromLine, htmlWarnings, organizationView, previewHtml, resolveDraft, whyNoIcon } from '../src/waiting-page';

const bytes = (...b: number[]) => new Uint8Array(b);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3);
const text = (s: string) => new TextEncoder().encode(s);

describe('checkIcon', () => {
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
});

describe('editRights', () => {
  const template = { mode: 'template' as const, title: 'x' };
  const custom = { mode: 'custom' as const, html: '<p>x</p>' };
  it('lets viewers and members read only, without a reason to give', () => {
    expect(editRights('workload', 'viewer', false, template)).toEqual({ edit: false, custom: false, reason: '' });
    expect(editRights('router', 'member', false, null)).toEqual({ edit: false, custom: false, reason: '' });
  });
  it('gives operators the workload\'s template and administrators every level and Custom HTML', () => {
    expect(editRights('workload', 'operator', false, null)).toEqual({ edit: true, custom: false, reason: '' });
    expect(editRights('router', 'operator', false, null)).toEqual({ edit: false, custom: false, reason: '' });
    expect(editRights('organization', 'operator', false, null)).toEqual({ edit: false, custom: false, reason: '' });
    expect(editRights('organization', 'admin', false, custom)).toEqual({ edit: true, custom: true, reason: '' });
    expect(editRights('workload', 'admin', false, custom)).toEqual({ edit: true, custom: true, reason: '' });
  });
  it('gives an operator the reason, not the buttons, on a stored custom page', () => {
    const r = editRights('workload', 'operator', false, custom);
    expect(r).toMatchObject({ edit: false, custom: false });
    expect(r.reason).toMatch(/only an administrator/);
  });
  it('names the variable of a Terraform workload, for everyone who could write', () => {
    for (const role of ['operator', 'admin'] as const) {
      const r = editRights('workload', role, true, null);
      expect(r.edit).toBe(false);
      expect(r.reason).toContain('waiting_page');
    }
    expect(editRights('workload', 'viewer', true, null).reason).toBe('');
  });
});

describe('organizationView', () => {
  it('reads the organization\'s answer as a level with nothing above it', () => {
    const v = organizationView({ page: { mode: 'template', title: 'Acme' }, warnings: [], updatedAt: '2026-11-01T10:00:00Z', updatedBy: 'fab@example.com' });
    expect(v).toMatchObject({ own: { title: 'Acme' }, effective: { mode: 'template', icon: 'auto', title: 'Acme', from: { mode: 'organization', title: 'organization', icon: 'default' } }, by: 'fab@example.com', at: '2026-11-01T10:00:00Z', terraform: false });
    expect(organizationView({ page: null, warnings: [], updatedAt: null, updatedBy: null }).effective).toEqual({ mode: 'template', icon: 'auto', from: { mode: 'default', icon: 'default' } });
  });
});

describe('htmlWarnings', () => {
  it('asks for the status hook and flags a Content-Security-Policy meta tag', () => {
    expect(htmlWarnings('<p>wait</p>')).toEqual([expect.stringContaining('data-dormeto="status"')]);
    expect(htmlWarnings('<p data-dormeto="status"></p>')).toEqual([]);
    expect(htmlWarnings('<meta http-equiv="Content-Security-Policy" content="x"><p data-dormeto=status></p>')).toEqual([expect.stringContaining('Content-Security-Policy')]);
  });
});
