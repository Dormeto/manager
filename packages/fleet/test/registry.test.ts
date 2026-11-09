import { describe, expect, it } from 'vitest';
import { routerItem, routerKey, routerOf, type InstalledRouter } from '../src/registry.js';

const router: InstalledRouter = {
  name: 'dmtr-europe-west2', account: 'dormeto-dev', region: 'europe-west2', controller: 'https://c.run.app', onboarder: '', version: '0.40.0',
  build: '', installedBy: 'cli', cloud: 'gcp', installedAt: '2026-11-09T10:00:00.000Z',
};

describe('the registry of routers', () => {
  it('keys a router by its account and region in the manager partition', () => {
    expect(routerKey('dormeto-dev', 'europe-west2')).toEqual({ pk: { S: 'T#default' }, sk: { S: 'ROUTER#dormeto-dev#europe-west2' } });
  });

  it('writes the router as JSON in data and reads it back', () => {
    const item = routerItem(router);
    expect(item.sk).toEqual({ S: 'ROUTER#dormeto-dev#europe-west2' });
    expect(routerOf(item)).toEqual(router);
    expect(routerOf(undefined)).toBeNull();
  });
});
