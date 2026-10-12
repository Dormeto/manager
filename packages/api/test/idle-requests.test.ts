// The idle window advisor's requests (R10): the API invokes the discovery function's step requests.
import { describe, expect, it } from 'vitest';
import { BUSY, createIdleRequests } from '../src/idle-requests.js';

const answer = { from: '2026-09-26T12:00:00.000Z', to: '2026-10-10T12:00:00.000Z', minutes: [[3, 2]], wakerTargetGroupArn: null };
const payload = (value: unknown) => new Uint8Array(Buffer.from(JSON.stringify(value)));

describe('the discovery function\'s requests, from the API', () => {
  it('asks its step requests and answers what it returns', async () => {
    const sent: { FunctionName: string; Payload: Uint8Array }[] = [];
    const requests = createIdleRequests({ functionName: 'dmt-dev-manager-discovery', invoke: async (input) => { sent.push(input); return { Payload: payload(answer) }; } });
    expect(await requests('121014831971', 'eu-west-1', 'arn:tg', 14)).toEqual(answer);
    expect(sent[0]!.FunctionName).toBe('dmt-dev-manager-discovery');
    expect(JSON.parse(Buffer.from(sent[0]!.Payload).toString('utf8'))).toEqual({ step: 'requests', account: '121014831971', region: 'eu-west-1', targetGroupArn: 'arn:tg', days: 14 });
  });

  it('a function error is said with its message', async () => {
    const requests = createIdleRequests({ functionName: 'f', invoke: async () => ({ FunctionError: 'Unhandled', Payload: payload({ errorMessage: 'the target group is not attached to a load balancer' }) }) });
    await expect(requests('1', 'eu-west-1', 'arn:tg', 14)).rejects.toThrow('the target group is not attached to a load balancer');
  });

  it('the function busy (a discovery run uses its reserved executions): try again later', async () => {
    const requests = createIdleRequests({ functionName: 'f', invoke: async () => { throw Object.assign(new Error('Rate Exceeded.'), { name: 'TooManyRequestsException' }); } });
    await expect(requests('1', 'eu-west-1', 'arn:tg', 14)).rejects.toThrow(BUSY);
    expect(BUSY).toContain('try again in a few minutes');
  });
});
