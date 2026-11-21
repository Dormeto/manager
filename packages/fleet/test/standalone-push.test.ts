// The organization's settings as the fleet function pushes them to a Google Cloud router (its checks' ETag, the watchdog's
// probe): without the idle signals, which a Google Cloud router has none of yet (vision standalone workloads design §6, §11).
import { describe, expect, it } from 'vitest';
import { settingsDocument } from '../src/settings-json.js';
import { withoutIdleSignals } from '../src/idle-signals.js';

const METRIC = { namespace: 'Custom/Jobs', name: 'Queue', dimensions: { Instance: '${resource}' }, statistic: 'Maximum', below: 1 };
const DOC = {
  workloads: { hibernate: false, defaults: { idleMinutes: 30, idleCpuPercent: 3 }, types: [{ name: 'ecs', settings: { idleMetric: METRIC, idleNetworkBytes: 'off', waitSeconds: 20 } }, { name: 'api', tags: { k: 'v' } }] },
  waitingPage: { mode: 'template' },
};

describe('the settings pushed to a Google Cloud router', () => {
  it('hold no idle signal, everything else as the file holds it, with its ETag', async () => {
    const doc = await settingsDocument({ read: async () => ({ etag: '"e1"', text: JSON.stringify(DOC) }) });
    expect(doc).toEqual({
      etag: '"e1"',
      settings: { workloads: { hibernate: false, defaults: { idleMinutes: 30 }, types: [{ name: 'ecs', settings: { waitSeconds: 20 } }, { name: 'api', tags: { k: 'v' } }] }, waitingPage: { mode: 'template' } },
    });
  });

  it('leave a file that is not JSON, or holds none, as it is', async () => {
    expect(await settingsDocument({ read: async () => ({ etag: '"e2"', text: 'not json' }) })).toEqual({ etag: '"e2"', settings: 'not json' });
    expect(withoutIdleSignals({ updatedAt: 'x' })).toEqual({ updatedAt: 'x' });
  });
});
