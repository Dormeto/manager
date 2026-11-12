// Health alarms (vision docs/specs/2026-10-08-reliability-security-design.md, R6a): every 5 minutes, the routers the
// manager knows are compared with what they report; an alarm per subject keeps its open problems, and each change that
// matters (a problem opened or raised, a subject resolved) is published to the environment's alert topic.
import { reporting, type RouterPoll, type RouterSummary } from '@dormeto/fleet';
import { cloudOf, routerTooOld, tooOldText, type Cloud } from '@dormeto/fleet/clouds';
import type { InstalledRouter } from '@dormeto/operations';
import { fleetRouters, type TerraformRouter } from './routers.js';

export type Level = 'warning' | 'error';
export interface Subject { id: string; kind: 'router' | 'list' | 'workload'; name: string; cloud?: Cloud; account?: string; region?: string; router?: string; workloadId?: string; url?: string | null }
export interface Problem { code: string; level: Level; text: string; hint?: string }
export interface OpenProblem extends Problem { since: string }
export interface Alarm {
  subject: Subject;
  level: Level | 'ok';
  since: string;
  problems: OpenProblem[];
  // Codes whose opening was sent; codes cleared lately (damping: one that comes back within 6 hours is not sent again).
  notified: string[];
  cleared: Record<string, string>;
}
export interface AlarmStore {
  list(): Promise<{ alarm: Alarm; version: number }[]>;
  // Conditional on the version read (0: absent): false when another run changed it.
  put(alarm: Alarm, version: number): Promise<boolean>;
  remove(id: string, version: number): Promise<boolean>;
}
// chat: the custom notification of Amazon Q Developer in chat applications (Slack, Microsoft Teams), sent to https
// subscriptions beside the text (R7b).
export interface ChatNotification { version: '1.0'; source: 'custom'; content: { textType: 'client-markdown'; title: string; description: string; nextSteps?: string[] } }
export interface Notification {
  subject: string;
  message: string;
  chat?: ChatNotification;
  // Message attributes, for subscription filter policies; a digest whose alarms mix the clouds names both (a String.Array,
  // which a filter policy matches by any of its elements).
  attributes: { level: Level | 'resolved' | 'info'; kind: Subject['kind'] | 'digest' | 'update'; cloud?: Cloud | Cloud[]; account?: string; region?: string; router?: string; workload?: string };
}
export interface Observation { subject: Subject; problems: Problem[] }
interface Log { info(event: string, data?: object): void; warn(event: string, data?: object): void; error(event: string, data?: object): void }

const MIN = 60_000;
const DAMP_MS = 6 * 60 * MIN;
// A workload that woke well and fails again is a new incident: damped only while it flaps within a wake cycle.
const WORKLOAD_DAMP_MS = 15 * MIN;
// A router installed this recently has not reported yet: not expected before.
const GRACE_MS = 15 * MIN;
const MAX_MESSAGES = 10;
const DIGEST_LISTED = 50;

// A problem's code: the router's own (0.24.0), or its text with the figures taken out (older routers).
export function problemCode(problem: { code?: unknown; text: string }): string {
  return typeof problem.code === 'string' && problem.code ? problem.code : `text:${problem.text.replace(/\d+(\.\d+)?/g, 'N')}`;
}

// SNS subjects: printable ASCII, 100 characters at most.
export function snsSubject(text: string): string {
  const ascii = text.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/[^\x20-\x7e]/g, '');
  return ascii.length <= 100 ? ascii : `${ascii.slice(0, 97)}...`;
}

const minutes = (ms: number) => Math.round(ms / MIN);
const time = (at: string) => `${at.slice(0, 16).replace('T', ' ')} UTC`;
const RANK = { warning: 1, error: 2 } as const;

// The health a router reported, as problems (the router's levels; anything unreadable is a problem of its own).
// A router's failed workloads (R7b): each failed wake is its own alert, from the failure index; the router's health
// keeps saying it in the dashboard.
const FAILED_WORKLOADS = new Set(['failed-workloads', problemCode({ text: '1 failed workload' }), problemCode({ text: '2 failed workloads' })]);

function reportedProblems(summary: RouterSummary): Problem[] {
  const raw = (summary.health as { problems?: unknown } | null)?.problems;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('problems is not a list');
  return raw.map((p): Problem => {
    const { level, text, code } = (p ?? {}) as { level?: unknown; text?: unknown; code?: unknown };
    if (typeof text !== 'string' || (level !== 'warning' && level !== 'error')) throw new Error('a problem without level or text');
    return { code: problemCode({ code, text }), level, text };
  }).filter((p) => !FAILED_WORKLOADS.has(p.code));
}

// What a silent router's owner checks first, per cloud.
const AWS_SILENT_HINT = 'Its idle check does not run, or its reports do not reach the manager\'s event bus: open the router in the dashboard, which calls it directly and shows why.';
const gcpSilentHint = (region: string) => `Its Cloud Run service (the controller) does not answer, or its Cloud Scheduler job dmtr-${region}-check does not run: open the router in the dashboard, which calls it directly and shows why, then read the controller's logs in Cloud Logging.`;

export function routerObservations({ terraformRouters, installed, summaries, managerAccount, now, polls = [], routerVersion }: {
  terraformRouters: TerraformRouter[]; installed: InstalledRouter[]; summaries: RouterSummary[]; managerAccount: string; now: number;
  // The Google Cloud routers' polls (RS# items), and the version the manager pins (the install command's).
  polls?: { account: string; region: string; poll: RouterPoll | null }[]; routerVersion?: string;
}): Observation[] {
  const observations: Observation[] = [];
  for (const router of fleetRouters(terraformRouters, installed, managerAccount)) {
    const account = router.account ?? managerAccount;
    const cloud = router.cloud ?? 'aws';
    const subject: Subject = { id: `router#${account}#${router.region}`, kind: 'router', name: router.name, cloud, account, region: router.region };
    const summary = summaries.find((s) => s.account === account && s.region === router.region);
    if (summary && reporting(summary, now)) {
      try {
        observations.push({ subject, problems: reportedProblems(summary) });
      } catch {
        observations.push({ subject, problems: [{ code: 'health-unreadable', level: 'warning', text: 'its health report cannot be read', hint: 'The router sent a health the manager does not understand: upgrade the router.' }] });
      }
      continue;
    }
    // A Google Cloud router the manager can't poll (older than 0.40.0, or without /v1/actions) can't report: never silent.
    if (cloud === 'gcp') {
      const poll = polls.find((p) => p.account === account && p.region === router.region)?.poll;
      const version = summary?.version || router.installed?.version || '';
      if (routerTooOld(version) || poll?.tooOld !== undefined) {
        observations.push({ subject, problems: [{ code: 'too-old', level: 'error', text: tooOldText(version || poll?.tooOld || '', account, router.region, routerVersion) }] });
        continue;
      }
    }
    if (!summary && router.installed && now - Date.parse(router.installed.at) < GRACE_MS) {
      observations.push({ subject, problems: [] });
      continue;
    }
    // A Google Cloud router the poll is refused at (the manager's access missing, a controller not found yet): that refusal,
    // with the command that fixes it (its last error, after the step), instead of silent.
    const refused = cloud === 'gcp' ? polls.find((p) => p.account === account && p.region === router.region)?.poll : null;
    if (refused?.lastRefusal && refused.lastError) {
      observations.push({ subject, problems: [{ code: refused.lastRefusal.replace(/_/g, '-'), level: 'error', text: refused.lastError.replace(/^[a-z-]+: /, ''), hint: 'The manager\'s poll of the router is refused: once the command has run, the next poll (every minute) reads it again.' }] });
      continue;
    }
    const hint = cloud === 'gcp' ? gcpSilentHint(router.region) : AWS_SILENT_HINT;
    observations.push({ subject, problems: [{ code: 'silent', level: 'error', text: summary ? `no report for ${minutes(now - Date.parse(summary.checkedAt))} minutes` : 'no report received', hint }] });
  }
  return observations;
}

// remove: a subject clear for 6 hours (nothing left to damp) leaves the table.
// The manager's IP lists (R6b), from the list function's status.json: a failed download, or no new version for twice the
// list's refresh period (an error after 7 days: the routers' copy grows old).
export interface ListStatusLine { name: string; url?: string; attemptUrl?: string; version?: string; entries?: number; refreshHours?: number; fetchedAt?: string; lastAttemptAt?: string; error?: string; errorAt?: string }
export function listObservations(status: { lists?: ListStatusLine[] } | null, now: number): Observation[] {
  const hint = 'The routers keep the last version published; the list function retries every hour (its logs: dmt-<env>-manager-ip-lists).';
  return (status?.lists ?? []).map((l) => {
    const problems: Problem[] = [];
    if (l.error) problems.push({ code: 'download', level: 'warning', text: l.version ? `last download failed: ${l.error}` : `never downloaded: ${l.error}`, hint });
    const refreshHours = l.refreshHours ?? 24;
    const age = l.fetchedAt ? now - Date.parse(l.fetchedAt) : 0;
    if (l.fetchedAt && age > 2 * refreshHours * 60 * MIN) {
      problems.push({ code: 'stale', level: age > 7 * 24 * 60 * MIN ? 'error' : 'warning', text: `no new version for ${Math.floor(age / (60 * MIN))} hours (refreshed every ${refreshHours} hours)`, hint });
    }
    return { subject: { id: `list#${l.name}`, kind: 'list' as const, name: l.name }, problems };
  });
}

// Failed wakes (R7b), from the fleet's failure index: one subject per workload whose last wake failed, one problem per
// kind (a retry failing the same way is the same problem; another kind, another alert).
export interface FailureIndexEntry {
  account: string; region: string; router: string; workloadId: string; name?: string; url?: string | null;
  failure: { kind: string; step: string; backend?: string; message: string; at: string };
  consecutiveFailures?: number; nextAttemptAt?: string;
}
const ADVICE: Record<string, string> = {
  capacity: 'AWS had no capacity for it: Dormeto retried during the wake. Fallback instance types (EC2), a mixed instances policy or several subnets (Auto Scaling), or capacity providers (ECS) let it start elsewhere.',
  quota: 'An AWS quota of the account and region was reached: raise it in Service Quotas.',
  permission: "A permission refused it: the router's role or DmtRouterBoundary (apply the access module of the manager's release again), or the key policy of an encrypted volume or snapshot.",
  configuration: 'Its configuration refused it: the launch template, image, subnet or task definition named in the message.',
  unhealthy: "Its backends started but no target became healthy: the target group's health check and the application's logs.",
  throttled: 'ELB throttled the rule switch: too many rule changes at once in this account and region.',
  timeout: 'The start took longer than the wake timeout (wake_timeout_seconds), or the wake stopped.',
  unknown: "Dormeto does not know this error: the router's logs (WakeFailed) have it whole.",
};
// A Google Cloud workload's (its router dmtr-<region> of the project, a Cloud Run service): the same kinds, Google Cloud's causes.
const gcpAdvice = (kind: string, project: string, region: string): string => ({
  capacity: 'Compute Engine had no capacity for it in its zone: Dormeto retried during the wake. Fallback machine types (its VMs\'), or a regional managed instance group (several zones), let it start elsewhere.',
  quota: 'A Compute Engine quota of the project and region was reached (its CPUs, or a machine family\'s): raise it on the Quotas page of the Google Cloud console.',
  permission: `A permission refused it: the router's service account dmtr-${region} (dormeto gcp routers show --project ${project} --region ${region} compares its grants with its install record; dormeto gcp routers install again restores them), or a VM, group or Cloud SQL instance without the tag dormeto=managed.`,
  configuration: 'Its configuration refused it: the VM, instance group, GKE workload or Cloud SQL instance named in the message.',
  unhealthy: "Its backends started but the backend service's health check found none healthy: the health check and the application's logs.",
  throttled: 'Google Cloud throttled the switch: the URL map kept changing, or too many requests at once in this project.',
  timeout: 'The start took longer than the wake timeout (the wakeTimeoutSeconds setting), or the wake stopped.',
  cluster: "The GKE cluster's API did not answer or failed: the cluster's state in the Google Cloud console, then the router's logs (WakeFailed).",
}[kind] ?? "Dormeto does not know this error: the router's logs in Cloud Logging (WakeFailed) have it whole.");
export function workloadObservations(entries: FailureIndexEntry[], now = Date.now()): Observation[] {
  return entries.map((e) => {
    const cloud = cloudOf(e.account) ?? 'aws';
    const n = e.consecutiveFailures ?? 1;
    const inARow = `${n} failure${n === 1 ? '' : 's'} in a row`;
    const next = !e.nextAttemptAt ? 'A request retries it.'
      : Date.parse(e.nextAttemptAt) > now ? `A request retries it, next attempt after ${time(e.nextAttemptAt)} (${inARow}).`
        : `The next request retries it (${inARow}).`;
    const hint = [`${e.failure.backend ? `Backend: ${e.failure.backend}. ` : ''}${next}`,
      cloud === 'gcp' ? gcpAdvice(e.failure.kind, e.account, e.region) : ADVICE[e.failure.kind] ?? ADVICE.unknown,
      cloud === 'gcp' ? 'If its backends keep running without passing the health check, Dormeto stops them after its idle window.'
        : 'If its backends keep running without a healthy target, Dormeto stops them after its idle window.'].join('\n  ');
    return {
      subject: { id: `workload#${e.account}#${e.region}#${e.workloadId}`, kind: 'workload' as const, name: e.name ?? e.workloadId, cloud, account: e.account, region: e.region, router: e.router, workloadId: e.workloadId, url: e.url ?? null },
      problems: [{ code: `${e.failure.step === 'nap' ? 'nap' : 'wake'}-failed:${e.failure.kind}`, level: 'error' as const, text: `${e.failure.step === 'nap' ? 'nap' : 'wake'} failed: ${e.failure.message}`, hint }],
    };
  });
}

interface Change { alarm: Alarm; version: number; opened: OpenProblem[]; raised: OpenProblem[]; resolved: boolean; remove: boolean }

// The next state of one subject's alarm, and what changed; null when nothing is to be written.
export function evaluate(observation: Observation, previous: Alarm | null, version: number, now: number): Change | null {
  const at = new Date(now).toISOString();
  const byCode = new Map<string, Problem>();
  for (const p of observation.problems) {
    const known = byCode.get(p.code);
    if (!known || RANK[p.level] > RANK[known.level]) byCode.set(p.code, p);
  }
  const before = new Map((previous?.problems ?? []).map((p) => [p.code, p]));
  const problems: OpenProblem[] = [...byCode.values()].map((p) => ({ ...p, since: before.get(p.code)?.since ?? at }))
    .sort((a, b) => RANK[b.level] - RANK[a.level]);
  const damp = observation.subject.kind === 'workload' ? WORKLOAD_DAMP_MS : DAMP_MS;
  const cleared = Object.fromEntries(Object.entries(previous?.cleared ?? {}).filter(([, t]) => now - Date.parse(t) < damp));
  for (const code of before.keys()) if (!byCode.has(code)) cleared[code] = at;
  const notified = (previous?.notified ?? []).filter((code) => byCode.has(code));
  const opened = problems.filter((p) => !notified.includes(p.code) && !cleared[p.code]);
  const raised = problems.filter((p) => notified.includes(p.code) && before.get(p.code)?.level === 'warning' && p.level === 'error');
  const resolved = !problems.length && (previous?.notified.length ?? 0) > 0;
  const level = problems.length ? problems[0]!.level : 'ok';
  const alarm: Alarm = {
    subject: observation.subject, level,
    since: problems.length ? (previous && previous.level !== 'ok' ? previous.since : at) : (previous?.since ?? at),
    problems, notified: [...notified, ...opened.map((p) => p.code)], cleared,
  };
  if (!previous && !problems.length) return null;
  if (previous && JSON.stringify(previous) === JSON.stringify(alarm)) return null;
  const remove = !problems.length && !resolved && !Object.keys(cleared).length;
  return { alarm, version, opened, raised, resolved, remove };
}


// The chat body of a message (Amazon Q Developer custom notification).
export const chatNotification = (title: string, description: string, nextSteps: string[] = []): ChatNotification => ({
  version: '1.0', source: 'custom', content: { textType: 'client-markdown', title, description, ...(nextSteps.length ? { nextSteps } : {}) },
});
function render(change: Change, dashboardUrl: string, env: string, at: string): Notification | null {
  const { alarm, opened, raised, resolved } = change;
  const s = alarm.subject;
  const where = s.kind === 'list' ? `IP list ${s.name}` : `${s.name} (${s.account} ${s.region})`;
  const link = s.kind === 'workload' ? `${dashboardUrl}/workloads/${s.router}/${s.workloadId}` : `${dashboardUrl}/routers${s.kind === 'list' ? '#ip-lists' : ''}`;
  // A subject without a cloud (an IP list) is the manager's own, which runs on AWS.
  const attributes = {
    kind: s.kind, cloud: s.cloud ?? ('aws' as Cloud),
    ...(s.account ? { account: s.account } : {}), ...(s.region ? { region: s.region } : {}),
    ...(s.kind === 'router' ? { router: s.name } : s.router ? { router: s.router } : {}),
    ...(s.workloadId ? { workload: s.workloadId } : {}),
  };
  const line = (p: OpenProblem) => `- [${p.level}] ${p.text} (since ${time(p.since)})${p.hint ? `\n  ${p.hint}` : ''}`;
  if (resolved) {
    const subject = snsSubject(`[Dormeto ${env}] ${where}: ${s.kind === 'workload' ? 'woke again' : 'resolved'}`);
    const text = s.kind === 'workload' ? `${where} woke again (no failure since ${time(at)}).` : `${where}: every problem cleared at ${time(at)}.`;
    return { subject, message: `${text}\n\nOpen the dashboard: ${link}\n`, chat: chatNotification(subject, `${text} [Open the dashboard](${link})`), attributes: { level: 'resolved', ...attributes } };
  }
  const news = [...raised, ...opened];
  if (!news.length) return null;
  const others = alarm.problems.filter((p) => !news.includes(p));
  const message = [
    `${where}: ${alarm.level}`, ...(s.kind === 'workload' && s.url ? [`Application: ${s.url}`] : []), '',
    'New:', ...news.map(line),
    ...(others.length ? ['', 'Still open:', ...others.map(line)] : []),
    '', `Open the dashboard: ${link}`, '',
  ].join('\n');
  const subject = snsSubject(`[Dormeto ${env}] ${where}: ${news[0]!.text}`);
  const description = [...news, ...others].map((p) => `*${p.level}* ${p.text}`).join('\n') + `\n[Open the dashboard](${link})`;
  const nextSteps = news.flatMap((p) => (p.hint ? p.hint.split('\n').map((x) => x.trim()).filter(Boolean) : []));
  return { subject, message, chat: chatNotification(subject, description, nextSteps), attributes: { level: news.some((p) => p.level === 'error') ? 'error' : 'warning', ...attributes } };
}

export function createWatchdog({ env, managerAccount, dashboardUrl, terraformRouters, fleet, registry, alarms, notify, now = Date.now, log, extraObservations, routerVersion }: {
  env: string;
  // The router version the manager pins: the install command's --version for a Google Cloud router too old to report.
  routerVersion?: string;
  managerAccount: string;
  dashboardUrl: string;
  terraformRouters: TerraformRouter[];
  fleet: { listRouters(): Promise<RouterSummary[]>; routerPolls?(): Promise<{ account: string; region: string; poll: RouterPoll | null }[]> };
  registry: { listRouters(): Promise<InstalledRouter[]> };
  alarms: AlarmStore;
  notify: { publish(n: Notification): Promise<void> };
  now?: () => number;
  log: Log;
  // Subjects other than routers (the IP lists, R6b).
  extraObservations?: () => Promise<Observation[]>;
}) {
  return {
    async run() {
      const t = now();
      const [summaries, installed, existing, polls] = await Promise.all([fleet.listRouters(), registry.listRouters(), alarms.list(), fleet.routerPolls?.() ?? []]);
      // Subjects other than routers that could not be read keep their alarms as they are (never resolved nor removed).
      let extra: Observation[] = [];
      let extraUnread: string | null = null;
      if (extraObservations) {
        try {
          extra = await extraObservations();
        } catch (err) {
          extraUnread = (err as Error).message;
          log.error('SubjectsUnreadable', { error: extraUnread });
        }
      }
      // A workload's router as the dashboard names it (one router per account and region; the index has its own name).
      const named = fleetRouters(terraformRouters, installed, managerAccount);
      const routerName = (account?: string, region?: string) => named.find((r) => (r.account ?? managerAccount) === account && r.region === region)?.name;
      const observations = [
        ...routerObservations({ terraformRouters, installed: installed.filter((r) => !r.uninstalling), summaries, managerAccount, now: t, polls, routerVersion }),
        ...extra.map((o) => (o.subject.kind === 'workload' ? { ...o, subject: { ...o.subject, router: routerName(o.subject.account, o.subject.region) ?? o.subject.router } } : o)),
      ];
      const known = new Map(existing.map((x) => [x.alarm.subject.id, x]));
      const changes: Change[] = [];
      for (const o of observations) {
        const prev = known.get(o.subject.id);
        known.delete(o.subject.id);
        const change = evaluate(o, prev?.alarm ?? null, prev?.version ?? 0, t);
        if (change) changes.push(change);
      }
      // Subjects no longer known (a router uninstalled, a list removed): their alarms leave without a message.
      for (const { alarm, version } of known.values()) {
        if (extraUnread !== null && alarm.subject.kind !== 'router') continue;
        // A workload out of the failure index woke successfully: resolved, with its message (R7b).
        if (alarm.subject.kind === 'workload') {
          const change = evaluate({ subject: alarm.subject, problems: [] }, alarm, version, t);
          if (change) changes.push(change);
          continue;
        }
        await alarms.remove(alarm.subject.id, version);
      }

      // Errors first, then warnings, then resolutions: the first 10 are sent one by one, the rest in a digest.
      const rank = (c: Change) => (c.resolved ? 0 : c.alarm.level === 'error' ? 2 : 1);
      const at = new Date(t).toISOString();
      const messages = changes.map((change) => ({ change, note: render(change, dashboardUrl, env, at) })).sort((a, b) => rank(b.change) - rank(a.change));
      const loud = messages.filter((m) => m.note);
      const quiet = messages.filter((m) => !m.note);
      const single = loud.slice(0, MAX_MESSAGES);
      const digested = loud.slice(MAX_MESSAGES);
      const write = async ({ alarm, version, remove }: Change) => {
        const ok = remove ? await alarms.remove(alarm.subject.id, version) : await alarms.put(alarm, version);
        if (!ok) log.warn('AlarmChangedMeanwhile', { subject: alarm.subject.id });
      };
      const unsent: string[] = [];
      for (const { change, note } of single) {
        try {
          await notify.publish(note!);
        } catch (err) {
          // Not written: the next run finds the same change and sends it again.
          log.error('AlertNotSent', { subject: change.alarm.subject.id, error: (err as Error).message });
          unsent.push((err as Error).message);
          continue;
        }
        await write(change);
      }
      if (digested.length) {
        const listed = digested.slice(0, DIGEST_LISTED).map(({ change, note }) => `- ${note!.subject.replace(`[Dormeto ${env}] `, '')}${change.resolved ? '' : ` (${change.alarm.level})`}`);
        const message = [
          `${digested.length} more alarms changed in this check:`, '', ...listed,
          ...(digested.length > DIGEST_LISTED ? [`- and ${digested.length - DIGEST_LISTED} more`] : []),
          '', `Open the dashboard: ${dashboardUrl}/`, '',
        ].join('\n');
        try {
          const subject = snsSubject(`[Dormeto ${env}] ${digested.length} more alarms changed`);
          const chat = chatNotification(subject, [`${digested.length} more alarms changed in this check:`, ...listed,
            ...(digested.length > DIGEST_LISTED ? [`- and ${digested.length - DIGEST_LISTED} more`] : []), `[Open the dashboard](${dashboardUrl}/)`].join('\n'));
          // The cloud every alarm of the digest is of, or both when they mix (a filter on either cloud receives it).
          const clouds = [...new Set(digested.flatMap((d) => d.note!.attributes.cloud ?? []))].sort();
          const cloud = clouds.length === 1 ? clouds[0] : clouds.length ? clouds : undefined;
          await notify.publish({ subject, message, chat, attributes: { level: digested.some((d) => d.change.alarm.level === 'error') ? 'error' : 'warning', kind: 'digest', ...(cloud ? { cloud } : {}) } });
          for (const { change } of digested) await write(change);
        } catch (err) {
          log.error('AlertNotSent', { subject: 'digest', count: digested.length, error: (err as Error).message });
          unsent.push((err as Error).message);
        }
      }
      // Changes that send nothing (a text that changed, a damped code, a clearing): written as they are.
      for (const { change } of quiet) await write(change);
      log.info('WatchdogRan', { subjects: observations.length, changes: changes.length, sent: single.length + (digested.length ? 1 : 0) - unsent.length, open: changes.filter((c) => c.alarm.level !== 'ok').length });
      // A path to the topic that fails is an error of the run: the watchdog-errors alarm (CloudWatch's own path) says it.
      if (unsent.length) throw new Error(`${unsent.length} alert${unsent.length === 1 ? '' : 's'} not sent: ${[...new Set(unsent)].join('; ')}`);
      // The lists' status unread: the routers are done, and the run fails so that the watchdog's errors alarm says it.
      if (extraUnread !== null) throw new Error(`subjects unreadable: ${extraUnread}`);
    },
  };
}

// The SNS Publish input of a notification (R7b): the text for email (and default), the chat body for https subscriptions
// (Amazon Q Developer in chat applications), the attributes for subscription filter policies: a list as a String.Array.
export function snsInput(n: Notification, topicArn: string) {
  const bodies = { default: n.message, email: n.message, ...(n.chat ? { https: JSON.stringify(n.chat) } : {}) };
  const attribute = (v: unknown) => (typeof v === 'string' && v ? { DataType: 'String', StringValue: v }
    : Array.isArray(v) && v.length ? { DataType: 'String.Array', StringValue: JSON.stringify(v) } : null);
  return {
    TopicArn: topicArn, Subject: n.subject, Message: JSON.stringify(bodies), MessageStructure: 'json',
    MessageAttributes: Object.fromEntries(Object.entries(n.attributes).flatMap(([k, v]) => { const a = attribute(v); return a ? [[k, a]] : []; })),
  };
}
