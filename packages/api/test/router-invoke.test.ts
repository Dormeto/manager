// The manager's calls of a router's controller (vision refusals design §1): refusals asked as answers, read back as the
// router errors every route already handles, with their code.
import { describe, expect, it } from 'vitest';
import { RouterError, routerInvoker, type Router } from '../src/api.js';

const ROUTER: Router = { name: 'dmt-dev', region: 'eu-west-1', controller: 'arn:aws:lambda:eu-west-1:121014831971:function:dmt-dev-controller' };
type Input = { FunctionName: string; InvocationType: string; Payload: Uint8Array };
const answering = (value: unknown, functionError?: string) => {
  const sent: { router: Router; input: Input }[] = [];
  const invoke = routerInvoker(async (router, input) => {
    sent.push({ router, input });
    return { Payload: new Uint8Array(Buffer.from(JSON.stringify(value))), ...(functionError ? { FunctionError: functionError } : {}) };
  });
  return { invoke, sent, payload: (i = 0) => JSON.parse(Buffer.from(sent[i]!.input.Payload).toString()) };
};

describe('a router\'s controller, from the manager', () => {
  it('asks for refusals as answers and gives back what the controller answers', async () => {
    const { invoke, sent, payload } = answering({ workloads: [] });
    expect(await invoke(ROUTER, { action: 'list' })).toEqual({ workloads: [] });
    expect(payload()).toEqual({ action: 'list', refusals: true });
    expect([sent[0]!.router, sent[0]!.input.FunctionName, sent[0]!.input.InvocationType]).toEqual([ROUTER, ROUTER.controller, 'RequestResponse']);
  });

  it('reads a refusal as a router error with its message and code', async () => {
    const { invoke } = answering({ refused: { code: 'conflict', message: 'workload demo was written by Terraform: set name in its workload module' } });
    const err = await invoke(ROUTER, { action: 'rename', workloadId: 'demo', name: 'x', by: 'ops' }).catch((e: unknown) => e) as RouterError;
    expect(err).toBeInstanceOf(RouterError);
    expect([err.message, err.code]).toEqual(['workload demo was written by Terraform: set name in its workload module', 'conflict']);
  });

  it('reads a thrown error (a router before 0.37.0, or a failure) as a router error without a code', async () => {
    const { invoke } = answering({ errorType: 'Error', errorMessage: 'workload not configured: demo' }, 'Unhandled');
    const err = await invoke(ROUTER, { action: 'status', workloadId: 'demo' }).catch((e: unknown) => e) as RouterError;
    expect([err instanceof RouterError, err.message, err.code]).toEqual([true, 'workload not configured: demo', undefined]);
  });

  it('sends an asynchronous call as it is: no answer to read, a refusal there stays an error kept by the failure queue', async () => {
    const { invoke, sent, payload } = answering(null);
    expect(await invoke(ROUTER, { action: 'check' }, { async: true })).toBeNull();
    expect([payload(), sent[0]!.input.InvocationType]).toEqual([{ action: 'check' }, 'Event']);
  });
});

describe('a Google Cloud router\'s controller, from the manager', () => {
  const GCP: Router = { name: 'dmtr-dormeto-dev-europe-west2', region: 'europe-west2', account: 'dormeto-dev', cloud: 'gcp', controller: 'https://dmtr-europe-west2-controller-abc-nw.a.run.app', installed: { version: '0.40.0', build: '', at: '2026-11-09T10:00:00.000Z' } };
  const never = async () => { throw new Error('not an AWS call'); };

  it('answers manager-access-missing without a connection, the host left for the operator', async () => {
    const invoke = routerInvoker(never, { current: async () => null, env: 'dev', routerVersion: '0.40.0' });
    const err = await invoke(GCP, { action: 'list' }).catch((e: unknown) => e) as RouterError;
    expect([err instanceof RouterError, err.refusal, err.message]).toEqual([true, 'manager-access-missing', 'the manager\'s accounts can\'t reach the router: dormeto gcp connect --project <host> --profile <profile> --env dev']);
  });

  it('reads the controller\'s failure as a router error without a code, as a thrown AWS one', async () => {
    const request = async () => ({ status: 500, text: JSON.stringify({ error: 'internal', message: 'Firestore unavailable' }) });
    const invoke = routerInvoker(never, { current: async () => ({ connection: { project: 'dormeto-host' } as never, google: { request } }), env: 'dev' });
    const err = await invoke(GCP, { action: 'list' }).catch((e: unknown) => e) as RouterError;
    expect([err instanceof RouterError, err.message, err.code, err.refusal]).toEqual([true, 'Firestore unavailable', undefined, undefined]);
  });

  // Without refusals, a 0.40.0 router answers a workload it doesn't know with its REST JSON 404, which reads as a router
  // too old: every Google Cloud call asks for them.
  it('sends an asynchronous call asking for refusals too, and reads nothing of its answer', async () => {
    const sent: unknown[] = [];
    const request = async (...args: unknown[]) => { sent.push(args[4]); return { status: 200, text: '{"refused":{"code":"not_found","message":"workload not configured: demo"}}' }; };
    const invoke = routerInvoker(never, { current: async () => ({ connection: { project: 'dormeto-host' } as never, google: { request } }), env: 'dev' });
    expect(await invoke(GCP, { action: 'nap', workloadId: 'demo' }, { async: true })).toBeNull();
    expect(sent).toEqual([{ action: 'nap', workloadId: 'demo', refusals: true }]);
  });
});
