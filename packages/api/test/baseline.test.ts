import { describe, expect, it } from 'vitest';
import { baselineOf } from '../src/baseline.js';

describe('savings baseline (R9b)', () => {
  it('always by default; business hours in their time zone, UTC when none', () => {
    expect(baselineOf(undefined, undefined)).toEqual({ kind: 'always' });
    expect(baselineOf('business-hours', 'Europe/Paris')).toEqual({ kind: 'business-hours', timeZone: 'Europe/Paris' });
    expect(baselineOf('business-hours', '')).toEqual({ kind: 'business-hours', timeZone: 'UTC' });
  });
});
