import { describe, expect, it } from 'vitest';
import { scanRegion } from '../src/scan.js';
import type { ScannedRule } from '../src/types.js';
import { RULES, TGS, scanPorts } from './scan-fakes.js';

const NOW = () => Date.UTC(2026, 9, 4, 12, 30);
const WHERE = { account: '111122223333', region: 'eu-west-1' };
// Target group candidates by target group name, rule candidates by rule ARN.
const byKey = (candidates: ScannedRule[]): Record<string, ScannedRule> =>
  Object.fromEntries(candidates.map((c) => [c.id.includes(':targetgroup/') ? c.targetGroup ?? c.id : c.id, c]));

describe('scanRegion', () => {
  it('gives one candidate per application target group, and one per rule that forwards to none', async () => {
    const found = byKey(await scanRegion(scanPorts().ports, WHERE, { now: NOW }));
    expect(Object.keys(found).sort()).toEqual(['api', 'batch', 'demo-app', 'empty', 'orphan', 'r-canary', 'r-default', 'r-fixed', 'r-fn', 'r80', 'shared', 'shop']);
    expect([found['demo-app']!.eligibility, found['demo-app']!.workloadId]).toEqual(['managed', 'demo']);
    expect([found.shop!.eligibility, found.shop!.backend]).toEqual(['eligible', { kind: 'instance', id: 'i-shop' }]);
    expect(found.api!.backend).toEqual({ kind: 'ecs', id: 'arn:aws:ecs:eu-west-1:111122223333:service/main/api' });
    expect(found.batch!.backend).toEqual({ kind: 'asg', id: 'batch-asg' });
    expect([found.shared!.eligibility, found.shared!.rules.map((r) => r.id)]).toEqual(['eligible', ['r-shared-1', 'r-shared-2']]);
    const reasons = Object.fromEntries(Object.entries(found).filter(([, c]) => c.eligibility === 'ineligible').map(([k, c]) => [k, c.reason]));
    expect(reasons).toEqual({
      r80: 'redirect action',
      'r-canary': 'weighted forward to several target groups',
      'r-fn': 'Lambda target group',
      orphan: 'IP targets without an ECS service',
      empty: 'no backend: no registered target, Auto Scaling group or ECS service',
      'r-fixed': 'fixed response',
      'r-default': 'fixed response',
    });
    expect('r-admin' in found).toBe(false);
  });

  it('stamps the account and region, and describes listener, conditions, target group and suggested id', async () => {
    const found = byKey(await scanRegion(scanPorts().ports, WHERE, { now: NOW }));
    const shop = found.shop!;
    expect([shop.id, shop.account, shop.region]).toEqual([TGS.shop!.TargetGroupArn, '111122223333', 'eu-west-1']);
    expect({ lb: shop.loadBalancer, listener: shop.listener, priority: shop.priority, conditions: shop.conditions, tg: shop.targetGroup, id: shop.suggestedId })
      .toEqual({ lb: 'web', listener: 'HTTPS:443', priority: '20', conditions: 'host shop.example.com | www.shop.example.com', tg: 'shop', id: 'shop' });
    expect(found.shared!.conditions).toBe('host a.example.com (+1 rules)');
    expect(found.api!.conditions).toBe('path /api/*');
    expect(found['r-default']!.conditions).toBe('default');
  });

  it('extracts the host names of host-header conditions, in both condition formats', async () => {
    const found = byKey(await scanRegion(scanPorts().ports, WHERE, { now: NOW }));
    expect(found.shop!.hosts).toEqual(['shop.example.com', 'www.shop.example.com']);
    expect(found.batch!.hosts).toEqual(['batch.example.com']);
    expect(found.shared!.hosts).toEqual(['a.example.com', 'b.example.com']);
    expect(found.api!.hosts).toEqual([]);
  });

  it('keeps every value a tag has on the load balancer, the target group or the rules', async () => {
    const { ports, calls } = scanPorts();
    const found = byKey(await scanRegion(ports, WHERE, { now: NOW }));
    expect(found.shop!.tags).toEqual({ env: ['dev', 'preview'], team: ['web', 'shop'] });
    expect(found.api!.tags).toEqual({ env: ['dev'], team: ['web'] });
    expect(calls.tagBatches.every((n) => n <= 20)).toBe(true);
  });

  it('counts the idle hours of the last 7 days for eligible and managed target groups only', async () => {
    const { ports, calls } = scanPorts({ hourly: { 'targetgroup/shop/1': [5, 0, 3], 'targetgroup/demo-app/1': [] } });
    const found = byKey(await scanRegion(ports, WHERE, { now: NOW }));
    expect([found.shop!.idleHours7d, found.shop!.requests7d]).toEqual([166, 8]);
    expect([found['demo-app']!.idleHours7d, found['demo-app']!.requests7d]).toEqual([168, 0]);
    expect(found['r-fn']!.idleHours7d).toBeNull();
    expect(calls.metricQueries).toBe(5);
  });

  it('gives a managed group the backend of its application target group, for backend type filters', async () => {
    const found = byKey(await scanRegion(scanPorts().ports, WHERE, { now: NOW }));
    expect(found['demo-app']!.backend).toEqual({ kind: 'instance', id: 'i-demo' });
    expect(found['demo-app']!.reason).toBeUndefined();
  });

  it('reports a managed rule that no longer forwards to its application, with the reason', async () => {
    const rule = RULES[Object.keys(RULES)[1]!]![0]!;
    const awake = rule.Actions;
    rule.Actions = [{ Type: 'redirect', Order: 1 }];
    try {
      const found = byKey(await scanRegion(scanPorts().ports, WHERE, { now: NOW }));
      expect([found['r-demo']!.eligibility, found['r-demo']!.workloadId, found['r-demo']!.reason]).toEqual(['managed', 'demo', 'redirect action']);
    } finally {
      rule.Actions = awake;
    }
  });

  it('reports the application target group of a sleeping managed workload, not the waker', async () => {
    const rule = RULES[Object.keys(RULES)[1]!]![0]!;
    const awake = rule.Actions;
    rule.Actions = [{ Type: 'forward', Order: 1, ForwardConfig: { TargetGroups: [{ TargetGroupArn: TGS.demo!.TargetGroupArn, Weight: 0 }, { TargetGroupArn: TGS.waker!.TargetGroupArn, Weight: 1 }] } }];
    try {
      const found = byKey(await scanRegion(scanPorts().ports, WHERE, { now: NOW }));
      expect([found['demo-app']!.targetGroup, found['demo-app']!.suggestedId, found['demo-app']!.eligibility]).toEqual(['demo-app', null, 'managed']);
    } finally {
      rule.Actions = awake;
    }
  });
});
