import { PutItemCommand } from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';
import { fakeDynamo } from '../../discovery/test/dynamo-fake.js';
import { createRegistry, routerItem, routerKey, routerOf, type InstalledRouter } from '../src/registry.js';

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

  it('lists the registered routers, whatever else the partition holds, and removes one', async () => {
    const dynamo = fakeDynamo({ pageSize: 1 });
    const aws: InstalledRouter = { ...router, name: 'dmtr-dev', account: '121014831971', region: 'eu-west-3', controller: 'arn:aws:lambda:eu-west-3:121014831971:function:dmtr-dev-controller', cloud: undefined };
    for (const item of [routerItem(router), routerItem(aws), { pk: { S: 'T#default' }, sk: { S: 'RS#dormeto-dev#europe-west2' }, data: { S: '{}' } }]) {
      await dynamo.send(new PutItemCommand({ TableName: 't', Item: item }));
    }
    const registry = createRegistry({ dynamo, table: 't' });
    expect(await registry.list()).toEqual([aws, router]);
    await registry.delete('dormeto-dev', 'europe-west2');
    expect(await registry.list()).toEqual([aws]);
  });

  it('updates a registration only while it exists, and deletes it only while it holds what was read', async () => {
    const dynamo = fakeDynamo();
    const registry = createRegistry({ dynamo, table: 't' });
    expect(await registry.update(router)).toBe(false);
    expect(await registry.list()).toEqual([]);
    await registry.put(router);
    expect(await registry.update({ ...router, version: '0.40.1' })).toBe(true);
    expect((await registry.list())[0]!.version).toBe('0.40.1');
    expect(await registry.deleteIf(router.account, router.region, router)).toBe(false);
    expect(await registry.list()).toHaveLength(1);
    expect(await registry.deleteIf(router.account, router.region, { ...router, version: '0.40.1' })).toBe(true);
    expect(await registry.list()).toEqual([]);
    expect(await registry.deleteIf(router.account, router.region, router)).toBe(false);
  });
});
