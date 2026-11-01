// Types for page.mjs, the copy of the router's renderer (never edited here: test/waiting-page-copy.test.ts holds it to the router's).
export const PAGE_CSP: string;
export type Language = 'en' | 'fr';
export interface PageDocument { mode: 'template' | 'custom'; title?: string; description?: string; html?: string }
export interface RenderOptions {
  state: string;
  pollSeconds: number;
  failure?: string;
  retryInMs?: number;
  napUntil?: { at?: string; local: string; timeZone: string };
  probeUrl?: string;
  cloud?: string;
  language?: Language;
  page?: PageDocument | null;
  icon?: string | null;
  progress?: { elapsedMs: number; typicalMs: number | null } | null;
}
export function languageOf(acceptLanguage: string | undefined | null): Language;
export function failureMessage(failure: string | undefined, retryInMs?: number, cloud?: string, language?: Language): string;
export function napMessage(napUntil: { local: string; timeZone: string }, language?: Language): string;
export function renderPage(options: RenderOptions): string;
