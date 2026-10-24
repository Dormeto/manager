import { describe, expect, it } from 'vitest';
import { proxyPrefixOf } from '../src/proxy-prefix.js';

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
