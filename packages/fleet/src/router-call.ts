// The manager's calls of a router (cloud duplication design §3): an AWS router's function (its controller or onboarder)
// through Lambda, a Google Cloud router's controller through its /v1/actions with the command account's ID token
// (@dormeto/google's transport, Google Cloud manager design §5.1, §6.2). A synchronous call asks for refusals as answers
// (routers 0.37.0 and later: no Lambda error for the router's health, vision refusals design §1) and reads one back as the
// caller's own error with its code; a thrown error (a router before 0.37.0 throws its refusals, a failure) is one without,
// and a Google Cloud router the manager can't use is refused with its refusal. The API and the operations engine call
// routers through it, each with its error; the fleet's poll calls the transport itself (it reads Google's answers).
import type { Google, GoogleConnection } from '@dormeto/google';
import { accessMissingText, callRouter, controllerUnknownText, RouterCallError, type Refusal } from '@dormeto/google/router';
import { routerTooOld, tooOldText } from './clouds.js';

// A Google Cloud call's bound: a cold Cloud Run start (design §6.2). The onboarder's actions name their own.
export const GOOGLE_CALL_MS = 10_000;

// A router the manager acts on (Google Cloud manager design §6.2): the connection and its Google instance as read now
// (null while there is none), the router as the registry holds it (version: as the router reports it, '' when unknown).
// A router the manager can't use is refused before any call: a version before 0.40.0, no controller known yet, no
// connection. The payload is sent with `refusals: true` (without it a router answers a workload it doesn't know with its
// REST JSON 404, which reads as a router too old). The answer is the router's body, a `{refused}` answer as it is: each
// caller maps it. A failure is a RouterCallError, its `refusal` set when the manager's side can fix it.
export async function actOnRouter(
  current: { connection: GoogleConnection; google: Pick<Google, 'request'> } | null,
  router: { controller?: string; account?: string; region: string; version?: string },
  payload: Record<string, unknown>,
  { timeoutMs, env, routerVersion }: { timeoutMs: number; env: string; routerVersion?: string | undefined },
): Promise<unknown> {
  const [project, region, version] = [router.account ?? '', router.region, router.version ?? ''];
  if (routerTooOld(version)) throw new RouterCallError(tooOldText(version, project, region, routerVersion), { refusal: 'router_too_old' });
  const host = current?.connection.project ?? '<host>';
  if (!router.controller) throw new RouterCallError(controllerUnknownText(host, env), { refusal: 'router_unknown' });
  if (!current) throw new RouterCallError(accessMissingText(host, env), { refusal: 'no_access' });
  try {
    return await callRouter(current.google, { controller: router.controller }, { ...payload, refusals: true }, { timeoutMs });
  } catch (err) {
    if (!(err instanceof RouterCallError)) throw err;
    if (err.refusal === 'no_access') throw new RouterCallError(accessMissingText(host, env, err.said), { refusal: err.refusal });
    if (err.refusal === 'router_too_old') throw new RouterCallError(tooOldText('', project, region, routerVersion), { refusal: err.refusal });
    throw err;
  }
}

// A Lambda invoke (the AWS SDK's InvokeCommand), in the caller's account and region.
export type LambdaSend = (input: { FunctionName: string; InvocationType: 'Event' | 'RequestResponse'; Payload: Uint8Array }) => Promise<{ Payload?: Uint8Array; FunctionError?: string }>;
// A Google Cloud router's calls: the connection's record and its Google instance (one per execution environment), null while
// there is none, and what the refusals' commands name.
export interface GoogleCalls {
  current(): Promise<{ connection: GoogleConnection; google: Pick<Google, 'request'> } | null>;
  env: string; // the manager's environment
  routerVersion?: string | undefined; // the router version the manager installs and upgrades to
  timeoutMs?: number; // each call's bound (GOOGLE_CALL_MS when none)
}
export type GoogleRouter = Parameters<typeof actOnRouter>[1];
// A failed call, for the caller's error: the router's refusal code (invalid, not_found, conflict, unsupported), or the
// manager's refusal of a Google Cloud router it can't use (no_access, router_too_old, router_unknown); neither for a failure.
export type RouterFailure = { code?: string; refusal?: Refusal };

// The operations' error: an Error with the router's code, or the manager's refusal as its code (the steps read `code`).
export const codedError = (message: string, { code, refusal }: RouterFailure): Error =>
  Object.assign(new Error(message), code ?? refusal ? { code: code ?? refusal } : {});

export function routerCaller({ google, error }: { google?: GoogleCalls | undefined; error: (message: string, failure: RouterFailure) => Error }) {
  // A refusal answered, thrown with its code; any other answer as it is.
  const answerOf = (answer: unknown): unknown => {
    const refused = (answer as { refused?: { code?: string; message?: string } } | null)?.refused;
    if (refused) throw error(refused.message ?? 'refused', { code: refused.code });
    return answer;
  };
  return {
    // An AWS router's function by its name. An asynchronous call is sent as it is (an event): nothing reads its answer, and a
    // refusal there stays an error.
    async aws(send: LambdaSend, functionName: string, payload: Record<string, unknown>, { async = false }: { async?: boolean } = {}): Promise<unknown> {
      const body = async ? payload : { ...payload, refusals: true };
      const out = await send({ FunctionName: functionName, InvocationType: async ? 'Event' : 'RequestResponse', Payload: new Uint8Array(Buffer.from(JSON.stringify(body))) });
      if (async) return null;
      const answer = JSON.parse(out.Payload?.length ? Buffer.from(out.Payload).toString('utf8') : 'null');
      if (out.FunctionError) throw error((answer as { errorMessage?: string } | null)?.errorMessage ?? out.FunctionError, {});
      return answerOf(answer);
    },
    // A Google Cloud router's controller, within `timeoutMs` (the wiring's bound, else GOOGLE_CALL_MS). Google has no
    // asynchronous call: an asynchronous one is sent the same way, refusals asked, and its answer not read.
    async gcp(router: GoogleRouter, payload: Record<string, unknown>, { timeoutMs = google?.timeoutMs ?? GOOGLE_CALL_MS, async = false }: { timeoutMs?: number; async?: boolean } = {}): Promise<unknown> {
      let answer: unknown;
      try {
        answer = await actOnRouter((await google?.current()) ?? null, router, payload, { timeoutMs, env: google?.env ?? '', routerVersion: google?.routerVersion });
      } catch (err) {
        if (!(err instanceof RouterCallError)) throw err;
        throw error(err.message, err.refusal ? { refusal: err.refusal } : {});
      }
      return async ? null : answerOf(answer);
    },
  };
}
