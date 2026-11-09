// The engine's calls on Google Cloud (Google Cloud manager design §5.1, §8): a router's controller through the command
// account's ID token, and the tag bindings, both through the connection's Google instance. Refusals come back as the
// errors the steps already read: the router's with its `code`, as `functionInvoker`'s; the manager's own (no access, a
// router too old or not found yet) with their text, and their refusal as the `code` too.
import { actOnRouter, bindTag, RouterCallError, sqlRegionOf, tagValueOf, unbindTag, type Google, type GoogleConnection, type Tags } from '@dormeto/google';

type Source = { current(): Promise<{ connection: GoogleConnection; google: Google } | null> };
export type GoogleRouter = { account?: string; region: string; controller?: string; version?: string };

// `invoke(router, payload, { timeoutMs })`: the router's answer; a `{refused}` answer thrown as an Error with its `code`.
export function googleInvoker(source: Source, { env, routerVersion }: { env: string; routerVersion?: string | undefined }) {
  return async (router: GoogleRouter, payload: Record<string, unknown>, { timeoutMs }: { timeoutMs: number }): Promise<any> => {
    let answer: unknown;
    try {
      answer = await actOnRouter(await source.current(), router, payload, { timeoutMs, env, routerVersion });
    } catch (err) {
      if (err instanceof RouterCallError) throw Object.assign(new Error(err.message), err.refusal ? { code: err.refusal } : {});
      throw err;
    }
    const refused = (answer as { refused?: { code?: string; message?: string } } | null)?.refused;
    if (refused) throw Object.assign(new Error(refused.message ?? 'refused'), { code: refused.code });
    return answer;
  };
}

// The tag functions as the command account of the connection's current Google instance; a tag value that can't be read
// names the connect command of the connection's host project and the manager's environment.
export function googleTags(source: Source, { env }: { env: string }): Tags {
  const connected = async () => {
    const current = await source.current();
    if (!current) throw new Error('no Google Cloud connection');
    return current;
  };
  const google = async (): Promise<Google> => (await connected()).google;
  return {
    tagValueOf: async (project) => {
      const { connection, google: g } = await connected();
      return tagValueOf(g, project, { host: connection.project, env });
    },
    bindTag: async (target, value) => bindTag(await google(), target, value),
    unbindTag: async (target, value) => unbindTag(await google(), target, value),
    sqlRegionOf: async (project, name) => sqlRegionOf(await google(), project, name),
  };
}
