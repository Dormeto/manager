import { describe, expect, it } from 'vitest';
import { createProxyPrefixes, proxyPrefixOf } from '../src/proxy-prefix.js';

const WHERE = { account: '111122223333', region: 'eu-west-1' };
const terraform = [{ name: 'dmt-dev', region: 'eu-west-1', controller: 'dmt-dev-controller', account: '111122223333' }];
const installed = [{ name: 'dmtr-dev', account: '444455556666', region: 'eu-west-3', controller: 'arn:aws:lambda:eu-west-3:444455556666:function:dmtr-dev-controller', version: '0.33.0' }];
const records = { listRouters: async () => installed as never };

describe('the proxies\' function name prefix of an account and region', () => {
  it('a router written in Terraform: its name and -kube-', async () => {
    expect(await proxyPrefixOf(terraform, records, WHERE)).toBe('dmt-dev-kube-');
  });
  it('an installed router', async () => {
    expect(await proxyPrefixOf([], records, { account: '444455556666', region: 'eu-west-3' })).toBe('dmtr-dev-kube-');
  });
  it('no router there: none', async () => {
    expect(await proxyPrefixOf(terraform, records, { account: '111122223333', region: 'eu-west-3' })).toBeNull();
  });

  // Ruling 26 (spec section 5, "installed or reporting"): a router written in Terraform in a member account that reports to
  // the manager (its summary in the fleet store) without being in ROUTERS.
  it('a router that reports to the manager, in neither ROUTERS nor the installed ones: its name and -kube-', async () => {
    const now = Date.parse('2026-10-24T12:00:00Z');
    const summary = (checkedAt: string) => ({ account: '777788889999', region: 'eu-central-1', name: 'dmt-prod', checkSchedule: 'cron(0/5 * * * ? *)', checkedAt });
    const where = { account: '777788889999', region: 'eu-central-1' };
    expect(await proxyPrefixOf(terraform, records, where, { reporting: [summary('2026-10-24T11:57:00Z')] as never, now })).toBe('dmt-prod-kube-');
    // One that stopped reporting (its last check more than 3 periods old) is not known as reporting.
    expect(await proxyPrefixOf(terraform, records, where, { reporting: [summary('2026-10-24T11:40:00Z')] as never, now })).toBeNull();
    // ROUTERS and the installed ones first.
    expect(await proxyPrefixOf(terraform, records, WHERE, { reporting: [{ ...summary('2026-10-24T11:57:00Z'), ...WHERE, name: 'other' }] as never, now })).toBe('dmt-dev-kube-');
  });
});

describe('the prefix lookup of the handler (isolated, cached a minute)', () => {
  const T = Date.parse('2026-10-24T12:00:00Z');
  const REPORTING = { account: '777788889999', region: 'eu-central-1', name: 'dmt-prod', checkSchedule: 'cron(0/5 * * * ? *)', checkedAt: '2026-10-24T11:58:00Z' };
  const setup = (reads: (() => Promise<unknown>)[], summaries: (() => Promise<unknown>)[] = [async () => []]) => {
    let clock = T;
    const warnings: [string, object?][] = [];
    let n = 0;
    let m = 0;
    const lookup = createProxyPrefixes({
      terraform, records: { listRouters: () => { const read = reads[Math.min(n++, reads.length - 1)]!; return read() as never; } },
      fleet: { listRouters: () => { const read = summaries[Math.min(m++, summaries.length - 1)]!; return read() as never; } },
      log: { warn: (event, data) => { warnings.push([event, data]); } }, now: () => clock,
    });
    return { lookup, warnings, reads: () => n, summaryReads: () => m, advance: (ms: number) => { clock += ms; } };
  };

  it('a router that only reports to the manager: its prefix, its summaries read with the installed routers, once a minute', async () => {
    const s = setup([async () => installed], [async () => [REPORTING]]);
    expect(await s.lookup({ account: '777788889999', region: 'eu-central-1' })).toBe('dmt-prod-kube-');
    expect(await s.lookup(WHERE)).toBe('dmt-dev-kube-');
    expect([s.reads(), s.summaryReads()]).toEqual([1, 1]);
  });

  it('a failed read of the summaries: no prefix for that scan, a warning, and the next scan reads again', async () => {
    const s = setup([async () => installed], [fail, async () => [REPORTING]]);
    expect(await s.lookup({ account: '777788889999', region: 'eu-central-1' })).toBeNull();
    expect(s.warnings.map(([event]) => event)).toEqual(['router-lookup-failed']);
    expect(await s.lookup({ account: '777788889999', region: 'eu-central-1' })).toBe('dmt-prod-kube-');
    expect(s.summaryReads()).toBe(2);
  });
  const fail = async () => { throw new Error('AccessDenied: dynamodb:Query'); };

  it('a failed read of the routers: no prefix for that scan, a warning, and the next scan reads again', async () => {
    const s = setup([fail, async () => installed]);
    expect(await s.lookup(WHERE)).toBeNull();
    expect(s.warnings).toHaveLength(1);
    expect(s.warnings[0]![0]).toBe('router-lookup-failed');
    expect(await s.lookup(WHERE)).toBe('dmt-dev-kube-');
    expect(s.reads()).toBe(2);
  });

  it('a successful read is kept for a minute: one read for two scans', async () => {
    const s = setup([async () => installed]);
    await s.lookup(WHERE);
    s.advance(59_000);
    expect(await s.lookup(WHERE)).toBe('dmt-dev-kube-');
    expect(s.reads()).toBe(1);
    s.advance(2_000);
    await s.lookup(WHERE);
    expect(s.reads()).toBe(2);
  });
});
