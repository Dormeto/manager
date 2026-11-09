// A request to Google bounded as the manager's AWS clients are: it gives up after 10 s of silence, waiting for the answer
// or between two pieces of it. fetch doesn't show its connection, so the connection is within those 10 s (undici's own
// connect timeout is 10 s too).
import { GoogleError } from './errors.js';

export const SILENCE_MS = 10_000;

export type Fetch = typeof globalThis.fetch;
export type Answer = { status: number; text: string };

export async function send(fetch: Fetch, url: string, init: RequestInit): Promise<Answer> {
  const { host } = new URL(url);
  const controller = new AbortController();
  const { signal } = controller;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new GoogleError({ status: 0, reason: '', message: `no answer from ${host} in ${SILENCE_MS / 1000} s` })), SILENCE_MS);
  };
  arm();
  try {
    const res = await fetch(url, { ...init, signal });
    arm();
    const chunks: Uint8Array[] = [];
    const reader = res.body?.getReader();
    if (reader) {
      // A body that doesn't follow the signal is cancelled on it.
      signal.addEventListener('abort', () => { reader.cancel(signal.reason).catch(() => {}); }, { once: true });
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arm();
        chunks.push(value);
      }
    }
    if (signal.aborted) throw signal.reason;
    return { status: res.status, text: Buffer.concat(chunks).toString('utf8') };
  } catch (err) {
    if (signal.aborted) throw signal.reason;
    const cause = (err as { cause?: { code?: string } }).cause?.code ?? (err as Error).message;
    throw new GoogleError({ status: 0, reason: '', message: `could not reach ${host}: ${cause}` });
  } finally {
    clearTimeout(timer);
  }
}
