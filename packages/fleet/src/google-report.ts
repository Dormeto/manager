// The reports of the Google Cloud routers (router push design 2026-11-14 §3, §6.2). A Google Cloud router holds no AWS
// credential: it sends its events to the manager's API, which proves its project and region from its Google-signed token and
// puts each one on the bus as `dormeto.router.gcp`, `{account: <project>, region, detail: <the router's>}`. EventBridge sets
// the envelope's account to the caller's: the fleet function reads that source only from the manager's own account (the bus
// policy admits other accounts for `dormeto.router` alone), and then trusts the wrapper's project and region, never the
// detail's. Each event is ingested as the poll ingested the same router's journal and check (googleEvent, which both use).
// A check whose router holds another ETag than settings.json's gets the organization's settings pushed (`manager-settings`,
// with where to report), once a check: on its first chunk.
import type { Google, GoogleConnection } from '@dormeto/google';
import { chunkOf } from './clean.js';
import { isProject, isRegion } from './clouds.js';
import type { RouterEvent } from './ingest.js';
import type { Registry } from './registry.js';
import { actOnRouter, GOOGLE_CALL_MS } from './router-call.js';
import { settingsDocument, type SettingsJson } from './settings-json.js';

export const RELAY_SOURCE = 'dormeto.router.gcp';
// The detail types the relay puts on the bus (its route refuses any other).
export const RELAYED = new Set(['Router checked', 'Workload state changed']);

type Json = Record<string, any>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

// Where a Google Cloud router reports (`manager-settings`' `events`): the relay's URL, and the audience of its token.
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

// The relay's entry as EventBridge hands it to the queue.
export interface RelayedEvent {
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
  return async function push(account: string, region: string, held: string | null): Promise<void> {
    try {
      const current = await settings.etag();
      if (!current || current === held) return;
      const router = await registry.get(account, region);
      if (!router || router.cloud !== 'gcp') {
        log?.warn('ManagerSettingsNotPushed', { account, region, error: 'the router is not registered' });
        return;
      }
      const doc = await settingsDocument(settings);
      if (!doc) return;
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

// The fleet function's reading of the relay's events. An event refused is dropped with a log line, never retried: the same
// event would be refused again.
export function createGoogleReports({ ownAccount, ingest, push, log }: {
  ownAccount: string | undefined;
  ingest: (event: RouterEvent) => Promise<unknown>;
  push: (account: string, region: string, held: string | null) => Promise<void>;
  log?: Log;
}) {
  const refuse = (event: RelayedEvent, reason: string): void => {
    log?.warn('RouterEventRefused', { account: event.account, source: event.source, detailType: event['detail-type'], reason });
  };
  return async function report(event: RelayedEvent): Promise<void> {
    if (!ownAccount || event.account !== ownAccount) return refuse(event, 'the relay\'s events come from the manager\'s own account only');
    const wrapper = isObject(event.detail) ? event.detail : {};
    if (!isProject(wrapper.account) || !isRegion('gcp', wrapper.region)) return refuse(event, 'the wrapper names no Google Cloud project and region');
    const detailType = event['detail-type'];
    if (!RELAYED.has(detailType) || !isObject(wrapper.detail)) return refuse(event, 'not a detail type the relay sends');
    const detail = wrapper.detail;
    await ingest(googleEvent({ account: wrapper.account, region: wrapper.region }, detailType, detail));
    if (detailType === 'Router checked' && chunkOf(detail.chunk)?.index === 0) {
      const held = typeof detail.managerSettings?.etag === 'string' && detail.managerSettings.etag ? detail.managerSettings.etag as string : null;
      await push(wrapper.account, wrapper.region, held);
    }
  };
}

// The queue's records by their source: the relay's to its reading, any other (an AWS router's, `dormeto.router`) to the
// ingest, as before.
export const bySource = ({ ingest, reports }: { ingest: (event: RouterEvent) => Promise<unknown>; reports: (event: RelayedEvent) => Promise<unknown> }) =>
  (event: RouterEvent & { source?: string }) => (event.source === RELAY_SOURCE ? reports(event) : ingest(event));
