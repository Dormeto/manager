import { describe, expect, it } from 'vitest';
import { createApi, type ApiEvent } from '../src/api.js';

const event = (): ApiEvent => ({
  rawPath: '/api/ip-lists', requestContext: { http: { method: 'GET' }, authorizer: { jwt: { claims: { sub: 'u', email: 'u@example.com', 'cognito:groups': '[dmt-viewer]' } } } },
});
const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');
const base = { routers: [], invoke: async () => null, audit: { write: async () => {}, list: async () => [] }, version: '0.4.0' };

describe('IP lists', () => {
  it('gives each list of the catalog with what the list function last did', async () => {
    const api = createApi({
      ...base,
      ipLists: {
        catalogUrl: 's3://dmt-dev-manager-ip-lists-1/catalog.json',
        catalog: async () => ({ lists: [{ name: 'ipsum', url: 'https://x/ipsum', action: 'defer', refreshHours: 24 }, { name: 'aws', url: 'https://x/aws', action: 'ignore', refreshHours: 12 }] }),
        status: async () => ({ lists: [{ name: 'ipsum', url: 'https://x/ipsum', version: '1', entries: 9, dropped: 1, fetchedAt: '2026-10-08T12:00:00.000Z', lastAttemptAt: '2026-10-08T12:00:00.000Z', refreshHours: 24, attemptUrl: 'https://x/ipsum', format: 'ranges-v1' }] }),
      },
    });
    expect(json(await api(event()))).toEqual({
      catalog: 's3://dmt-dev-manager-ip-lists-1/catalog.json',
      lists: [
        { name: 'ipsum', url: 'https://x/ipsum', action: 'defer', refreshHours: 24, version: '1', entries: 9, dropped: 1, fetchedAt: '2026-10-08T12:00:00.000Z', lastAttemptAt: '2026-10-08T12:00:00.000Z' },
        { name: 'aws', url: 'https://x/aws', action: 'ignore', refreshHours: 12 },
      ],
    });
  });

  it('answers an empty list without the manager\'s lists', async () => {
    expect(json(await createApi(base)(event()))).toEqual({ catalog: null, lists: [] });
  });
});
