// The connections of a discovery run (packaging design §5; R5c review I3): the state machine passes the run's id, the
// operations read its lists from the discovery store.
import { describe, expect, it } from 'vitest';
import { runConnections } from '../src/connections.js';

describe('the connections task', () => {
  it('reads the run\'s lists and creates their operations; an unknown run creates nothing', async () => {
    const asked: unknown[] = [];
    const engine = { connections: async (lists: unknown, by: string) => { asked.push([lists, by]); return { created: ['op1'], skipped: [] }; } };
    const lists = { connect: [{ account: '222222222222', regions: ['eu-west-1'] }], disconnect: ['333333333333'] };
    const store = { getRun: async (id: string) => (id === 'r1' ? { connections: lists } : null) } as never;
    expect(await runConnections(store, engine, 'r1')).toEqual({ created: ['op1'], skipped: [] });
    expect(asked).toEqual([[lists, 'discovery']]);
    expect(await runConnections(store, engine, 'r2')).toEqual({ created: [], skipped: [] });
    expect(asked).toHaveLength(1);
  });
});
