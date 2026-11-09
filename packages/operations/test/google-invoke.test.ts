// The engine's calls of a Google Cloud router, read back as the errors its steps already handle (as function-invoke.test.ts
// does for AWS): the router's refusal with its code, the manager's own with their text.
import { describe, expect, it } from 'vitest';
import { GoogleError, RouterCallError, type Google, type GoogleConnection } from '@dormeto/google';
import { googleInvoker, googleTags } from '../src/google.js';

const CONTROLLER = 'https://dmtr-europe-west2-controller-abc123-nw.a.run.app';
const connection = { project: 'dormeto-host' } as GoogleConnection;
const ROUTER = { account: 'dormeto-dev', region: 'europe-west2', controller: CONTROLLER, version: '0.40.0' };

// A source whose Google answers the controller's /v1/actions with `status` and `body`.
function source(status: number, body: unknown, connected = true) {
  const sent: { url: string; body: unknown }[] = [];
  const google = { request: async (_sa: string, _audience: string, _method: string, url: string, payload?: unknown) => { sent.push({ url, body: payload }); return { status, text: JSON.stringify(body) }; } } as unknown as Google;
  return { sent, source: { current: async () => (connected ? { connection, google } : null) } };
}
const failing = (p: Promise<unknown>) => p.then(() => { throw new Error('answered'); }, (e: unknown) => e as Error & { code?: string });

describe('a Google Cloud router, from the operations engine', () => {
  it('asks for refusals as answers and gives back the answer', async () => {
    const s = source(200, { state: 'AWAKE' });
    expect(await googleInvoker(s.source, { env: 'dev' })(ROUTER, { action: 'status', workloadId: 'w' }, { timeoutMs: 10_000 })).toEqual({ state: 'AWAKE' });
    expect(s.sent).toEqual([{ url: `${CONTROLLER}/v1/actions`, body: { action: 'status', workloadId: 'w', refusals: true } }]);
  });

  it('throws a refusal as an error with its message and code, as the engine\'s notConfigured reads it', async () => {
    const s = source(200, { refused: { code: 'not_found', message: 'workload not configured: w' } });
    const err = await failing(googleInvoker(s.source, { env: 'dev' })(ROUTER, { action: 'status', workloadId: 'w' }, { timeoutMs: 10_000 }));
    expect([err instanceof Error, err.message, err.code]).toEqual([true, 'workload not configured: w', 'not_found']);
    expect(/^workload not configured/.test(err.message)).toBe(true);
  });

  it('throws manager-access-missing with its text and code when there is no connection', async () => {
    const err = await failing(googleInvoker(source(200, {}, false).source, { env: 'dev' })(ROUTER, { action: 'status' }, { timeoutMs: 10_000 }));
    expect([err.code, err.message]).toEqual(['manager-access-missing', expect.stringMatching(/^the manager's accounts can't reach the router: dormeto gcp connect --project <host>.* --env dev/)]);
  });

  it('throws router-too-old for a router before 0.40.0, and any other failure with its text and no code', async () => {
    const old = await failing(googleInvoker(source(200, {}).source, { env: 'dev', routerVersion: '0.40.0' })({ ...ROUTER, version: '0.39.0' }, { action: 'status' }, { timeoutMs: 10_000 }));
    expect([old.code, old.message]).toEqual(['router-too-old', expect.stringContaining('dormeto gcp install --project dormeto-dev --region europe-west2 --version 0.40.0')]);
    const down = await failing(googleInvoker(source(500, { error: 'boom' }).source, { env: 'dev' })(ROUTER, { action: 'status' }, { timeoutMs: 10_000 }));
    expect([down instanceof RouterCallError, down.message, down.code]).toEqual([false, 'boom', undefined]);
  });
});

describe('the tags of the connection\'s Google', () => {
  it('reads the tag value as the command account and refuses without a connection', async () => {
    const calls: unknown[][] = [];
    const google = { call: async (...args: unknown[]) => { calls.push(args); return { name: 'tagValues/1' }; } } as unknown as Google;
    expect(await googleTags({ current: async () => ({ connection, google }) }, { env: 'dev' }).tagValueOf('shop-prd')).toBe('tagValues/1');
    expect(calls[0]!.slice(0, 2)).toEqual(['command', 'GET']);
    await expect(googleTags({ current: async () => null }, { env: 'dev' }).tagValueOf('shop-prd')).rejects.toThrow('no Google Cloud connection');
  });

  it('names the connect command of the connection\'s host project and the manager\'s environment when the tag value can\'t be read', async () => {
    const google = { call: async () => { throw new GoogleError({ status: 403, reason: 'PERMISSION_DENIED', message: 'denied' }); } } as unknown as Google;
    await expect(googleTags({ current: async () => ({ connection, google }) }, { env: 'prd' }).tagValueOf('shop-prd')).rejects.toThrow(
      'the tag value shop-prd/dormeto/managed can\'t be read: dormeto gcp connect --project dormeto-host --profile <profile> --env prd gives the manager\'s command account access to it',
    );
  });
});
