// A period's savings (R9b): each ASLEEP phase's hours within the baseline × the hourly prices of what it stopped.
import { describe, expect, it } from 'vitest';
import { baselineHours, savingsOf } from '../src/savings.js';
import type { StoppedItem } from '../src/prices.js';

const T3: StoppedItem = { kind: 'ec2', type: 't3.medium', count: 1, os: 'Linux' };
const DB: StoppedItem = { kind: 'rds', class: 'db.t4g.micro', engine: 'postgres', multiAz: false };
const hourly = async (item: StoppedItem) => (item.kind === 'ec2' ? 0.0456 : item.kind === 'rds' ? 0.017 : null);
const PARIS = { kind: 'business-hours' as const, timeZone: 'Europe/Paris' };

describe('baseline hours', () => {
  it('always: every hour', () => {
    expect(baselineHours('2026-10-08T00:00:00.000Z', '2026-10-08T10:00:00.000Z', { kind: 'always' })).toBe(10);
  });

  it('business hours: weekdays 08:00 to 20:00 in its time zone, across a weekend', () => {
    // Friday 18:00 to Monday 10:00 in Paris (UTC+2): Friday 18-20 and Monday 08-10.
    expect(baselineHours('2026-10-09T16:00:00.000Z', '2026-10-12T08:00:00.000Z', PARIS)).toBeCloseTo(4, 6);
  });

  it('business hours follow a daylight-saving change (Paris back to UTC+1 on 25 October 2026)', () => {
    // Monday 26 October 07:30 to 08:30 in Paris is 06:30 to 07:30 UTC: half an hour of business.
    expect(baselineHours('2026-10-26T06:30:00.000Z', '2026-10-26T07:30:00.000Z', PARIS)).toBeCloseTo(0.5, 6);
    // The Monday before (UTC+2), the same UTC hour is 08:30 to 09:30 in Paris: a whole hour.
    expect(baselineHours('2026-10-19T06:30:00.000Z', '2026-10-19T07:30:00.000Z', PARIS)).toBeCloseTo(1, 6);
  });
});

describe('savings of a period', () => {
  it('prices each asleep phase\'s hours by what it stopped, the items summed', async () => {
    const s = await savingsOf([
      { state: 'AWAKE', from: '2026-10-08T00:00:00.000Z', to: '2026-10-08T02:00:00.000Z' },
      { state: 'ASLEEP', from: '2026-10-08T02:00:00.000Z', to: '2026-10-08T12:00:00.000Z', stopped: [T3, DB] },
      { state: 'ASLEEP', from: '2026-10-08T14:00:00.000Z', to: '2026-10-08T16:00:00.000Z', stopped: [T3] },
    ], { hourly, baseline: { kind: 'always' } });
    expect(s.usd).toBeCloseTo(12 * 0.0456 + 10 * 0.017, 6);
    expect(s.hours).toBe(12);
    expect(s.items.map((i) => [i.item.kind, i.hours])).toEqual([['ec2', 12], ['rds', 10]]);
    expect(s.unpriced).toEqual([]);
  });

  it('says what it could not price, never as nothing saved: no stopped (router before 0.27.0), an unknown item', async () => {
    const s = await savingsOf([
      { state: 'ASLEEP', from: '2026-10-08T00:00:00.000Z', to: '2026-10-08T05:00:00.000Z' },
      { state: 'ASLEEP', from: '2026-10-08T06:00:00.000Z', to: '2026-10-08T08:00:00.000Z', stopped: [T3, { kind: 'unknown', backend: 'ecs:web', reason: 'denied' }] },
    ], { hourly, baseline: { kind: 'always' } });
    expect(s.usd).toBeCloseTo(2 * 0.0456, 6);
    expect(s.unpriced).toEqual([{ reason: 'not described (a router before 0.27.0)', hours: 5 }, { reason: 'not priced', item: { kind: 'unknown', backend: 'ecs:web', reason: 'denied' }, hours: 2 }]);
  });

  it('counts only the baseline\'s hours', async () => {
    const s = await savingsOf([{ state: 'ASLEEP', from: '2026-10-09T16:00:00.000Z', to: '2026-10-12T08:00:00.000Z', stopped: [T3] }], { hourly, baseline: PARIS });
    expect(s.hours).toBeCloseTo(4, 6);
    expect(s.usd).toBeCloseTo(4 * 0.0456, 6);
  });
});
