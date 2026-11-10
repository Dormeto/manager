// The requests step's dispatch (handler.ts calls it): the Google form beside AWS's, the Google source read first so that
// an execution environment that has run no discovery step answers (final review C1).
import { describe, expect, it } from 'vitest';
import { createGoogleSource, type Google, type GoogleConnection } from '@dormeto/google';
import { requestsStep } from '../src/requests-step.js';
import type { RequestsPorts } from '../src/requests.js';

const NOW = Date.parse('2026-11-10T12:00:30.000Z');
const TO = Date.parse('2026-11-10T12:00:00.000Z');
const FROM = TO - 14 * 86_400_000;
const P = 'dormeto-dev';
const google = {
  account: P, region: 'europe-west2', days: 14, lb: { kind: 'global' },
  backendService: `projects/${P}/global/backendServices/dmt-demo-mig-app`,
  wakerBackendService: `projects/${P}/regions/europe-west2/backendServices/dmtr-europe-west2-waker`,
  urlMap: `projects/${P}/global/urlMaps/dmt-demo-mig-lb`,
};
const point = { interval: { startTime: new Date(FROM + 5 * 60_000).toISOString(), endTime: new Date(FROM + 6 * 60_000).toISOString() }, value: { int64Value: '3' } };

// A source as handler.ts builds it, over a record read from the table: cold (nothing kept) until it is read.
function source(record: GoogleConnection | null) {
  const urls: string[] = [];
  const instance = { call: async <T,>(sa: string, _method: string, url: string) => { urls.push(`${sa} ${url}`); return { timeSeries: [{ points: [point] }] } as T; } };
  return { urls, source: createGoogleSource({ read: async () => record, create: () => instance as unknown as Google }) };
}
const aws = (): never => { throw new Error('AWS ports were not asked'); };

describe('the requests step', () => {
  it('a cold Google source with a record answers: the record is read first', async () => {
    const s = source({ project: P } as unknown as GoogleConnection);
    const out = await requestsStep({ google: s.source, aws }, { step: 'requests', ...google }, NOW);
    expect(out).toMatchObject({ minutes: [[5, 3]], wakerTargetGroupArn: null });
    expect(s.urls[0]).toMatch(/^discovery https:\/\/monitoring\.googleapis\.com\/v3\/projects\/dormeto-dev\/timeSeries\?/);
  });

  it('without a record: an error naming dormeto gcp connect, not Monitoring', async () => {
    const s = source(null);
    const error = await requestsStep({ google: s.source, aws }, { step: 'requests', ...google }, NOW).catch((e: Error) => e);
    expect((error as Error).message).toContain('dormeto gcp connect');
    expect((error as Error).message).not.toContain('Monitoring');
    expect(s.urls).toEqual([]);
  });

  it('the AWS form reaches requestMinutes with the ports of its account and region', async () => {
    const asked: string[] = [];
    const ports: RequestsPorts = {
      elbv2: { describeTargetGroups: async () => ({ TargetGroups: [{ LoadBalancerArns: [] }] }), describeListeners: async () => ({}), describeRules: async () => ({}) } as never,
      cloudwatch: {} as never,
    };
    const s = source(null);
    const arn = 'arn:aws:elasticloadbalancing:eu-west-1:121014831971:targetgroup/a/b';
    // The target group is on no load balancer: requestMinutes's own error proves it was reached.
    await expect(requestsStep({ google: s.source, aws: async (account, region) => { asked.push(`${account} ${region}`); return ports; } },
      { step: 'requests', account: '121014831971', region: 'eu-west-1', targetGroupArn: arn, days: 14 }, NOW)).rejects.toThrow('the target group is not attached to a load balancer');
    expect(asked).toEqual(['121014831971 eu-west-1']);
  });

  it('an AWS event without its target group has its own refusal, not the Google form\'s', async () => {
    const s = source(null);
    const error = await requestsStep({ google: s.source, aws }, { step: 'requests', account: '121014831971', region: 'eu-west-1', days: 14 }, NOW).catch((e: Error) => e);
    expect((error as Error).message).toContain('a target group ARN');
    expect((error as Error).message).not.toContain('Google Cloud');
  });
});
