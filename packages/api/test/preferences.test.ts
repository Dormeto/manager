import { describe, expect, it } from 'vitest';
import { createApi, type ApiEvent, type Preferences } from '../src/api.js';

function setup() {
  const saved = new Map<string, Preferences>();
  const api = createApi({
    routers: [], invoke: async () => ({}), audit: { write: async () => {}, list: async () => [] }, version: '0.1.0',
    preferences: { get: async (sub) => saved.get(sub) ?? null, put: async (sub, prefs) => { saved.set(sub, prefs); } },
  });
  return { api, saved };
}

const event = (method: string, sub: string, body?: unknown): ApiEvent => ({
  rawPath: '/api/preferences',
  requestContext: { http: { method }, authorizer: { jwt: { claims: { sub, email: `${sub}@example.com` } } } },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');

describe('preferences', () => {
  it('default to a 10 s refresh', async () => {
    const { api } = setup();
    expect(json(await api(event('GET', 'u-1')))).toEqual({ refreshSeconds: 10 });
  });

  it('are saved per user, viewers included', async () => {
    const { api, saved } = setup();
    expect((await api(event('PUT', 'u-1', { refreshSeconds: 30 }))).statusCode).toBe(200);
    expect(json(await api(event('GET', 'u-1')))).toEqual({ refreshSeconds: 30 });
    expect(json(await api(event('GET', 'u-2')))).toEqual({ refreshSeconds: 10 });
    expect([...saved.keys()]).toEqual(['u-1']);
  });

  it('accept off (0) or 5 s to 10 min only', async () => {
    const { api } = setup();
    expect((await api(event('PUT', 'u-1', { refreshSeconds: 0 }))).statusCode).toBe(200);
    for (const bad of [3, 601, 'fast', 12.5]) {
      expect((await api(event('PUT', 'u-1', { refreshSeconds: bad }))).statusCode).toBe(400);
    }
  });

  it('keep the update notice dismissed for a version, beside the refresh', async () => {
    const { api } = setup();
    await api(event('PUT', 'u-1', { refreshSeconds: 30 }));
    expect(json(await api(event('PUT', 'u-1', { dismissedUpdate: '0.14.0' })))).toEqual({ refreshSeconds: 30, dismissedUpdate: '0.14.0' });
    expect(json(await api(event('GET', 'u-1')))).toEqual({ refreshSeconds: 30, dismissedUpdate: '0.14.0' });
    expect(json(await api(event('PUT', 'u-1', { refreshSeconds: 60 })))).toEqual({ refreshSeconds: 60, dismissedUpdate: '0.14.0' });
    for (const bad of [14, 'latest', '']) expect((await api(event('PUT', 'u-1', { dismissedUpdate: bad }))).statusCode, String(bad)).toBe(400);
  });
});
