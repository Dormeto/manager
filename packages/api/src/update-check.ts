// The manager's daily update check (vision docs/specs/2026-10-18-daily-update-check-design.md): off, it reads one table
// item; on, it reads the release index, records the newest version above the running one and, when chosen, sends it once
// to the alert topic. The next day retries an unreadable index or topic.
import type { UpdateCheck, UpdateResult } from '@dormeto/fleet';
import { compareVersions, readIndex, VERSION } from './update.js';
import { chatNotification, snsSubject, type Notification } from './watchdog.js';

const CHANGELOG = 'https://github.com/Dormeto/manager/blob/main/CHANGELOG.md';

export interface UpdateCheckStore {
  getUpdateCheck(): Promise<UpdateCheck>;
  getUpdateResult(): Promise<UpdateResult | null>;
  putUpdateResult(result: UpdateResult): Promise<void>;
}

function notification(env: string, running: string, latest: string, dashboardUrl: string): Notification {
  const subject = snsSubject(`[Dormeto ${env}] Manager ${latest} is available`);
  const link = `${dashboardUrl}/update`;
  const text = `Manager ${latest} is available; this one runs ${running}.`;
  return {
    subject,
    message: `${text}\n\nRelease notes: ${CHANGELOG}\nUpdate it from the dashboard: ${link}\n`,
    chat: chatNotification(subject, `${text} [Release notes](${CHANGELOG}) · [Update it](${link})`),
    attributes: { level: 'info', kind: 'update' },
  };
}

// The result recorded, or null when the check is off.
export async function runUpdateCheck({ store, fetchText, publish, now, running, releasesUrl, env, dashboardUrl }: {
  store: UpdateCheckStore;
  fetchText: (url: string) => Promise<string | null>;
  publish: (notification: Notification) => Promise<void>;
  now: () => Date;
  running: string;
  releasesUrl: string;
  env: string;
  dashboardUrl: string;
}): Promise<UpdateResult | null> {
  const check = await store.getUpdateCheck();
  if (!check.enabled) return null;
  const notified = (await store.getUpdateResult())?.notified;
  const base = { checkedAt: now().toISOString(), running };
  const kept = notified ? { notified } : {};

  const index = VERSION.test(running) ? await readIndex(releasesUrl, fetchText) : null;
  if (!index) {
    const result: UpdateResult = { ...base, latest: null, error: VERSION.test(running) ? 'the release index could not be read' : `the running version is not a version: ${running}`, ...kept };
    await store.putUpdateResult(result);
    return result;
  }
  const latest = index.map((e) => e.version).filter((v) => VERSION.test(v) && compareVersions(v, running) > 0).sort((a, b) => compareVersions(b, a))[0] ?? null;

  // Newer than the last version sent: a version withdrawn from the index does not send an older one again.
  if (check.alert && latest && (!notified || compareVersions(latest, notified) > 0)) {
    try {
      await publish(notification(env, running, latest, dashboardUrl));
    } catch (err) {
      await store.putUpdateResult({ ...base, latest, error: `the alert could not be sent: ${(err as Error).message}`, ...kept });
      throw err;
    }
    // A write of the result failing after the publish sends the version again the next day: at-least-once, accepted.
    const result: UpdateResult = { ...base, latest, notified: latest };
    await store.putUpdateResult(result);
    return result;
  }
  const result: UpdateResult = { ...base, latest, ...kept };
  await store.putUpdateResult(result);
  return result;
}
