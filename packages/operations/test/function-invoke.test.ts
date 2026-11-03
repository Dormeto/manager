// The engine's calls of a router's functions (vision refusals design §1): refusals asked as answers, read back as the
// errors its steps already handle, with their message and code.
import { describe, expect, it } from 'vitest';
import { functionInvoker } from '../src/aws.js';

const ARN = 'arn:aws:lambda:eu-west-3:111122223333:function:dmtr-dev-controller';
const answering = (value: unknown, functionError?: string) => {
  const sent: { FunctionName: string; Payload: Uint8Array }[] = [];
  const invoke = functionInvoker(async (input) => {
    sent.push(input);
    return { Payload: new Uint8Array(Buffer.from(JSON.stringify(value))), ...(functionError ? { FunctionError: functionError } : {}) };
  });
  return { invoke, sent, payload: () => JSON.parse(Buffer.from(sent[0]!.Payload).toString()) };
};

describe('a router function, from the operations engine', () => {
  it('asks for refusals as answers and gives back the answer', async () => {
    const { invoke, sent, payload } = answering({ state: 'AWAKE' });
    expect(await invoke(ARN, { action: 'status', workloadId: 'demo' })).toEqual({ state: 'AWAKE' });
    expect([sent[0]!.FunctionName, payload()]).toEqual([ARN, { action: 'status', workloadId: 'demo', refusals: true }]);
  });

  it('throws a refusal as an error with its message and code', async () => {
    const { invoke } = answering({ refused: { code: 'not_found', message: 'workload not configured: demo' } });
    const err = await invoke(ARN, { action: 'status', workloadId: 'demo' }).catch((e: unknown) => e) as Error & { code?: string };
    expect([err instanceof Error, err.message, err.code]).toEqual([true, 'workload not configured: demo', 'not_found']);
  });

  it('throws a function error with its message, as before', async () => {
    const { invoke } = answering({ errorType: 'Error', errorMessage: 'unknown action: report' }, 'Unhandled');
    await expect(invoke(ARN, { action: 'report', workloadId: 'demo' })).rejects.toThrow(/^unknown action: report$/);
  });
});
