// The tag `dormeto/managed` as the manager's command account binds and removes it (Google Cloud manager design §8): the
// CLI's parents and locations, each binding's operation waited for, a binding that was there already not this call's.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindTag, GoogleError, sqlRegionOf, tagTargets, tagValueOf, unbindTag, type TagTarget } from '../src/index.js';

const VALUE = 'tagValues/1234';
const gerr = (status: number, reason: string, message = reason) => new GoogleError({ status, reason, message });

// A Google whose calls are answered by `answer(method, url, body)`, each recorded as the command account's.
function fake(answer: (method: string, url: string, body: unknown) => unknown) {
  const calls: { sa: string; method: string; url: string; body: unknown }[] = [];
  const google = {
    async call(sa: string, method: string, url: string, body?: unknown) {
      calls.push({ sa, method, url, body });
      const out = await answer(method, url, body);
      if (out instanceof Error) throw out;
      return out;
    },
  } as never;
  return { google, calls };
}

const vm: TagTarget = { label: 'VM europe-west2-b/web-1', location: 'europe-west2-b', parent: '//compute.googleapis.com/projects/1034397096264/zones/europe-west2-b/instances/77' };

afterEach(() => {
  vi.useRealTimers();
});

describe('tagTargets', () => {
  it('names a VM, a zonal group, a regional group and a Cloud SQL instance by the CLI\'s parents, each in its location', () => {
    expect(tagTargets({
      project: 'shop-prd', number: '1034397096264',
      vms: [{ zone: 'europe-west2-b', id: '77', name: 'web-1' }],
      groups: [{ kind: 'zonal', location: 'europe-west2-c', id: '88', name: 'web-mig' }, { kind: 'regional', location: 'europe-west2', id: '99', name: 'api-mig' }],
      databases: [{ name: 'orders', region: 'europe-west1' }],
    })).toEqual([
      vm,
      { label: 'managed instance group europe-west2-c/web-mig', location: 'europe-west2-c', parent: '//compute.googleapis.com/projects/1034397096264/zones/europe-west2-c/instanceGroupManagers/88' },
      { label: 'managed instance group europe-west2/api-mig', location: 'europe-west2', parent: '//compute.googleapis.com/projects/1034397096264/regions/europe-west2/instanceGroupManagers/99' },
      { label: 'Cloud SQL instance orders', location: 'europe-west1', parent: '//sqladmin.googleapis.com/projects/shop-prd/instances/orders' },
    ]);
  });
});

describe('tagValueOf', () => {
  it('reads the value by its namespaced name', async () => {
    const g = fake(() => ({ name: VALUE }));
    expect(await tagValueOf(g.google, 'shop-prd')).toBe(VALUE);
    expect(g.calls).toEqual([{ sa: 'command', method: 'GET', url: 'https://cloudresourcemanager.googleapis.com/v3/tagValues/namespaced?name=shop-prd%2Fdormeto%2Fmanaged', body: undefined }]);
  });

  it.each([403, 404])('names the tag and the connect command when Google answers %s', async (status) => {
    const g = fake(() => gerr(status, 'PERMISSION_DENIED'));
    await expect(tagValueOf(g.google, 'shop-prd')).rejects.toThrow(/shop-prd\/dormeto\/managed.*dormeto gcp connect/);
  });

  it('lets any other failure through', async () => {
    const g = fake(() => gerr(503, 'UNAVAILABLE', 'try later'));
    await expect(tagValueOf(g.google, 'shop-prd')).rejects.toThrow('try later');
  });
});

describe('sqlRegionOf', () => {
  it('reads the instance\'s region from sqladmin', async () => {
    const g = fake(() => ({ name: 'orders', region: 'europe-west1' }));
    expect(await sqlRegionOf(g.google, 'shop-prd', 'orders')).toBe('europe-west1');
    expect(g.calls[0]).toMatchObject({ method: 'GET', url: 'https://sqladmin.googleapis.com/v1/projects/shop-prd/instances/orders' });
  });
});

describe('bindTag', () => {
  it.each([
    ['a zone', vm],
    ['a region', { label: 'g', location: 'europe-west2', parent: '//compute.googleapis.com/projects/1/regions/europe-west2/instanceGroupManagers/9' }],
    ['a Cloud SQL instance\'s region', { label: 'Cloud SQL instance orders', location: 'europe-west1', parent: '//sqladmin.googleapis.com/projects/shop-prd/instances/orders' }],
  ])('POSTs the binding in %s\'s own Resource Manager endpoint and says it made it', async (_, target) => {
    const g = fake(() => ({ name: 'operations/o1', done: true }));
    expect(await bindTag(g.google, target, VALUE)).toBe(true);
    expect(g.calls).toEqual([{ sa: 'command', method: 'POST', url: `https://${target.location}-cloudresourcemanager.googleapis.com/v3/tagBindings`, body: { parent: target.parent, tagValue: VALUE } }]);
  });

  it('polls the operation every 2 s until it is done', async () => {
    vi.useFakeTimers();
    let polls = 0;
    const g = fake((method) => (method === 'POST' ? { name: 'operations/o1' } : { name: 'operations/o1', done: ++polls >= 3 }));
    const bound = bindTag(g.google, vm, VALUE);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(g.calls.map((c) => c.method)).toEqual(['POST', 'GET']);
    expect(g.calls[1]!.url).toBe('https://europe-west2-b-cloudresourcemanager.googleapis.com/v3/operations/o1');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await bound).toBe(true);
    expect(g.calls).toHaveLength(4);
  });

  it('gives up after 60 s, naming the parent', async () => {
    vi.useFakeTimers();
    const g = fake(() => ({ name: 'operations/o1' }));
    const bound = bindTag(g.google, vm, VALUE).catch((e: unknown) => e as Error) as Promise<Error>;
    await vi.advanceTimersByTimeAsync(60_000);
    const err = await bound;
    expect(err.message).toMatch(/operation.*didn't finish within 60 s/);
    expect(err.message).toContain(vm.parent);
  });

  it('throws the operation\'s error as a GoogleError', async () => {
    const g = fake(() => ({ name: 'operations/o1', done: true, error: { code: 7, message: 'no tagUser' } }));
    const err = await bindTag(g.google, vm, VALUE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleError);
    expect([(err as GoogleError).status, (err as GoogleError).message]).toEqual([403, 'no tagUser']);
  });

  it('says it did not make a binding that was there already (409 ALREADY_EXISTS), and fails on another 409', async () => {
    expect(await bindTag(fake(() => gerr(409, 'ALREADY_EXISTS')).google, vm, VALUE)).toBe(false);
    await expect(bindTag(fake(() => gerr(409, 'ABORTED', 'try again')).google, vm, VALUE)).rejects.toThrow('try again');
  });
});

describe('unbindTag', () => {
  const binding = (id: string, tagValue: string) => ({ name: `tagBindings/%2F%2Fcompute.googleapis.com%2Fprojects%2F1%2Fzones%2Fz%2Finstances%2F77/${id}`, tagValue });
  const list = `https://europe-west2-b-cloudresourcemanager.googleapis.com/v3/tagBindings?parent=${encodeURIComponent(vm.parent)}`;

  it('deletes the value\'s bindings only, across the list\'s pages, and counts them', async () => {
    const g = fake((method, url) => {
      if (method === 'GET' && url === list) return { tagBindings: [binding('a', VALUE), binding('b', 'tagValues/999')], nextPageToken: 'p2' };
      if (method === 'GET' && url === `${list}&pageToken=p2`) return { tagBindings: [binding('c', VALUE)] };
      return { name: 'operations/d', done: true };
    });
    expect(await unbindTag(g.google, vm, VALUE)).toBe(2);
    expect(g.calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([
      `https://europe-west2-b-cloudresourcemanager.googleapis.com/v3/${binding('a', '').name}`,
      `https://europe-west2-b-cloudresourcemanager.googleapis.com/v3/${binding('c', '').name}`,
    ]);
    expect(g.calls.every((c) => c.sa === 'command')).toBe(true);
  });

  it('waits for each delete\'s operation', async () => {
    vi.useFakeTimers();
    const g = fake((method, url) => {
      if (method === 'GET' && url === list) return { tagBindings: [binding('a', VALUE)] };
      if (method === 'DELETE') return { name: 'operations/d' };
      return { name: 'operations/d', done: true };
    });
    const removed = unbindTag(g.google, vm, VALUE);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await removed).toBe(1);
    expect(g.calls.map((c) => c.method)).toEqual(['GET', 'DELETE', 'GET']);
  });

  it('skips a binding that is gone (404 on its delete) and counts the others', async () => {
    const g = fake((method, url) => {
      if (method === 'GET') return { tagBindings: [binding('a', VALUE), binding('b', VALUE)] };
      return url.endsWith('/a') ? gerr(404, 'NOT_FOUND') : { name: 'operations/d', done: true };
    });
    expect(await unbindTag(g.google, vm, VALUE)).toBe(1);
  });

  it('finds none on a 404 on the list', async () => {
    expect(await unbindTag(fake(() => gerr(404, 'NOT_FOUND')).google, vm, VALUE)).toBe(0);
  });

  it('names the parent when the list is refused (403)', async () => {
    const err = await unbindTag(fake(() => gerr(403, 'PERMISSION_DENIED', 'denied')).google, vm, VALUE).catch((e: unknown) => e as Error) as Error;
    expect(err.message).toContain(vm.parent);
  });
});
