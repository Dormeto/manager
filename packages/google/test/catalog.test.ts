// The Cloud Billing Catalog as the discovery account reads it (Google Cloud savings, §9.2): a service's SKUs page by page in
// USD, 60 s a page; a refusal says how to give the account the API; no connection says so.
import { describe, expect, it } from 'vitest';
import { catalogPort, createGoogleSource, GoogleError, type Google, type GoogleConnection } from '../src/index.js';

const connection: GoogleConnection = {
  project: 'dormeto-dev', projectNumber: '1034397096264', pool: 'dmt-dev', provider: 'aws-121014831971', scopes: ['projects/dormeto-dev'],
  serviceAccounts: { discovery: 'dmt-dev-discovery@dormeto-dev.iam.gserviceaccount.com', command: 'dmt-dev-command@dormeto-dev.iam.gserviceaccount.com' },
  routers: [], googleAdded: [], connectedAt: '2026-11-09T10:00:00.000Z', connectedBy: 'cli', cli: '0.14.0',
};
const BASE = 'https://cloudbilling.googleapis.com/v1/services/6F81-5844-456A/skus?currencyCode=USD&pageSize=5000';

// A source whose Google answers `answer` for each call, recording what it was asked.
function setup(answer: (url: string) => unknown, record: GoogleConnection | null = connection) {
  const seen: { sa: string; method: string; url: string; bounds?: { silenceMs?: number; signal?: AbortSignal } }[] = [];
  const google = { call: async (sa: string, method: string, url: string, _body?: unknown, bounds?: { silenceMs?: number; signal?: AbortSignal }) => { seen.push({ sa, method, url, bounds }); return answer(url); } } as unknown as Google;
  const source = createGoogleSource({ read: async () => record, create: () => google });
  return { port: catalogPort(source), seen };
}

describe('the Cloud Billing Catalog port', () => {
  it('reads a service\'s SKUs in USD as the discovery account, 5000 a page, bounded to 60 s', async () => {
    const s = setup(() => ({ skus: [{ description: 'E2 Instance Core running in EMEA' }] }));
    expect(await s.port.skus('6F81-5844-456A')).toEqual({ skus: [{ description: 'E2 Instance Core running in EMEA' }] });
    expect(s.seen.map(({ sa, method, url }) => [sa, method, url])).toEqual([['discovery', 'GET', BASE]]);
    expect(s.seen[0]!.bounds?.silenceMs).toBe(60_000);
    expect(s.seen[0]!.bounds?.signal).toBeInstanceOf(AbortSignal);
  });

  it('follows the pages: the token of one is the next one\'s query', async () => {
    const s = setup((url) => (url.includes('pageToken=') ? { skus: [{ description: 'b' }] } : { skus: [{ description: 'a' }], nextPageToken: 'next/1=' }));
    const first = await s.port.skus('6F81-5844-456A');
    const second = await s.port.skus('6F81-5844-456A', first.nextPageToken);
    expect([first.nextPageToken, second.nextPageToken]).toEqual(['next/1=', undefined]);
    expect(s.seen.map((r) => r.url)).toEqual([BASE, `${BASE}&pageToken=next%2F1%3D`]);
  });

  it.each([403, 404])('says how to give the account the Cloud Billing API when Google answers %i', async (status) => {
    const s = setup(() => { throw new GoogleError({ status, reason: '', message: 'denied' }); });
    const failure = (await s.port.skus('6F81-5844-456A').then(() => null, (e: unknown) => e)) as Error;
    expect(failure.message).toContain('Cloud Billing API');
    expect(failure.message).toContain('discovery account');
    expect(failure.message).toContain('dormeto gcp connect');
  });

  it('lets another failure through as it is', async () => {
    const s = setup(() => { throw new GoogleError({ status: 500, reason: '', message: 'backend error' }); });
    await expect(s.port.skus('6F81-5844-456A')).rejects.toThrow('backend error');
  });

  it('says there is no connection, calling nothing', async () => {
    const s = setup(() => ({}), null);
    await expect(s.port.skus('6F81-5844-456A')).rejects.toThrow('no Google Cloud connection');
    expect(s.seen).toEqual([]);
  });
});
