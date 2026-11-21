// The causes of a standalone workload's history (plan 1's handover, Minor 9): the check's retry of a failed wake, and the
// starts and stops made outside Dormeto.
import { describe, expect, it } from 'vitest';
import { causeText } from '../src/history';

describe('a standalone workload\'s causes', () => {
  it('are said in words', () => {
    expect(causeText({ state: 'WAKING', cause: 'retry' })).toBe('a retry of the failed wake, by the check');
    expect(causeText({ state: 'AWAKE', cause: 'external-start' })).toBe('started outside Dormeto');
    expect(causeText({ state: 'ASLEEP', cause: 'external-stop' })).toBe('stopped outside Dormeto');
    expect(causeText({ state: 'AWAKE', cause: 'recovered' })).toBe('recovered, seen at a check');
  });
});
