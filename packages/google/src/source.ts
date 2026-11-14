// One Google instance per execution environment, so the tokens are kept from one invocation to the next: built when the
// connection's record is first read, built again only when the record changes. Discovery calls Google's APIs as its
// account through it; the API and the fleet function call routers with its instance.
import type { Google, GoogleConnection, ServiceAccount } from './google.js';

export function createGoogleSource({ read, create }: { read(): Promise<GoogleConnection | null>; create(connection: GoogleConnection): Google }) {
  let kept: { record: string; google: Google } | undefined;
  // The record as read now, and the instance for it; null while there is no connection.
  async function current(): Promise<{ connection: GoogleConnection; google: Google } | null> {
    const record = await read();
    if (!record) {
      kept = undefined;
      return null;
    }
    const text = JSON.stringify(record);
    if (kept?.record !== text) kept = { record: text, google: create(record) };
    return { connection: record, google: kept.google };
  }
  return {
    current,
    async connection(): Promise<GoogleConnection | null> {
      return (await current())?.connection ?? null;
    },
    // A Google API call as the account, with the instance of the record read last.
    async call<T = unknown>(sa: ServiceAccount, method: string, url: string, body?: unknown): Promise<T> {
      if (!kept) throw new Error('no Google Cloud connection');
      return kept.google.call<T>(sa, method, url, body);
    },
  };
}
