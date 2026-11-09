// A request to Google bounded as the manager's AWS clients are: 3 s to connect (the TLS handshake done), then at most
// 10 s of silence, waiting for the answer or between two pieces of it. A request may bring its own bounds: a longer
// silence (a router's call, whose controller answers only once done) and a signal that aborts it wherever it is, or keeps
// it from being sent once given. The transport is node:https; the tests give a fetch instead, whose connection can't be
// seen.
import * as https from 'node:https';
import { Readable } from 'node:stream';
import { GoogleError } from './errors.js';

export const CONNECT_MS = 3_000;
export const SILENCE_MS = 10_000;

export type Fetch = typeof globalThis.fetch;
export type Request = { method: string; headers: Record<string, string>; body?: string };
export type Answer = { status: number; text: string };
// A request's own bounds: `silenceMs` in place of the 10 s of silence, `signal` aborting it with its reason.
export type Bounds = { silenceMs?: number; signal?: AbortSignal };
// What a transport gives back: the status and the body as it comes (a fetch Response is one).
export type Reply = { status: number; body: ReadableStream<Uint8Array> | null };
// A transport sends the request, calls `connected` once its connection is made, and stops on the signal.
export type Transport = (url: string, init: Request & { signal: AbortSignal }, connected: () => void) => Promise<Reply>;

// node:https on its keep-alive agent: a reused socket is connected already, a new one once its TLS handshake is done.
export function httpsTransport(request: typeof https.request = https.request): Transport {
  return (url, { method, headers, body, signal }, connected) => new Promise<Reply>((resolve, reject) => {
    const req = request(url, { method, headers: body === undefined ? headers : { ...headers, 'content-length': String(Buffer.byteLength(body)) } });
    signal.addEventListener('abort', () => { req.destroy(); reject(signal.reason); }, { once: true });
    req.once('socket', (socket) => {
      if (req.reusedSocket) connected();
      else socket.once('secureConnect', connected);
    });
    req.once('response', (res) => resolve({ status: res.statusCode ?? 0, body: Readable.toWeb(res) as ReadableStream<Uint8Array> }));
    req.on('error', reject);
    req.end(body);
  });
}

// A fetch as the transport: its connection counts as made at once, so its silence starts with the request.
export const fetchTransport = (fetch: Fetch): Transport => (url, init, connected) => {
  connected();
  return fetch(url, init);
};

export async function send(transport: Transport, url: string, init: Request, { silenceMs = SILENCE_MS, signal: outer }: Bounds = {}): Promise<Answer> {
  const { host } = new URL(url);
  // Given up on before it went: never sent.
  if (outer?.aborted) throw outer.reason;
  const controller = new AbortController();
  const { signal } = controller;
  const giveUp = (message: string) => () => controller.abort(new GoogleError({ status: 0, reason: '', message }));
  const stop = () => controller.abort(outer!.reason);
  outer?.addEventListener('abort', stop, { once: true });
  let done = false;
  let timer = setTimeout(giveUp(`could not reach ${host}: no connection in ${CONNECT_MS / 1000} s`), CONNECT_MS);
  // Connected, or a piece of the answer came: the silence starts again.
  const arm = () => {
    if (done) return;
    clearTimeout(timer);
    timer = setTimeout(giveUp(`no answer from ${host} in ${silenceMs / 1000} s`), silenceMs);
  };
  try {
    const res = await transport(url, { ...init, signal }, arm);
    arm();
    const chunks: Uint8Array[] = [];
    const reader = res.body?.getReader();
    if (reader) {
      // A body that doesn't follow the signal is cancelled on it.
      signal.addEventListener('abort', () => { reader.cancel(signal.reason).catch(() => {}); }, { once: true });
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        arm();
        chunks.push(value);
      }
    }
    if (signal.aborted) throw signal.reason;
    return { status: res.status, text: Buffer.concat(chunks).toString('utf8') };
  } catch (err) {
    if (signal.aborted) throw signal.reason;
    const e = err as { cause?: { code?: string }; code?: string; message?: string };
    throw new GoogleError({ status: 0, reason: '', message: `could not reach ${host}: ${e.cause?.code ?? e.code ?? e.message}` });
  } finally {
    done = true;
    clearTimeout(timer);
    outer?.removeEventListener('abort', stop);
  }
}
