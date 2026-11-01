// The branded waiting page as the dashboard handles it (router 0.35.0 and later): the checks made before a file is sent, the
// draft resolved over what it inherits, and the preview's HTML, drawn by the router's own renderer (a copy of its page.mjs).
// The API and the router check every write again: these only avoid a dead end.
import type { Role } from './auth';
import { renderPage, type Language, type PageDocument } from './waiting-page/page.mjs';

export type PageLevel = 'organization' | 'router' | 'workload';
export type TemplatePage = { mode: 'template'; icon?: string; title?: string; description?: string };
export type CustomPage = { mode: 'custom'; html: string };
export type StoredPage = TemplatePage | CustomPage;
// The router's resolved page: the level (or 'default') each field comes from.
export type EffectivePage = { mode: 'template' | 'custom'; icon?: string; title?: string; description?: string; html?: string; from: Record<string, string> };
export interface Favicon { icon: string | null; fetchedAt: string | null; error: string | null }
// What GET answers for a router or a workload (the organization's answers { page, warnings, by, at }).
export interface WaitingPageView {
  own: StoredPage | null;
  inherited: EffectivePage;
  effective: EffectivePage;
  from: Record<string, string>;
  favicon?: Favicon | null;
  warnings: string[];
  terraform: boolean;
  by: string | null;
  at: string | null;
}
export interface OrganizationPageView { page: StoredPage | null; warnings: string[]; at: string | null; by: string | null; error?: string }

export const ICON_BYTES = 64 * 1024;
export const HTML_BYTES = 256 * 1024;
export const TITLE_MAX = 80;
export const DESCRIPTION_MAX = 500;

const starts = (bytes: Uint8Array, signature: number[], at = 0) => signature.every((b, i) => bytes[at + i] === b);
const BLANKS = new Set([' ', '\t', '\n', '\r', '\f', '﻿']);

// Whether the first element of an XML text is <svg, after a byte order mark, white space, the XML declaration, comments and a
// DOCTYPE (as the router reads it).
function startsWithSvg(text: string): boolean {
  let i = 0;
  for (;;) {
    while (i < text.length && BLANKS.has(text[i]!)) i += 1;
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end < 0) return false;
      i = end + 3;
    } else if (text.startsWith('<?xml', i) && BLANKS.has(text[i + 5] ?? '')) {
      const end = text.indexOf('?>', i + 5);
      if (end < 0) return false;
      i = end + 2;
    } else if (text.slice(i, i + 9).toLowerCase() === '<!doctype') {
      let quote = '';
      let depth = 0;
      let j = i + 9;
      for (; j < text.length; j += 1) {
        const c = text[j]!;
        if (quote) { if (c === quote) quote = ''; } else if (c === '"' || c === "'") quote = c;
        else if (c === '[') depth += 1;
        else if (c === ']') depth = Math.max(0, depth - 1);
        else if (c === '>' && depth === 0) break;
      }
      if (j >= text.length) return false;
      i = j + 1;
    } else break;
  }
  const next = text[i + 4] ?? '';
  return text.startsWith('<svg', i) && (BLANKS.has(next) || next === '/' || next === '>');
}

// The image type of some bytes by their signature, never by the file's name or the browser's `file.type`.
export function iconTypeOf(bytes: Uint8Array): 'png' | 'jpeg' | 'webp' | 'svg+xml' | 'x-icon' | null {
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (starts(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (starts(bytes, [0x52, 0x49, 0x46, 0x46]) && starts(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp';
  if (starts(bytes, [0, 0, 1, 0])) return 'x-icon';
  if (startsWithSvg(new TextDecoder().decode(bytes))) return 'svg+xml';
  return null;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// A chosen file's size against its limit, before a byte of it is read; '' when it fits.
export const iconSizeProblem = (size: number): string => (size > ICON_BYTES ? 'The icon must be at most 64 KiB.' : '');
export const htmlSizeProblem = (size: number): string => (size > HTML_BYTES ? 'The page must be at most 256 KiB.' : '');

// A chosen icon file: its data URI, or what is wrong with it.
export function checkIcon(bytes: Uint8Array): { uri: string } | { problem: string } {
  if (!bytes.length) return { problem: 'The file is empty.' };
  if (iconSizeProblem(bytes.length)) return { problem: iconSizeProblem(bytes.length) };
  const type = iconTypeOf(bytes);
  if (!type) return { problem: 'The icon must be a PNG, JPEG, WebP, SVG or ICO image.' };
  return { uri: `data:image/${type};base64,${base64(bytes)}` };
}

// A chosen HTML file: its text, or what is wrong with it.
export function checkHtml(bytes: Uint8Array): { html: string } | { problem: string } {
  if (htmlSizeProblem(bytes.length)) return { problem: htmlSizeProblem(bytes.length) };
  let html: string;
  try {
    html = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { problem: 'The page must be UTF-8 text.' };
  }
  return html.trim() ? { html } : { problem: 'The page is blank.' };
}

// The template whose fields a draft inherits: the inherited page when it is a template; when it is a custom page (a level in the
// middle), the router skips it and takes each field from the most specific template above it, `beneath` (the organization's).
export function templateAbove(inherited: Pick<EffectivePage, 'mode' | 'icon' | 'title' | 'description' | 'html'>, beneath?: Pick<EffectivePage, 'mode' | 'icon' | 'title' | 'description' | 'html'> | null): Partial<EffectivePage> {
  if (inherited.mode === 'template') return inherited;
  return beneath?.mode === 'template' ? beneath : {};
}

// The draft over what the level inherits, as the router resolves them: a template takes each field from the draft, then from
// the inherited template, or the one beneath an inherited custom page; the icon is `auto` by default.
export function resolveDraft(draft: StoredPage, inherited: Pick<EffectivePage, 'mode' | 'icon' | 'title' | 'description' | 'html'>, beneath?: Pick<EffectivePage, 'mode' | 'icon' | 'title' | 'description' | 'html'> | null): TemplatePage | CustomPage {
  if (draft.mode === 'custom') return draft;
  const upper = templateAbove(inherited, beneath);
  const icon = draft.icon ?? upper.icon ?? 'auto';
  const title = draft.title ?? upper.title;
  const description = draft.description ?? upper.description;
  return { mode: 'template', icon, ...(title ? { title } : {}), ...(description ? { description } : {}) };
}

export const PAGE_STATES = [
  { value: 'waking', title: 'Waking' },
  { value: 'longer', title: 'Taking longer' },
  { value: 'failed', title: 'Failed' },
  { value: 'nap', title: 'Nap window' },
] as const;
export type PageState = (typeof PAGE_STATES)[number]['value'];

// Fixed numbers for the states: a wake 60 % through its usual 30 seconds, one at 45 seconds, a capacity failure retried in two
// minutes, a nap until Monday morning.
const PREVIEWS: Record<PageState, Parameters<typeof renderPage>[0]> = {
  waking: { state: 'WAKING', pollSeconds: 3, progress: { elapsedMs: 18_000, typicalMs: 30_000 } },
  longer: { state: 'WAKING', pollSeconds: 3, progress: { elapsedMs: 45_000, typicalMs: 30_000 } },
  failed: { state: 'FAILED', pollSeconds: 3, failure: 'capacity', retryInMs: 120_000 },
  nap: { state: 'ASLEEP', pollSeconds: 3, napUntil: { local: 'Mon 08:00', timeZone: 'Europe/Paris' } },
};

// The page as the preview frame shows it. The browser's own preference would decide the colors of the page's
// prefers-color-scheme rules: the frame is told which side to take instead (a custom page's rules too).
export function previewHtml({ page, favicon, state, language, dark }: { page: TemplatePage | CustomPage; favicon?: string | null; state: PageState; language: Language; dark: boolean }): string {
  const icon = page.mode === 'template' ? (page.icon?.startsWith('data:') ? page.icon : page.icon === 'auto' ? favicon ?? null : null) : null;
  const html = renderPage({ ...PREVIEWS[state], language, page: page as PageDocument, icon });
  return html.replace(/\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/gi, (_, side: string) => (side.toLowerCase() === (dark ? 'dark' : 'light') ? '(min-width:0)' : '(min-width:100000px)'));
}

const FROM: Record<string, string> = { organization: 'Organization', router: 'Router', workload: 'This workload', default: 'Built-in' };
export const fromLine = (level: string | undefined): string => FROM[level ?? 'default'] ?? 'Built-in';

// Why a workload shows no cached favicon (a failed read keeps the last good one, so this is for the first). `shown` is the page
// the router resolves: a custom page, `none` and an upload never read the favicon, so "not read yet" would be wrong there.
export function whyNoIcon(favicon: Favicon | null | undefined, shown?: Pick<EffectivePage, 'mode' | 'icon'>): string {
  if (shown?.mode === 'custom') return 'not read: the page is a custom one';
  if (shown?.icon === 'none') return 'not read: the icon is none';
  if (shown?.icon?.startsWith('data:')) return 'not read: an uploaded image is shown';
  return favicon?.error ?? 'not read yet: it is read just before a nap, at most once a day';
}

// What a level shows of its page for someone with this role (design §11). The API checks again. `reason` is said where the
// buttons would be, only when someone who could otherwise write is stopped: a viewer is not told. A Terraform workload is
// read-only, but a page the manager wrote before it moved to Terraform (`by` set) can still be reset; one Terraform wrote can't.
export function editRights(level: PageLevel, role: Role, terraform: boolean, own: StoredPage | null, by: string | null): { edit: boolean; custom: boolean; reset: boolean; reason: string } {
  const admin = role === 'admin';
  const may = level === 'workload' ? admin || role === 'operator' : admin;
  const none = { edit: false, custom: false, reset: false, reason: '' };
  if (!may) return none;
  const mayTouch = !!own && (admin || own.mode === 'template');
  if (terraform) {
    return { ...none, reset: mayTouch && !!by, reason: "Set in this workload's Terraform: change waiting_page in its workload module and apply." };
  }
  if (!admin && own && own.mode !== 'template') {
    return { ...none, reason: "A custom page runs scripts on the application's own address, so only an administrator can change or remove it." };
  }
  return { edit: true, custom: admin, reset: !!own, reason: '' };
}

// The organization's answer as a level of its own, with nothing above it.
export function organizationView(v: OrganizationPageView): WaitingPageView {
  const effective = resolveEffective(v.page);
  return { own: v.page, inherited: resolveEffective(null), effective, from: effective.from, warnings: v.warnings, terraform: false, by: v.by, at: v.at };
}

// A single level's page as the router resolves it: the fields it has, the icon `auto` otherwise.
function resolveEffective(page: StoredPage | null): EffectivePage {
  if (!page) return { mode: 'template', icon: 'auto', from: { mode: 'default', icon: 'default' } };
  if (page.mode === 'custom') return { mode: 'custom', html: page.html, from: { mode: 'organization', html: 'organization' } };
  return {
    mode: 'template', icon: page.icon ?? 'auto', ...(page.title ? { title: page.title } : {}), ...(page.description ? { description: page.description } : {}),
    from: { mode: 'organization', icon: page.icon ? 'organization' : 'default', ...(page.title ? { title: 'organization' } : {}), ...(page.description ? { description: 'organization' } : {}) },
  };
}

// What the router warns of when a custom page is stored, said before it is sent. Linear in the page, as the router's is: the
// end of each tag is searched once, and a tag is read for at most 1000 characters.
const HOOK_STATUS = /data-dormeto\s*=\s*(?:"status"|'status'|status(?![^\s>/]))/gi;
const META = /<meta[\s/]/gi;
export function htmlWarnings(html: string): string[] {
  const out: string[] = [];
  // The attribute's name in any case, its value as the script's selector reads it: in lower case.
  if (![...html.matchAll(HOOK_STATUS)].some((m) => m[0].includes('status'))) out.push('the page has no element data-dormeto="status": the visitor will not read why it waits');
  let end = -1;
  for (const m of html.matchAll(META)) {
    if (end < m.index) end = html.indexOf('>', m.index);
    if (end < 0) break;
    if (/http-equiv\s*=\s*["']?content-security-policy/i.test(html.slice(m.index, Math.min(end, m.index + 1000)))) {
      out.push('a Content-Security-Policy meta tag may block the script Dormeto adds, and the wake with it in browser mode');
      break;
    }
  }
  return out;
}
