// A run with the perimeter's standalone scan (vision standalone workloads design §6): the scan asked for it, a region with
// no load balancer scanned every run, what the scan could not read said in the run, and the candidates of a kind it could
// not read kept as they were.
import { describe, expect, it } from 'vitest';
import { runDiscovery } from '../src/run.js';
import type { StandaloneRule } from '../src/types.js';
import { A, config, filter } from './fixtures.js';
import { HOUR, setup } from './run-fakes.js';

const ARN = `arn:aws:rds:eu-west-1:${A.id}:db:shop-db`;
const db: StandaloneRule = {
  kind: 'standalone', id: ARN, account: A.id, region: 'eu-west-1', resourceArn: ARN, name: 'shop-db',
  backend: { kind: 'rds-instance', id: 'shop-db', arn: ARN }, tags: {}, eligibility: 'eligible', idleHours7d: null,
};
const PROBLEM = 'RDS instances not listed: the discovery role may not call rds:DescribeDBInstances (apply the access module or the AWS CLI script of this release again)';
const perimeter = (standalone?: 'on' | 'off') => config({ regions: ['eu-west-1'], filters: [filter('a', [{ accountIds: [A.id] }])], ...(standalone ? { standalone } : {}) });

describe('a run with the standalone scan', () => {
  it('asks each region\'s scan for standalone candidates only when the perimeter turns it on', async () => {
    for (const [standalone, asked] of [[undefined, false], ['off', false], ['on', true]] as const) {
      const s = setup({ cfg: perimeter(standalone) });
      await s.ready;
      const seen: boolean[] = [];
      s.deps.scan = async (_c, _where, options) => { seen.push(options?.standalone === true); return []; };
      await runDiscovery(s.deps, { source: 'manual' });
      expect(seen, String(standalone)).toEqual([asked]);
    }
  });

  it('scans a region with no load balancer every run while it is on', async () => {
    const s = setup({ cfg: perimeter('on') });
    await s.ready;
    let scans = 0;
    s.deps.scan = async () => { scans += 1; return []; };
    for (let run = 0; run < 5; run += 1) {
      await runDiscovery(s.deps, { source: 'manual' });
      s.advance(HOUR);
    }
    expect(scans).toBe(5);
  });

  it('says in the run what the scan could not read, and keeps the candidates of that kind as they were', async () => {
    const s = setup({ cfg: perimeter('on') });
    await s.ready;
    s.deps.scan = async () => [db];
    await runDiscovery(s.deps, { source: 'manual' });
    const [stored] = await s.store.accountCandidates(A.id);
    expect([stored!.id, stored!.status]).toEqual([ARN, 'pending-onboarding']);
    s.advance(HOUR);
    s.deps.scan = async (_c, _where, options) => {
      options?.onStandalone?.({ problems: [PROBLEM], unread: ['rds-instance', 'rds-cluster'] });
      return [];
    };
    const run = await runDiscovery(s.deps, { source: 'manual' });
    expect(run.targets).toEqual([{ account: A.id, region: 'eu-west-1', status: 'ok', ms: 0, rules: 0, problems: [PROBLEM] }]);
    expect(run.status).toBe('ok');
    expect((await s.store.accountCandidates(A.id)).map((c) => JSON.stringify(c))).toEqual([JSON.stringify(stored)]);
    expect((await s.store.getAccountScan(A.id))!.result!.pairs).toEqual([{ region: 'eu-west-1', ok: true, rules: 0, ms: 0, problems: [PROBLEM] }]);
  });

  it('decides the standalone candidates out of scope once it is turned off, without scanning for them', async () => {
    const s = setup({ cfg: perimeter('on') });
    await s.ready;
    s.deps.scan = async () => [db];
    await runDiscovery(s.deps, { source: 'manual' });
    await s.store.putConfig(perimeter('off'), 'admin@example.com');
    s.advance(HOUR);
    s.deps.scan = async () => [];
    await runDiscovery(s.deps, { source: 'manual' });
    const [c] = await s.store.accountCandidates(A.id);
    expect([c!.status, c!.statusReason, c!.goneAt]).toEqual(['out-of-scope', 'out of scope: the perimeter\'s standalone scan is off', undefined]);
  });
});
