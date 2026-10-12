// What a workload's backends cost and save (user request): its last nap's items, priced by the API, matched to its
// backends by kind; a month is 730 hours, saved at the share of the last 30 days asleep within the baseline.
import { describe, expect, it } from 'vitest';
import { backendCost, monthlySaving } from '../src/costs';
import type { Costs } from '../src/types';

const SHOP = 'arn:aws:ecs:eu-west-3:111122223333:service/main/shop';
const costs: Costs = {
  baseline: { kind: 'always' }, from: '2026-09-09T12:00:00.000Z', to: '2026-10-09T12:00:00.000Z', napAt: '2026-10-09T04:51:00.000Z', savedShare: 0.9,
  items: [
    { item: { kind: 'fargate', vcpu: 0.25, memoryGb: 0.5, count: 1, arch: 'arm64', os: 'Linux' }, hourly: 0.009875 },
    { item: { kind: 'rds', class: 'db.t4g.micro', engine: 'postgres', multiAz: false }, hourly: 0.017 },
  ],
  saved: { usd: 3.2, hours: 600, unpricedHours: 0 },
};
const backends = [{ kind: 'ecs', id: SHOP }, { kind: 'rds-instance', id: 'shop-db' }];

describe('costs', () => {
  it('gives each backend its hourly and monthly list price, and its saving a month at the last 30 days\' rate', () => {
    const db = backendCost(backends[1]!, backends, costs)!;
    expect([db.hourly, db.shared, db.unpriced]).toEqual([0.017, 1, []]);
    expect(db.monthly).toBeCloseTo(12.41, 6);
    expect(db.savedMonthly).toBeCloseTo(11.169, 6);
    expect(backendCost(backends[0]!, backends, costs)!.monthly).toBeCloseTo(7.20875, 6);
    expect(monthlySaving(costs)).toBeCloseTo((0.009875 + 0.017) * 730 * 0.9, 6);
  });

  it('says what is not priced, and shares a price among backends of a kind it cannot tell apart', () => {
    const more: Costs = { ...costs, items: [
      { item: { kind: 'ec2', type: 'm5.large', count: 2, os: 'Windows' }, hourly: null },
      { item: { kind: 'ec2', type: 't3.medium', count: 1, os: 'Linux' }, hourly: 0.0456 },
      { item: { kind: 'unknown', backend: `ecs:${SHOP}`, reason: 'AccessDenied' }, hourly: null },
    ] };
    const two = [{ kind: 'instance', id: 'i-1' }, { kind: 'asg', id: 'web' }, { kind: 'ecs', id: SHOP }];
    const web = backendCost(two[1]!, two, more)!;
    expect([web.hourly, web.shared, web.unpriced]).toEqual([0.0456, 2, ['2 × m5.large (Windows)']]);
    expect(backendCost(two[2]!, two, more)).toMatchObject({ hourly: null, monthly: null, savedMonthly: null, unpriced: ['AccessDenied'] });
  });

  it('knows nothing before a nap said what it stopped', () => {
    expect(backendCost(backends[1]!, backends, undefined)).toBeNull();
    expect(backendCost(backends[1]!, backends, { ...costs, items: [], napAt: null })).toBeNull();
    expect(monthlySaving({ ...costs, items: [] })).toBeNull();
    expect(monthlySaving({ ...costs, savedShare: null })).toBeNull();
  });
});
