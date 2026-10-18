// The daily update check (design 2026-10-18-daily-update-check-design.md): off does nothing; a newer version is recorded and,
// when chosen, sent once to the alert topic.
import { describe, expect, it } from 'vitest';
import { createFleetStore, type UpdateCheck, type UpdateResult } from '@dormeto/fleet';
import { fakeDynamo } from '../../discovery/test/dynamo-fake.js';
import { runUpdateCheck } from '../src/update-check.js';
import type { Notification } from '../src/watchdog.js';

const NOW = Date.parse('2026-10-18T07:00:00.000Z');
const RELEASES = 'https://releases.example/manager';

function setup({ check, result, files = {}, running = '0.13.0' }: { check?: Partial<UpdateCheck>; result?: UpdateResult; files?: Record<string, string>; running?: string } = {}) {
  const store = createFleetStore({ dynamo: fakeDynamo(), table: 'dmt-dev-manager', now: () => NOW });
  const fetched: string[] = [];
  const sent: Notification[] = [];
  const ready = (async () => {
    if (check) await store.putUpdateCheck({ enabled: false, alert: false, ...check, updatedBy: 'admin@example.com' });
    if (result) await store.putUpdateResult(result);
  })();
  const run = async () => {
    await ready;
    return runUpdateCheck({
      store, running, releasesUrl: RELEASES, env: 'dev', dashboardUrl: 'https://dash.example', now: () => new Date(NOW),
      fetchText: async (url) => { fetched.push(url); return files[url.slice(RELEASES.length + 1)] ?? null; },
      publish: async (n) => { sent.push(n); },
    });
  };
  return { store, run, fetched, sent };
}
const versions = (...v: string[]) => ({ 'versions.json': JSON.stringify({ versions: v.map((version) => ({ version, router: null, minCli: null, published: null })) }) });

describe('runUpdateCheck', () => {
  it('does nothing when off: no fetch, no result', async () => {
    const s = setup({ files: versions('0.14.0') });
    expect(await s.run()).toBeNull();
    expect([s.fetched, s.sent, await s.store.getUpdateResult()]).toEqual([[], [], null]);
  });

  it('records a newer version and sends one message with the subject, attributes and links', async () => {
    const s = setup({ check: { enabled: true, alert: true }, files: versions('0.12.0', '0.14.0', '0.13.1') });
    expect(await s.run()).toEqual({ checkedAt: '2026-10-18T07:00:00.000Z', running: '0.13.0', latest: '0.14.0', notified: '0.14.0' });
    expect(await s.store.getUpdateResult()).toMatchObject({ latest: '0.14.0', notified: '0.14.0' });
    expect(s.sent).toHaveLength(1);
    const n = s.sent[0]!;
    expect(n.subject).toBe('[Dormeto dev] Manager 0.14.0 is available');
    expect(n.attributes).toEqual({ level: 'info', kind: 'update' });
    for (const text of [n.message, n.chat!.content.description]) {
      expect(text).toContain('0.13.0');
      expect(text).toContain('https://github.com/Dormeto/manager/blob/main/CHANGELOG.md');
      expect(text).toContain('https://dash.example/update');
    }
  });

  it('does not send a version again, nor an older one after the newer was withdrawn', async () => {
    const result = { checkedAt: '2026-10-17T07:00:00.000Z', running: '0.13.0', latest: '0.14.0', notified: '0.14.0' };
    const again = setup({ check: { enabled: true, alert: true }, result, files: versions('0.14.0') });
    expect((await again.run())!.notified).toBe('0.14.0');
    const withdrawn = setup({ check: { enabled: true, alert: true }, result, files: versions('0.13.1') });
    expect(await withdrawn.run()).toMatchObject({ latest: '0.13.1', notified: '0.14.0' });
    expect([again.sent, withdrawn.sent]).toEqual([[], []]);
  });

  it('sends the next newer version once more', async () => {
    const result = { checkedAt: '2026-10-17T07:00:00.000Z', running: '0.13.0', latest: '0.14.0', notified: '0.14.0' };
    const s = setup({ check: { enabled: true, alert: true }, result, files: versions('0.14.0', '0.15.0') });
    expect((await s.run())!.notified).toBe('0.15.0');
    expect(s.sent).toHaveLength(1);
  });

  it('records a newer version without a message when the alert is off, leaving notified unchanged', async () => {
    const result = { checkedAt: '2026-10-17T07:00:00.000Z', running: '0.13.0', latest: null, notified: '0.12.5' };
    const s = setup({ check: { enabled: true, alert: false }, result, files: versions('0.14.0') });
    expect(await s.run()).toEqual({ checkedAt: '2026-10-18T07:00:00.000Z', running: '0.13.0', latest: '0.14.0', notified: '0.12.5' });
    expect(s.sent).toEqual([]);
  });

  it('records up to date as no latest', async () => {
    const s = setup({ check: { enabled: true, alert: true }, files: versions('0.12.0', '0.13.0') });
    expect(await s.run()).toEqual({ checkedAt: '2026-10-18T07:00:00.000Z', running: '0.13.0', latest: null });
    expect(s.sent).toEqual([]);
  });

  it('records an unreadable index as an error, sends nothing and keeps notified', async () => {
    const result = { checkedAt: '2026-10-17T07:00:00.000Z', running: '0.13.0', latest: '0.14.0', notified: '0.14.0' };
    const s = setup({ check: { enabled: true, alert: true }, result });
    expect(await s.run()).toMatchObject({ latest: null, notified: '0.14.0', error: expect.stringContaining('release index') });
    expect(s.sent).toEqual([]);
  });

  it('falls back to latest.json', async () => {
    const s = setup({ check: { enabled: true, alert: true }, files: { 'latest.json': JSON.stringify({ version: '0.14.0' }) } });
    expect((await s.run())!.latest).toBe('0.14.0');
    expect(s.fetched).toEqual([`${RELEASES}/versions.json`, `${RELEASES}/latest.json`]);
  });

  it('compares a local build below its release', async () => {
    const s = setup({ check: { enabled: true, alert: false }, files: versions('0.14.0'), running: '0.14.0-dev.1' });
    expect((await s.run())!.latest).toBe('0.14.0');
  });

  it('records the failure of the topic, sends nothing as notified, and fails the run', async () => {
    const s = setup({ check: { enabled: true, alert: true }, files: versions('0.14.0') });
    const store = s.store;
    await expect(runUpdateCheck({
      store, running: '0.13.0', releasesUrl: RELEASES, env: 'dev', dashboardUrl: '', now: () => new Date(NOW),
      fetchText: async () => versions('0.14.0')['versions.json'], publish: async () => { throw new Error('no topic'); },
    }).then(() => 'ok', async () => store.getUpdateResult())).resolves.toMatchObject({ latest: '0.14.0', error: expect.stringContaining('no topic') });
  });
});
