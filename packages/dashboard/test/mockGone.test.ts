import { describe, expect, it } from 'vitest';
import { decide, state } from '../src/mock/state';

// The demo's copy of discovery's status rule (packages/discovery/src/lifecycle.ts): a managed candidate gone names what it was.
describe('the demo\'s gone candidates', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const gone = (cloud: 'aws' | 'gcp') => {
    const d = state();
    const c = d.candidates.find((x) => (cloud === 'gcp' ? x.cloud === 'gcp' : x.cloud !== 'gcp') && x.eligibility === 'managed')!;
    return decide(d, { ...c, goneAt: new Date(now - 3600_000).toISOString() }, now).statusReason;
  };

  it('says a Google Cloud backend service for a managed Google Cloud candidate', () => {
    expect(gone('gcp')).toBe('managed backend service not found in the last scan: offboard it');
  });

  it('keeps AWS\'s rule', () => {
    expect(gone('aws')).toBe('managed rule not found in the last scan: offboard it');
  });
});
