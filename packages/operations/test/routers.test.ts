import { describe, expect, it } from 'vitest';
import { routersOf } from '../src/routers.js';

describe('routers', () => {
  it('lists the Terraform routers (function names as ARNs) and the installed ones, Terraform first for an account and region', async () => {
    const installed = [
      { name: 'dmt-dev', account: '1', region: 'eu-west-3', controller: 'arn:c3', onboarder: 'arn:o3', version: '0.18.0', build: 'b', installedBy: 'x', installedAt: 'y' },
      { name: 'dmt-dev', account: '1', region: 'eu-west-1', controller: 'arn:dup', onboarder: 'arn:dup', version: '0.18.0', build: 'b', installedBy: 'x', installedAt: 'y' },
    ];
    expect(await routersOf([{ name: 'dmt-dev', region: 'eu-west-1', controller: 'dmt-dev-controller', onboarder: 'dmt-dev-onboarder', account: '1' }], { listRouters: async () => installed })).toEqual([
      { name: 'dmt-dev', account: '1', region: 'eu-west-1', controller: 'arn:aws:lambda:eu-west-1:1:function:dmt-dev-controller', onboarder: 'arn:aws:lambda:eu-west-1:1:function:dmt-dev-onboarder', source: 'terraform' },
      { name: 'dmt-dev', account: '1', region: 'eu-west-3', controller: 'arn:c3', onboarder: 'arn:o3', source: 'manager', version: '0.18.0', build: 'b' },
    ]);
  });
});
