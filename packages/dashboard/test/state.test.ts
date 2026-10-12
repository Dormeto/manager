import { describe, expect, it } from 'vitest';
import { stateHelp, stateSince } from '../src/state';

const run = { awakeSince: '2026-10-07T21:20:00.000Z', wakeStartedAt: '2026-10-07T21:18:00.000Z', failedAt: '2026-10-06T10:00:00.000Z', updatedAt: '2026-10-07T21:50:00.000Z' };

describe('workload state', () => {
  it('dates a state from the time that belongs to it, never from the last write of an awake workload', () => {
    expect(stateSince({ ...run, state: 'AWAKE' })).toEqual({ label: 'Awake since', at: run.awakeSince });
    expect(stateSince({ ...run, state: 'WAKING' })).toEqual({ label: 'Waking since', at: run.wakeStartedAt });
    expect(stateSince({ ...run, state: 'FAILED' })).toEqual({ label: 'Failed since', at: run.failedAt });
    // Napping or asleep, the last write is the change to that state (a nap writes nothing more until a wake).
    expect(stateSince({ ...run, state: 'NAPPING' })).toEqual({ label: 'Napping since', at: run.updatedAt });
    expect(stateSince({ ...run, state: 'ASLEEP' })).toEqual({ label: 'Asleep since', at: run.updatedAt });
    expect(stateSince({ ...run, state: 'UNKNOWN' })).toEqual({ label: 'State since', at: null });
  });

  it('explains each state', () => {
    expect(stateHelp('AWAKE')).toMatch(/^Awake: requests go to the application/);
    expect(stateHelp('NAPPING')).toMatch(/^Napping: /);
    expect(stateHelp('ASLEEP')).toMatch(/^Asleep: .*the next request wakes it/);
    expect(stateHelp('WAKING')).toMatch(/^Waking: /);
    expect(stateHelp('FAILED')).toMatch(/^Failed: /);
    expect(stateHelp('UNKNOWN')).toMatch(/^Unknown: /);
  });
});
