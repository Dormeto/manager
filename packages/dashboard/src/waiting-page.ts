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
// What GET answers for a router or a workload (the organization's answers { page, warnings, updatedAt, updatedBy }).
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
export interface OrganizationPageView { page: StoredPage | null; warnings: string[]; updatedAt: string | null; updatedBy: string | null; error?: string }

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
  if (startsWithSvg(new TextDecoder().decode(bytes.subarray(0, 4096)))) return 'svg+xml';
  return null;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// A chosen icon file: its data URI, or what is wrong with it.
export function checkIcon(bytes: Uint8Array): { uri: string } | { problem: string } {
  if (!bytes.length) return { problem: 'The file is empty.' };
  if (bytes.length > ICON_BYTES) return { problem: 'The icon must be at most 64 KiB.' };
  const type = iconTypeOf(bytes);
  if (!type) return { problem: 'The icon must be a PNG, JPEG, WebP, SVG or ICO image.' };
  return { uri: `data:image/${type};base64,${base64(bytes)}` };
}

// A chosen HTML file: its text, or what is wrong with it.
export function checkHtml(bytes: Uint8Array): { html: string } | { problem: string } {
  if (bytes.length > HTML_BYTES) return { problem: 'The page must be at most 256 KiB.' };
  let html: string;
  try {
    html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { problem: 'The page must be UTF-8 text.' };
  }
  return html.trim() ? { html } : { problem: 'The page is blank.' };
}

// The draft over what the level inherits, as the router resolves them: a template takes each field from the draft, then from
// the inherited template (a custom page above gives none); the icon is `auto` by default.
export function resolveDraft(draft: StoredPage, inherited: Pick<EffectivePage, 'mode' | 'icon' | 'title' | 'description' | 'html'>): TemplatePage | CustomPage {
  if (draft.mode === 'custom') return draft;
  const upper: Partial<EffectivePage> = inherited.mode === 'template' ? inherited : {};
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

// Why a workload shows no cached favicon (a failed read keeps the last good one, so this is for the first).
export function whyNoIcon(favicon: Favicon | null | undefined): string {
  return favicon?.error ?? 'not read yet: it is read just before a nap, at most once a day';
}

// What a level shows of its page for someone with this role (design §11). The API checks again. `reason` is said where the
// buttons would be, only when someone who could otherwise write is stopped: a viewer is not told.
export function editRights(level: PageLevel, role: Role, terraform: boolean, own: StoredPage | null): { edit: boolean; custom: boolean; reason: string } {
  const admin = role === 'admin';
  const may = level === 'workload' ? admin || role === 'operator' : admin;
  const none = (reason = '') => ({ edit: false, custom: false, reason });
  if (!may) return none();
  if (terraform) return none("Set in this workload's Terraform: change waiting_page in its workload module and apply.");
  if (!admin && own && own.mode !== 'template') return none("A custom page runs scripts on the application's own address, so only an administrator can change or remove it.");
  return { edit: true, custom: admin, reason: '' };
}

// The organization's answer as a level of its own, with nothing above it.
export function organizationView(v: OrganizationPageView): WaitingPageView {
  const effective = resolveEffective(v.page);
  return { own: v.page, inherited: resolveEffective(null), effective, from: effective.from, warnings: v.warnings, terraform: false, by: v.updatedBy, at: v.updatedAt };
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

// What the router warns of when a custom page is stored, said before it is sent.
export function htmlWarnings(html: string): string[] {
  const out: string[] = [];
  if (!/data-dormeto\s*=\s*(?:"status"|'status'|status(?![^\s>/]))/i.test(html)) out.push('the page has no element data-dormeto="status": the visitor will not read why it waits');
  if (/<meta[^>]*http-equiv\s*=\s*["']?content-security-policy/i.test(html)) out.push('a Content-Security-Policy meta tag may block the script Dormeto adds, and the wake with it in browser mode');
  return out;
}
