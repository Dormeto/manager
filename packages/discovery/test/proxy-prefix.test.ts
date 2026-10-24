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
});

describe('the prefix lookup of the handler (isolated, cached a minute)', () => {
  const setup = (reads: (() => Promise<unknown>)[]) => {
    let clock = 0;
    const warnings: [string, object?][] = [];
    let n = 0;
    const lookup = createProxyPrefixes({
      terraform, records: { listRouters: () => { const read = reads[Math.min(n++, reads.length - 1)]!; return read() as never; } },
      log: { warn: (event, data) => { warnings.push([event, data]); } }, now: () => clock,
    });
    return { lookup, warnings, reads: () => n, advance: (ms: number) => { clock += ms; } };
  };
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
