// The engine's calls on Google Cloud (Google Cloud manager design §5.1, §8): a router's controller through the command
// account's ID token, and the tag bindings, both through the connection's Google instance. Refusals come back as the
// errors the steps already read (@dormeto/fleet's router caller, as `functionInvoker`'s): the router's with its `code`; the
// manager's own (no access, a router too old or not found yet) with their text, and their refusal as the `code` too.
import { bindTag, sqlRegionOf, tagValueOf, unbindTag, type Google, type GoogleConnection, type Tags } from '@dormeto/google';
import { codedError, routerCaller, type GoogleRouter } from '@dormeto/fleet/router-call';

type Source = { current(): Promise<{ connection: GoogleConnection; google: Google } | null> };

// `invoke(router, payload, { timeoutMs })`: the router's answer; a `{refused}` answer thrown as an Error with its `code`.
export function googleInvoker(source: Source, { env, routerVersion }: { env: string; routerVersion?: string | undefined }) {
  const calls = routerCaller({ google: { current: () => source.current(), env, routerVersion }, error: codedError });
  return async (router: GoogleRouter, payload: Record<string, unknown>, { timeoutMs }: { timeoutMs: number }): Promise<any> => calls.gcp(router, payload, { timeoutMs });
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
