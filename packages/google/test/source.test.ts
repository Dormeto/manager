// One Google instance per execution environment (discovery, the API, the fleet's poll): built when the connection's record
// is first read, built again only when the record changes, so its tokens are kept from one invocation to the next.
import { describe, expect, it } from 'vitest';
import { createGoogleSource, type Google, type GoogleConnection } from '../src/index.js';

const connection = (over: Partial<GoogleConnection> = {}): GoogleConnection => ({
  project: 'dormeto-host', projectNumber: '1034397096264', pool: 'dmt-dev', provider: 'aws', scopes: ['projects/dormeto-host'],
  serviceAccounts: { discovery: 'dmt-dev-discovery@dormeto-host.iam.gserviceaccount.com', command: 'dmt-dev-command@dormeto-host.iam.gserviceaccount.com' },
  routers: [], googleAdded: [], connectedAt: '2026-11-09T10:00:00.000Z', connectedBy: 'cli', cli: '0.14.0', ...over,
});

describe('the Google source', () => {
  it('keeps one Google instance while the record is the same and builds another when it changes', async () => {
    let record: GoogleConnection | null = connection();
    const built: GoogleConnection[] = [];
    const source = createGoogleSource({ read: async () => record, create: (c) => { built.push(c); return { call: async () => ({}) } as never; } });
    await source.connection();
    await source.connection();
    expect(built).toHaveLength(1);
    record = connection({ scopes: ['projects/dormeto-host', 'projects/other'] });
    await source.connection();
    expect(built).toHaveLength(2);
    record = null;
    expect(await source.connection()).toBeNull();
  });

  it('calls as the account it is given', async () => {
    const seen: unknown[][] = [];
    const source = createGoogleSource({ read: async () => connection(), create: () => ({ call: async (...args: unknown[]) => { seen.push(args); return { ok: 1 }; } }) as never });
    await source.connection();
    expect(await source.call('discovery', 'GET', 'https://x')).toEqual({ ok: 1 });
    expect(seen).toEqual([['discovery', 'GET', 'https://x', undefined]]);
  });

  it('gives the record read and its instance, the same instance while the record stays, null without a record', async () => {
    let record: GoogleConnection | null = connection();
    const source = createGoogleSource({ read: async () => record, create: () => ({ call: async () => ({}) }) as unknown as Google });
    const first = await source.current();
    expect(first?.connection).toEqual(connection());
    expect((await source.current())?.google).toBe(first?.google);
    record = null;
    expect(await source.current()).toBeNull();
  });
});
