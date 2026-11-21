// The reports of the Google Cloud routers (router credentials design 2026-11-15 §4; router push design 2026-11-14 §6.2). A
// Google Cloud router asks the manager's API for credentials once an hour (its Google-signed token proves its project and
// region) and puts its events on the manager's bus itself, as `dormeto.router.gcp/<project>/<region>`, its detail its own:
// its session allows that source alone. EventBridge sets the envelope's account to the caller's, the manager's for such a
// session: the fleet function reads that source only from the manager's own account (the bus policy admits other accounts
// for `dormeto.router` alone), takes the project and region from the source, never from the detail, and only for a router
// registered (a removed router's session lasts up to an hour). Each event is ingested as an AWS router's (googleEvent).
// A check whose router holds another ETag than settings.json's gets the organization's settings pushed (`manager-settings`,
// with where to report), once a check: on its first chunk.
import type { Google, GoogleConnection } from '@dormeto/google';
import { chunkOf } from './clean.js';
import { GOOGLE_SOURCE_PREFIX, googleSourceOf, googleSourceParts } from './clouds.js';
import type { RouterEvent } from './ingest.js';
import type { Registry } from './registry.js';
import { actOnRouter, GOOGLE_CALL_MS } from './router-call.js';
import { settingsDocument, type SettingsJson } from './settings-json.js';

export { GOOGLE_SOURCE_PREFIX, googleSourceOf, googleSourceParts };
// The detail types a Google Cloud router puts on the bus (an AWS router's two).
export const REPORTED = new Set(['Router checked', 'Workload state changed']);

type Json = Record<string, any>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

// Where a Google Cloud router reports (`manager-settings`' `events`): the credentials route's URL, and the audience of its token.
export interface ReportTarget { url: string; audience: string }

// A Google Cloud router's event as an AWS router's: under its project and region, named as its registration names it (the
// router calls itself dmtr-<region>, one per project and region). A journal entry loses its id; a check's router block is
// named and placed there. What the detail says of its project, region or router is never read.
export function googleEvent(router: { account: string; region: string; name?: string }, detailType: string, detail: Json): RouterEvent {
  const { account, region } = router;
  const name = router.name || `dmtr-${region}`;
  if (detailType === 'Router checked') {
    const block = isObject(detail.router) ? detail.router : {};
    return { account, region, 'detail-type': detailType, detail: { ...detail, router: { ...block, name, region } } };
  }
  const { id: _id, ...rest } = detail;
  return { account, region, 'detail-type': detailType, detail: { ...rest, router: name, region } };
}

// A Google Cloud router's entry as EventBridge hands it to the queue.
export interface ReportedEvent {
  source?: string;
  account: string;
  region: string;
  'detail-type': string;
  detail: any;
}

type Log = { info(event: string, data: object): void; warn(event: string, data: object): void };

// The organization's settings pushed to a Google Cloud router whose check said it holds `held`, when settings.json's ETag
// is another (none written: nothing to push). Never thrown: a push that fails is logged, and the router's next check (5
// minutes at most) says its ETag again.
export function createSettingsPush({ settings, registry, google, events, env = 'dev', routerVersion, log }: {
  settings: SettingsJson;
  registry: Pick<Registry, 'get'>;
  google: { current(): Promise<{ connection: GoogleConnection; google: Pick<Google, 'request'> } | null> };
  events?: ReportTarget | undefined;
  env?: string;
  routerVersion?: string | undefined;
  log?: Log;
}) {
  // `reported`: the version the router's report carries (final review, minor 5), the registry's when it carries none.
  return async function push(account: string, region: string, held: string | null, reported?: string | null): Promise<void> {
    try {
      const current = await settings.etag();
      if (!current || current === held) return;
      const router = await registry.get(account, region);
      if (!router || router.cloud !== 'gcp') {
        log?.warn('ManagerSettingsNotPushed', { account, region, error: 'the router is not registered' });
        return;
      }
      const doc = await settingsDocument(settings, { version: reported ?? router.version ?? null });
      // Held already: the whole document, or the one without the idle signals this version gets.
      if (!doc || doc.etag === held) return;
      const answer = await actOnRouter(await google.current(), router, {
        action: 'manager-settings', settings: doc.settings, etag: doc.etag, ...(events ? { events } : {}),
      }, { timeoutMs: GOOGLE_CALL_MS, env, routerVersion }) as Json | null;
      if (answer?.refused) {
        log?.warn('ManagerSettingsNotPushed', { router: router.name, account, region, error: String(answer.refused.message ?? answer.refused.code ?? 'refused') });
        return;
      }
      log?.info('ManagerSettingsPushed', { router: router.name, account, region, etag: doc.etag });
    } catch (err) {
      log?.warn('ManagerSettingsNotPushed', { account, region, error: (err as Error).message });
    }
  };
}

// The fleet function's reading of the Google Cloud routers' events. An event refused is dropped with a log line, never
// retried: the same event would be refused again.
export function createGoogleReports({ ownAccount, registry, ingest, push, log }: {
  ownAccount: string | undefined;
  registry: Pick<Registry, 'get'>;
  ingest: (event: RouterEvent) => Promise<unknown>;
  push: (account: string, region: string, held: string | null, reported?: string | null) => Promise<void>;
  log?: Log;
}) {
  const refuse = (event: ReportedEvent, reason: string): void => {
    log?.warn('RouterEventRefused', { account: event.account, source: event.source, detailType: event['detail-type'], reason });
  };
  return async function report(event: ReportedEvent): Promise<void> {
    if (!ownAccount || event.account !== ownAccount) return refuse(event, 'a Google Cloud router\'s events come from the manager\'s own account only');
    const from = googleSourceParts(event.source);
    if (!from) return refuse(event, 'the source is not dormeto.router.gcp/<project>/<region>');
    const detailType = event['detail-type'];
    if (!REPORTED.has(detailType) || !isObject(event.detail)) return refuse(event, 'not a detail type a router sends');
    const { project, region } = from;
    const router = await registry.get(project, region);
    if (!router || router.cloud !== 'gcp') return refuse(event, `router ${project}/${region} is not registered with this manager`);
    const detail = event.detail;
    await ingest(googleEvent({ account: project, region, name: router.name }, detailType, detail));
    if (detailType === 'Router checked' && chunkOf(detail.chunk)?.index === 0) {
      const held = typeof detail.managerSettings?.etag === 'string' && detail.managerSettings.etag ? detail.managerSettings.etag as string : null;
      const version = isObject(detail.router) && typeof detail.router.version === 'string' && detail.router.version ? detail.router.version : null;
      await push(project, region, held, version);
    }
  };
}

// The queue's records by their source: a Google Cloud router's (any source named `dormeto.router.gcp…`, read or refused there)
// to its reading, any other (an AWS router's, `dormeto.router`) to the ingest, as before.
const GOOGLE_SOURCES = GOOGLE_SOURCE_PREFIX.slice(0, -1);
export const bySource = ({ ingest, reports }: { ingest: (event: RouterEvent) => Promise<unknown>; reports: (event: ReportedEvent) => Promise<unknown> }) =>
  (event: RouterEvent & { source?: string }) => (event.source?.startsWith(GOOGLE_SOURCES) ? reports(event) : ingest(event));
