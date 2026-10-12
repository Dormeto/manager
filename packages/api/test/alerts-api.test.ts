import { describe, expect, it } from 'vitest';
import { createApi, type ApiEvent } from '../src/api.js';
import type { Alarm } from '../src/watchdog.js';

const NOW = Date.UTC(2026, 9, 8, 12, 0);
const at = new Date(NOW - 600_000).toISOString();
const alarm = (id: string, level: Alarm['level'], account?: string, region?: string): Alarm => ({
  subject: { id, kind: account ? 'router' : 'list', name: id, account, region }, level, since: at,
  problems: [{ code: 'silent', level: level === 'ok' ? 'warning' : level, text: 'no report received', hint: 'h', since: at }], notified: ['silent'], cleared: {},
});
const ALARMS = [alarm('router#121014831971#eu-west-1', 'error', '121014831971', 'eu-west-1'), alarm('router#038606077307#eu-west-3', 'warning', '038606077307', 'eu-west-3'), alarm('list#ipsum', 'warning')];
const SUBSCRIPTIONS = [
  { protocol: 'email', endpoint: 'fabrice@example.com', pending: false },
  { protocol: 'email', endpoint: 'ops@example.org', pending: true },
  { protocol: 'sqs', endpoint: 'arn:aws:sqs:eu-west-1:121014831971:alerts-test', pending: false },
];

function setup(visible = (_: unknown, item: { account?: string }) => item.account !== '038606077307') {
  return createApi({
    routers: [], invoke: async () => null, audit: { write: async () => {}, list: async () => [] }, now: () => NOW, version: '0.4.0',
    alerts: { open: async () => ALARMS, subscriptions: async () => ({ topicArn: 'arn:aws:sns:eu-west-1:121014831971:dmt-dev-manager-alerts', subscriptions: SUBSCRIPTIONS }) },
    visible,
  });
}
const event = (groups: string): ApiEvent => ({
  rawPath: '/api/alerts', requestContext: { http: { method: 'GET' }, authorizer: { jwt: { claims: { sub: 'u', email: 'u@example.com', 'cognito:groups': `[${groups}]` } } } },
});
const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');

describe('alerts', () => {
  it('gives the open alarms the caller may see, and the subscriptions counted', async () => {
    const res = json(await setup()(event('dmt-viewer')));
    expect(res.alarms.map((a: { id: string }) => a.id)).toEqual(['router#121014831971#eu-west-1', 'list#ipsum']);
    expect(res.alarms[0]).toEqual({
      id: 'router#121014831971#eu-west-1', kind: 'router', name: 'router#121014831971#eu-west-1', account: '121014831971', region: 'eu-west-1',
      level: 'error', since: at, problems: [{ code: 'silent', level: 'error', text: 'no report received', hint: 'h', since: at }],
    });
    expect(res.notifications).toEqual({ topicArn: 'arn:aws:sns:eu-west-1:121014831971:dmt-dev-manager-alerts', confirmed: 2, pending: 1 });
  });

  it('shows administrators where alerts go, the addresses masked', async () => {
    const res = json(await setup()(event('dmt-admin')));
    expect(res.notifications.endpoints).toEqual([
      { protocol: 'email', endpoint: 'f…@example.com', pending: false },
      { protocol: 'email', endpoint: 'o…@example.org', pending: true },
      { protocol: 'sqs', endpoint: 'alerts-test', pending: false },
    ]);
  });

  it('answers without alarms when the manager has no watchdog', async () => {
    const api = createApi({ routers: [], invoke: async () => null, audit: { write: async () => {}, list: async () => [] }, version: '0.4.0' });
    expect(json(await api(event('dmt-viewer')))).toEqual({ alarms: [], notifications: null });
  });
});
