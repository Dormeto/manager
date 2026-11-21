// Every HTTP call tags.ts makes as the command account is the router's gcp/access.json's (final review, tests' honesty): its
// custom role dormetoCommand on the project, and roles/resourcemanager.tagUser on the tag value. The calls are read as tags.ts
// makes them, not as verbs: a new Google call there that the table does not know fails this test. Skipped without the router's
// checkout beside the manager.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bindTag, sqlRegionOf, tagTargets, tagValueOf, unbindTag } from '../src/tags.js';

const ACCESS = new URL('../../../../router/gcp/access.json', import.meta.url);
const PROJECT = 'dormeto-dev';
const VALUE = 'tagValues/281475';
const kindOf = (parent: string) => (parent.includes('/instanceGroupManagers/') ? 'compute.instanceGroupManagers' : parent.startsWith('//sqladmin') ? 'cloudsql.instances' : 'compute.instances');
// Each call's permissions: [method and URL, body] -> what it needs ('tagUser': the tag value's role).
const TABLE: [RegExp, (url: URL, body: { parent?: string } | undefined) => string[]][] = [
  [/^GET https:\/\/cloudresourcemanager\.googleapis\.com\/v3\/tagValues\/namespaced\?/, () => ['tagUser']],
  [/^POST https:\/\/[a-z0-9-]+-cloudresourcemanager\.googleapis\.com\/v3\/tagBindings$/, (_u, body) => [`${kindOf(body!.parent!)}.createTagBinding`, 'tagUser']],
  [/^GET https:\/\/[a-z0-9-]+-cloudresourcemanager\.googleapis\.com\/v3\/tagBindings\?parent=/, (u) => [`${kindOf(u.searchParams.get('parent')!)}.listTagBindings`]],
  [/^DELETE https:\/\/[a-z0-9-]+-cloudresourcemanager\.googleapis\.com\/v3\/tagBindings\/.+$/, (u) => [`${kindOf(decodeURIComponent(u.pathname.slice('/v3/tagBindings/'.length)))}.deleteTagBinding`, 'tagUser']],
  // The binding's own long-running operation, polled by its caller.
  [/^GET https:\/\/[a-z0-9-]+-cloudresourcemanager\.googleapis\.com\/v3\/operations\/.+$/, () => []],
  [/^GET https:\/\/sqladmin\.googleapis\.com\/v1\/projects\/[^/]+\/instances\/[^/]+$/, () => ['cloudsql.instances.get']],
];

describe.skipIf(!existsSync(ACCESS))('the command account\'s tag calls', () => {
  it('are each allowed to dormetoCommand or the tag value\'s tagUser', async () => {
    const access = JSON.parse(readFileSync(ACCESS, 'utf8')) as { manager: { roles: { dormetoCommand: { permissions: string[] } }; grants: { routerProjects: { account: string; role: string; on: string }[] } } };
    const granted = new Set(access.manager.roles.dormetoCommand.permissions);
    const calls: { sa: string; method: string; url: string; body: unknown }[] = [];
    const google = {
      call: async <T>(sa: string, method: string, url: string, body?: unknown): Promise<T> => {
        calls.push({ sa, method, url, body });
        if (url.includes('tagValues/namespaced')) return { name: VALUE } as T;
        if (url.startsWith('https://sqladmin')) return { region: 'europe-west1' } as T;
        if (method === 'GET' && url.includes('tagBindings?')) {
          const parent = new URL(url).searchParams.get('parent')!;
          return { tagBindings: [{ name: `tagBindings/${encodeURIComponent(parent)}/${VALUE}`, tagValue: VALUE }] } as T;
        }
        return { name: 'operations/rctb.1', done: true } as T;
      },
    };
    await tagValueOf(google as never, PROJECT, { host: 'dormeto-host', env: 'dev' });
    const region = await sqlRegionOf(google as never, PROJECT, 'orders');
    const targets = tagTargets({
      project: PROJECT, number: '1034397096264', databases: [{ name: 'orders', region }],
      vms: [{ zone: 'europe-west1-b', name: 'batch', id: '4471' }], groups: [{ kind: 'zonal', location: 'europe-west1-b', name: 'workers', id: '5582' }, { kind: 'regional', location: 'europe-west1', name: 'spread', id: '5583' }],
    });
    for (const target of targets) {
      await bindTag(google as never, target, VALUE).catch(() => {});
      await unbindTag(google as never, target, VALUE);
    }
    const needed = new Set<string>();
    for (const call of calls) {
      expect(call.sa, call.url).toBe('command');
      const line = `${call.method} ${call.url}`;
      const found = TABLE.find(([re]) => re.test(line));
      expect(found, `a call the table does not know: ${line}`).toBeDefined();
      for (const p of found![1](new URL(call.url), call.body as { parent?: string } | undefined)) needed.add(p);
    }
    if (needed.delete('tagUser')) expect(access.manager.grants.routerProjects).toContainEqual({ account: 'command', role: 'roles/resourcemanager.tagUser', on: 'tagValue' });
    expect([...needed].filter((p) => !granted.has(p))).toEqual([]);
    expect([...needed].sort()).toEqual(['cloudsql.instances.createTagBinding', 'cloudsql.instances.deleteTagBinding', 'cloudsql.instances.get', 'cloudsql.instances.listTagBindings',
      'compute.instanceGroupManagers.createTagBinding', 'compute.instanceGroupManagers.deleteTagBinding', 'compute.instanceGroupManagers.listTagBindings',
      'compute.instances.createTagBinding', 'compute.instances.deleteTagBinding', 'compute.instances.listTagBindings']);
  });
});
