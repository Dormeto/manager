import { describe, expect, it } from 'vitest';
import { scanRegion } from '../src/scan.js';
import type { ScannedRule } from '../src/types.js';
import { RULES, TGS, scanPorts } from './scan-fakes.js';

const NOW = () => Date.UTC(2026, 9, 4, 12, 30);
const WHERE = { account: '111122223333', region: 'eu-west-1' };
const byId = (rules: ScannedRule[]) => Object.fromEntries(rules.map((r) => [r.id, r]));

describe('scanRegion', () => {
  it('lists every rule of the application load balancers with its eligibility', async () => {
    const rules = byId(await scanRegion(scanPorts().ports, WHERE, { now: NOW }));
    expect('r-admin' in rules).toBe(false);
    expect(Object.keys(rules)).toHaveLength(13);
    expect([rules['r-demo']!.eligibility, rules['r-demo']!.workloadId]).toEqual(['managed', 'demo']);
    expect([rules['r-shop']!.eligibility, rules['r-shop']!.backend]).toEqual(['eligible', { kind: 'instance', id: 'i-shop' }]);
    expect(rules['r-api']!.backend).toEqual({ kind: 'ecs', id: 'arn:aws:ecs:eu-west-1:111122223333:service/main/api' });
    expect(rules['r-batch']!.backend).toEqual({ kind: 'asg', id: 'batch-asg' });
    const reasons = Object.fromEntries(Object.values(rules).filter((r) => r.eligibility === 'ineligible').map((r) => [r.id, r.reason]));
    expect(reasons).toEqual({
      r80: 'redirect action',
      'r-canary': 'weighted forward to several target groups',
      'r-fn': 'Lambda target group',
      'r-shared-1': 'target group shared by 2 rules',
      'r-shared-2': 'target group shared by 2 rules',
      'r-orphan': 'IP targets without an ECS service',
      'r-empty': 'no backend: no registered target, Auto Scaling group or ECS service',
      'r-fixed': 'fixed response',
      'r-default': 'fixed response',
    });
  });

  it('stamps the account and region, and describes listener, conditions, target group and suggested id', async () => {
    const rules = byId(await scanRegion(scanPorts().ports, WHERE, { now: NOW }));
    const shop = rules['r-shop']!;
    expect([shop.account, shop.region]).toEqual(['111122223333', 'eu-west-1']);
    expect({ lb: shop.loadBalancer, listener: shop.listener, priority: shop.priority, conditions: shop.conditions, tg: shop.targetGroup, id: shop.suggestedId })
      .toEqual({ lb: 'web', listener: 'HTTPS:443', priority: '20', conditions: 'host shop.example.com | www.shop.example.com', tg: 'shop', id: 'shop' });
    expect(rules['r-api']!.conditions).toBe('path /api/*');
    expect(rules['r-default']!.conditions).toBe('default');
  });

  it('extracts the host names of host-header conditions, in both condition formats', async () => {
    const rules = byId(await scanRegion(scanPorts().ports, WHERE, { now: NOW }));
    expect(rules['r-shop']!.hosts).toEqual(['shop.example.com', 'www.shop.example.com']);
    expect(rules['r-batch']!.hosts).toEqual(['batch.example.com']);
    expect(rules['r-api']!.hosts).toEqual([]);
  });

  it('keeps every value a tag has on the load balancer, the target group or the rule', async () => {
    const { ports, calls } = scanPorts();
    const rules = byId(await scanRegion(ports, WHERE, { now: NOW }));
    expect(rules['r-shop']!.tags).toEqual({ env: ['dev', 'preview'], team: ['web', 'shop'] });
    expect(rules['r-api']!.tags).toEqual({ env: ['dev'], team: ['web'] });
    expect(calls.tagBatches.every((n) => n <= 20)).toBe(true);
  });

  it('counts the idle hours of the last 7 days for eligible and managed target groups only', async () => {
    const { ports, calls } = scanPorts({ hourly: { 'targetgroup/shop/1': [5, 0, 3], 'targetgroup/demo-app/1': [] } });
    const rules = byId(await scanRegion(ports, WHERE, { now: NOW }));
    expect([rules['r-shop']!.idleHours7d, rules['r-shop']!.requests7d]).toEqual([166, 8]);
    expect([rules['r-demo']!.idleHours7d, rules['r-demo']!.requests7d]).toEqual([168, 0]);
    expect(rules['r-fn']!.idleHours7d).toBeNull();
    expect(calls.metricQueries).toBe(4);
  });

  it('gives a managed rule the backend of its application target group, for backend type filters', async () => {
    const rules = byId(await scanRegion(scanPorts().ports, WHERE, { now: NOW }));
    expect(rules['r-demo']!.backend).toEqual({ kind: 'instance', id: 'i-demo' });
  });

  it('reports a managed rule that became ineligible, with the reason', async () => {
    const rule = RULES[Object.keys(RULES)[1]!]![0]!;
    const awake = rule.Actions;
    rule.Actions = [{ Type: 'redirect', Order: 1 }];
    try {
      const rules = byId(await scanRegion(scanPorts().ports, WHERE, { now: NOW }));
      expect([rules['r-demo']!.eligibility, rules['r-demo']!.reason]).toEqual(['managed', 'redirect action']);
    } finally {
      rule.Actions = awake;
    }
    const healthy = byId(await scanRegion(scanPorts().ports, WHERE, { now: NOW }));
    expect(healthy['r-demo']!.reason).toBeUndefined();
  });

  it('reports the application target group of a sleeping managed workload, not the waker', async () => {
    const rule = RULES[Object.keys(RULES)[1]!]![0]!;
    const awake = rule.Actions;
    rule.Actions = [{ Type: 'forward', Order: 1, ForwardConfig: { TargetGroups: [{ TargetGroupArn: TGS.demo!.TargetGroupArn, Weight: 0 }, { TargetGroupArn: TGS.waker!.TargetGroupArn, Weight: 1 }] } }];
    try {
      const rules = byId(await scanRegion(scanPorts().ports, WHERE, { now: NOW }));
      expect(rules['r-demo']!.targetGroup).toBe('demo-app');
      expect(rules['r-demo']!.suggestedId).toBeNull();
    } finally {
      rule.Actions = awake;
    }
  });
});
