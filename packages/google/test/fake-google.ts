// A Google instance whose fetch answers Google's token endpoints and, behind them, a router's controller as a test says:
// the transport's tests and the fleet's router caller's (packages/fleet/test/router-call.test.ts) call through it.
import { vi } from 'vitest';
import { createGoogle, type GoogleConnection } from '../src/index.js';

export const T0 = Date.parse('2026-11-09T12:00:00Z');
export const COMMAND = 'dmt-dev-command@dormeto-host.iam.gserviceaccount.com';
export const CONTROLLER = 'https://dmtr-europe-west2-controller-abc123-nw.a.run.app';
export const ACTIONS = `${CONTROLLER}/v1/actions`;

export const connection: GoogleConnection = {
  project: 'dormeto-host', projectNumber: '1034397096264', pool: 'dmt-dev', provider: 'aws-121014831971', scopes: ['projects/dormeto-host'],
  serviceAccounts: { discovery: 'dmt-dev-discovery@dormeto-host.iam.gserviceaccount.com', command: COMMAND },
  routers: [{ project: 'dormeto-dev', region: 'europe-west2' }], googleAdded: [], connectedAt: '2026-11-09T10:00:00.000Z', connectedBy: 'admin@example.com', cli: '0.14.0',
};
const credentials = { accessKeyId: 'ASIAEXAMPLE', secretAccessKey: 'secret', sessionToken: 'the-session-token' };

export type Seen = { url: string; method: string; headers: Record<string, string>; body: string; signal?: AbortSignal };
export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// An answer that never comes: rejected when its request is aborted, as fetch's.
export const silent = (req: Seen) => new Promise<Response>((_resolve, reject) => { req.signal!.addEventListener('abort', () => reject(req.signal!.reason)); });
export const html = (status: number, title: string) => new Response(`<html><head><title>${status} ${title}</title></head><body><h1>Error: ${title}</h1></body></html>`, { status, headers: { 'content-type': 'text/html' } });
export const jwt = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;

// Google's token endpoints, then the controller as `controller` answers it.
export function fakeGoogle(controller: (req: Seen) => Response | Promise<Response>, tokens?: (req: Seen) => Response | Promise<Response> | undefined) {
  let n = 0;
  const seen: Seen[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const req: Seen = { url: String(input), method: init?.method ?? 'GET', headers: { ...(init?.headers as Record<string, string>) }, body: String(init?.body ?? ''), ...(init?.signal ? { signal: init.signal } : {}) };
    seen.push(req);
    const own = tokens?.(req);
    if (own) return own;
    if (req.url === 'https://sts.googleapis.com/v1/token') return json(200, { access_token: `federated-${++n}`, expires_in: 3600 });
    if (req.url.endsWith(':generateIdToken')) return json(200, { token: jwt({ aud: (JSON.parse(req.body) as { audience: string }).audience, exp: Math.floor(T0 / 1000) + 3600, n: ++n }) });
    return controller(req);
  });
  const google = createGoogle({ connection, credentials, fetch: fetch as typeof globalThis.fetch, now: () => T0 });
  return { google, seen, to: (url: string) => seen.filter((s) => s.url === url) };
}
