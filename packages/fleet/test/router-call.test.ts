// The manager's one router caller (cloud duplication design §3): an AWS router's function through Lambda, a Google Cloud
// router's controller through @dormeto/google's transport. A synchronous call asks for refusals as answers and reads one back
// as the caller's own error with its code (vision refusals design §1); a Google Cloud router the manager can't use is refused
// before any call, with its refusal (Google Cloud manager design §6.2). The API and the operations engine call through it,
// each with its error: their own tests (api router-invoke, operations function-invoke and google-invoke) say what they read.
import { RouterCallError } from '@dormeto/google';
import { describe, expect, it, vi } from 'vitest';
import { accessMissingText } from '@dormeto/google/router';
import { ACTIONS, connection, CONTROLLER, fakeGoogle, html, json, silent } from '../../google/test/fake-google.js';
import { tooOldText } from '../src/clouds.js';
import { actOnRouter, codedError, GOOGLE_CALL_MS, routerCaller, type RouterFailure } from '../src/router-call.js';

class Failed extends Error {
  constructor(message: string, readonly failure: RouterFailure) {
    super(message);
  }
}
const error = (message: string, failure: RouterFailure) => new Failed(message, failure);
const failed = (promise: Promise<unknown>) => promise.then(() => { throw new Error('answered'); }, (e: unknown) => e as Failed);

describe('routerCaller, an AWS router\'s function', () => {
  const ARN = 'arn:aws:lambda:eu-west-3:111122223333:function:dmtr-dev-controller';
  type Input = { FunctionName: string; InvocationType: string; Payload: Uint8Array };
  const answering = (value: unknown, functionError?: string) => {
    const sent: Input[] = [];
    const send = async (input: Input) => {
      sent.push(input);
      return { Payload: new Uint8Array(Buffer.from(JSON.stringify(value))), ...(functionError ? { FunctionError: functionError } : {}) };
    };
    return { send, sent, payload: () => JSON.parse(Buffer.from(sent[0]!.Payload).toString()) };
  };

  it('asks for refusals as answers in a synchronous call and gives back the answer', async () => {
    const { send, sent, payload } = answering({ state: 'AWAKE' });
    expect(await routerCaller({ error }).aws(send, ARN, { action: 'status', workloadId: 'demo' })).toEqual({ state: 'AWAKE' });
    expect([sent[0]!.FunctionName, sent[0]!.InvocationType, payload()]).toEqual([ARN, 'RequestResponse', { action: 'status', workloadId: 'demo', refusals: true }]);
  });

  it('throws a refusal as the caller\'s error with its message and code', async () => {
    const { send } = answering({ refused: { code: 'conflict', message: 'workload demo was written by Terraform: set name in its workload module' } });
    const err = await failed(routerCaller({ error }).aws(send, ARN, { action: 'rename', workloadId: 'demo', name: 'x' }));
    expect([err instanceof Failed, err.message, err.failure]).toEqual([true, 'workload demo was written by Terraform: set name in its workload module', { code: 'conflict' }]);
    const { send: bare } = answering({ refused: {} });
    expect((await failed(routerCaller({ error }).aws(bare, ARN, { action: 'status' }))).message).toBe('refused');
  });

  it('throws a function error (a router before 0.37.0, or a failure) with its message and no code', async () => {
    const { send } = answering({ errorType: 'Error', errorMessage: 'workload not configured: demo' }, 'Unhandled');
    const err = await failed(routerCaller({ error }).aws(send, ARN, { action: 'status', workloadId: 'demo' }));
    expect([err.message, err.failure]).toEqual(['workload not configured: demo', {}]);
    const { send: silent } = answering(null, 'Unhandled');
    expect((await failed(routerCaller({ error }).aws(silent, ARN, { action: 'status' }))).message).toBe('Unhandled');
  });

  it('sends an asynchronous call as it is, as an event, and reads nothing of its answer', async () => {
    const { send, sent, payload } = answering({ refused: { code: 'invalid', message: 'never read' } });
    expect(await routerCaller({ error }).aws(send, ARN, { action: 'check' }, { async: true })).toBeNull();
    expect([sent[0]!.InvocationType, payload()]).toEqual(['Event', { action: 'check' }]);
  });
});

describe('routerCaller, a Google Cloud router\'s controller', () => {
  const ROUTER = { controller: CONTROLLER, account: 'dormeto-dev', region: 'europe-west2', version: '0.40.0' };
  const calls = (google: ReturnType<typeof fakeGoogle>['google'] | null) => ({ current: async () => (google ? { connection, google } : null), env: 'dev', routerVersion: '0.40.0' });

  it('asks for refusals as answers and gives back the answer', async () => {
    const g = fakeGoogle(() => json(200, { state: 'AWAKE' }));
    expect(await routerCaller({ google: calls(g.google), error }).gcp(ROUTER, { action: 'status', workloadId: 'w' })).toEqual({ state: 'AWAKE' });
    expect(JSON.parse(g.to(ACTIONS)[0]!.body)).toEqual({ action: 'status', workloadId: 'w', refusals: true });
  });

  it('throws the router\'s refusal with its code, and the manager\'s refusal of the router with its refusal', async () => {
    const refused = fakeGoogle(() => json(200, { refused: { code: 'not_found', message: 'workload not configured: w' } }));
    expect((await failed(routerCaller({ google: calls(refused.google), error }).gcp(ROUTER, { action: 'status', workloadId: 'w' }))).failure).toEqual({ code: 'not_found' });
    const old = await failed(routerCaller({ google: calls(refused.google), error }).gcp({ ...ROUTER, version: '0.39.0' }, { action: 'status' }));
    expect([old.message, old.failure]).toEqual([tooOldText('0.39.0', 'dormeto-dev', 'europe-west2', '0.40.0'), { refusal: 'router_too_old' }]);
    const none = await failed(routerCaller({ google: calls(null), error }).gcp(ROUTER, { action: 'status' }));
    expect([none.message, none.failure]).toEqual([accessMissingText('<host>', 'dev'), { refusal: 'no_access' }]);
    // No Google Cloud wiring at all: no connection, the environment unnamed.
    expect((await failed(routerCaller({ error }).gcp(ROUTER, { action: 'status' }))).message).toBe('the manager\'s accounts can\'t reach the router: dormeto gcp connect --project <host> --profile <profile> --env');
  });

  it('throws the controller\'s failure with its message and no code, as a function error', async () => {
    const g = fakeGoogle(() => json(500, { error: 'internal', message: 'Firestore unavailable' }));
    const err = await failed(routerCaller({ google: calls(g.google), error }).gcp(ROUTER, { action: 'list' }));
    expect([err instanceof Failed, err.message, err.failure]).toEqual([true, 'Firestore unavailable', {}]);
  });

  it('lets an error that is not the call\'s go as it is', async () => {
    const broken = new Error('the connection\'s record can\'t be read');
    expect(await failed(routerCaller({ google: { current: async () => { throw broken; }, env: 'dev' }, error }).gcp(ROUTER, { action: 'list' }))).toBe(broken);
  });

  // Without refusals, a 0.40.0 router answers a workload it doesn't know with its REST JSON 404, which reads as a router too
  // old: every Google Cloud call asks for them.
  it('sends an asynchronous call asking for refusals too, and reads nothing of its answer', async () => {
    const g = fakeGoogle(() => json(200, { refused: { code: 'not_found', message: 'workload not configured: demo' } }));
    expect(await routerCaller({ google: calls(g.google), error }).gcp(ROUTER, { action: 'nap', workloadId: 'demo' }, { async: true })).toBeNull();
    expect(JSON.parse(g.to(ACTIONS)[0]!.body)).toEqual({ action: 'nap', workloadId: 'demo', refusals: true });
  });

  it('bounds each call by 10 s (a cold Cloud Run start), else by the wiring\'s bound, else by the call\'s', async () => {
    vi.useFakeTimers();
    try {
      const bound = async (wiring: number | undefined, call: number | undefined) => {
        const g = fakeGoogle(silent);
        const caller = routerCaller({ google: { ...calls(g.google), ...(wiring ? { timeoutMs: wiring } : {}) }, error });
        const err = failed(caller.gcp(ROUTER, { action: 'onboard' }, call ? { timeoutMs: call } : {}));
        await vi.advanceTimersByTimeAsync(300_000);
        return (await err).message;
      };
      expect(GOOGLE_CALL_MS).toBe(10_000);
      expect([await bound(undefined, undefined), await bound(5_000, undefined), await bound(5_000, 300_000)])
        .toEqual(['no answer within 10000 ms', 'no answer within 5000 ms', 'no answer within 300000 ms']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('codedError', () => {
  it('is an Error with the router\'s code, or the manager\'s refusal as its code, as the operations\' steps read it', () => {
    const coded = (failure: RouterFailure) => codedError('m', failure) as Error & { code?: string };
    expect([coded({ code: 'not_found' }).code, coded({ refusal: 'no_access' }).code, 'code' in coded({}), coded({}) instanceof Error, coded({}).message]).toEqual(['not_found', 'no_access', false, true, 'm']);
  });
});

describe('actOnRouter', () => {
  const router = { controller: CONTROLLER, account: 'dormeto-dev', region: 'europe-west2', version: '0.40.0' };
  const opts = { timeoutMs: 10_000, env: 'dev', routerVersion: '0.40.0' };
  const failing = (promise: Promise<unknown>) => promise.then(() => { throw new Error('answered'); }, (e: unknown) => e as RouterCallError);

  it('sends the payload with refusals asked and answers the body, a refusal as it is', async () => {
    const g = fakeGoogle(() => json(200, { refused: { code: 'not_found', message: 'workload not configured: w' } }));
    expect(await actOnRouter({ connection, google: g.google }, router, { action: 'status', workloadId: 'w' }, opts)).toEqual({ refused: { code: 'not_found', message: 'workload not configured: w' } });
    expect(JSON.parse(g.to(ACTIONS)[0]!.body)).toEqual({ action: 'status', workloadId: 'w', refusals: true });
  });

  it('refuses a router before 0.40.0 without calling it', async () => {
    const g = fakeGoogle(() => json(200, {}));
    const err = await failing(actOnRouter({ connection, google: g.google }, { ...router, version: '0.39.0' }, { action: 'status' }, opts));
    expect([err.refusal, err.message]).toEqual(['router_too_old', tooOldText('0.39.0', 'dormeto-dev', 'europe-west2', '0.40.0')]);
    expect(g.seen).toEqual([]);
  });

  it('refuses a router without a controller as unknown and a missing connection as no access', async () => {
    const g = fakeGoogle(() => json(200, {}));
    const { controller: _, ...unplaced } = router;
    expect((await failing(actOnRouter({ connection, google: g.google }, unplaced, { action: 'status' }, opts))).refusal).toBe('router_unknown');
    const err = await failing(actOnRouter(null, router, { action: 'status' }, opts));
    expect([err.refusal, err.message]).toEqual(['no_access', accessMissingText('<host>', 'dev')]);
  });

  it('turns Google refusing the token into no_access with its words, and a router without /v1/actions into too old', async () => {
    const denied = await failing(actOnRouter({ connection, google: fakeGoogle(() => html(403, 'Forbidden')).google }, router, { action: 'status' }, opts));
    expect(denied.refusal).toBe('no_access');
    expect(denied.message).toMatch(/^the manager's accounts can't reach the router: dormeto gcp connect --project dormeto-host .* \(Google: /);
    const old = await failing(actOnRouter({ connection, google: fakeGoogle(() => json(404, { error: 'not-found' })).google }, router, { action: 'status' }, opts));
    expect([old.refusal, old.message]).toEqual(['router_too_old', tooOldText('', 'dormeto-dev', 'europe-west2', '0.40.0')]);
  });

  it('throws any other failure as it is, without a refusal', async () => {
    const err = await failing(actOnRouter({ connection, google: fakeGoogle(() => json(500, { error: 'boom' })).google }, router, { action: 'status' }, opts));
    expect([err.message, err.refusal]).toEqual(['boom', undefined]);
  });
});
