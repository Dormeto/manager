import { describe, expect, it } from 'vitest';
import { GoogleError } from '@dormeto/google';
import type { GoogleConnection } from '@dormeto/google';
import type { InstalledRouter } from '@dormeto/fleet/registry';
import type { GooglePort } from '../src/google.js';
import { runDiscovery } from '../src/run.js';
import { A, B, C, config, filter } from './fixtures.js';
import { setup } from './run-fakes.js';

const connection = (over: Partial<GoogleConnection> = {}): GoogleConnection => ({
  project: 'dormeto-host', projectNumber: '1', pool: 'dmt-dev', provider: 'aws', scopes: ['projects/dormeto-host'],
  serviceAccounts: { discovery: 'd@x', command: 'c@x' }, routers: [], googleAdded: [], connectedAt: '2026-11-09T10:00:00.000Z', connectedBy: 'ops', cli: '0.14.0', ...over,
});
const registered = (project: string, region: string, over: Partial<InstalledRouter> = {}): InstalledRouter => ({
  name: `dmtr-${region}`, account: project, region, controller: '', onboarder: '', version: '', build: '', installedBy: 'cli', cloud: 'gcp', installedAt: '2026-11-09T10:00:00.000Z', ...over,
});
const service = (project: string, region: string, version?: string) => ({
  name: `projects/${project}/locations/${region}/services/dmtr-${region}-controller`,
  uri: `https://dmtr-${region}-controller-abc-${region}.a.run.app`,
  template: { containers: [{ env: [{ name: 'OTHER', value: 'x' }, ...(version ? [{ name: 'DMT_VERSION', value: version }] : [])] }] },
});

// Google answering from projects: their services, or the error each project's listing gives.
// projects: a bare ID, or the project with its display name, labels and ancestry (the project up to the root).
type Project = string | { id: string; displayName?: string; labels?: Record<string, string>; ancestry?: [string, string][] };
const idOf = (p: Project) => (typeof p === 'string' ? p : p.id);
function fakeGoogle({ projects, services, record }: { projects: Project[]; services: Record<string, unknown[] | GoogleError>; record?: GoogleConnection | null }) {
  if (record === undefined) record = connection({ scopes: projects.map((p) => `projects/${idOf(p)}`) });
  const calls: string[] = [];
  const registry = new Map<string, InstalledRouter>();
  const port: GooglePort = {
    connection: async () => record,
    call: (async (method: string, url: string) => {
      calls.push(`${method} ${url}`);
      if (url.startsWith('https://cloudresourcemanager.googleapis.com/v3/projects:search')) return { projects: projects.map((p) => ({ projectId: idOf(p), state: 'ACTIVE', ...(typeof p === 'string' ? {} : { displayName: p.displayName, labels: p.labels }) })) };
      const a = /^https:\/\/cloudresourcemanager\.googleapis\.com\/v1\/projects\/([^/:]+):getAncestry$/.exec(url);
      if (a) {
        const p = projects.find((x) => idOf(x) === a[1]);
        return { ancestor: [{ resourceId: { type: 'project', id: a[1] } }, ...((typeof p === 'object' ? p.ancestry : undefined) ?? []).map(([type, id]) => ({ resourceId: { type, id } }))] };
      }
      const m = /^https:\/\/run\.googleapis\.com\/v2\/projects\/([^/]+)\/locations\/-\/services/.exec(url);
      const found = services[m![1]!];
      if (found instanceof GoogleError) throw found;
      return { services: found ?? [] };
    }) as GooglePort['call'],
    registry: {
      list: async () => [...registry.values()],
      put: async (r) => { registry.set(`${r.account}#${r.region}`, r); },
      delete: async (account, region) => { registry.delete(`${account}#${region}`); },
    },
  };
  return { port, calls, registry };
}
const disabled = new GoogleError({ status: 403, reason: 'SERVICE_DISABLED', message: 'Cloud Run Admin API has not been used in project p before or it is disabled' });
const denied = new GoogleError({ status: 403, reason: 'IAM_PERMISSION_DENIED', message: 'permission denied' });

async function run(g: ReturnType<typeof fakeGoogle>) {
  const s = setup({ cfg: config({ filters: [filter('a', [{ accountIds: [A.id] }])] }) });
  await s.ready;
  s.deps.google = g.port;
  return runDiscovery(s.deps, { source: 'manual' });
}

describe('Google Cloud routers in a discovery run', () => {
  it('registers a router found in a project with its URL and version', async () => {
    const g = fakeGoogle({ projects: ['dormeto-dev'], services: { 'dormeto-dev': [service('dormeto-dev', 'europe-west2', '0.40.0'), { name: 'projects/dormeto-dev/locations/europe-west2/services/shop', uri: 'https://shop' }] } });
    const record = await run(g);
    expect([...g.registry.values()]).toEqual([expect.objectContaining({
      name: 'dmtr-europe-west2', account: 'dormeto-dev', region: 'europe-west2', cloud: 'gcp', controller: 'https://dmtr-europe-west2-controller-abc-europe-west2.a.run.app',
      onboarder: '', version: '0.40.0', build: '', installedBy: 'cli',
    })]);
    expect(record.status).toBe('ok');
    expect(g.calls[0]).toMatch(/^GET https:\/\/cloudresourcemanager\.googleapis\.com\/v3\/projects:search\?.*query=state%3AACTIVE/);
    expect(g.calls).toContain('GET https://run.googleapis.com/v2/projects/dormeto-dev/locations/-/services');
  });

  it('updates the controller and version of a registration and keeps its other fields', async () => {
    const g = fakeGoogle({ projects: ['dormeto-dev'], services: { 'dormeto-dev': [service('dormeto-dev', 'europe-west2', '0.40.0')] } });
    g.registry.set('dormeto-dev#europe-west2', registered('dormeto-dev', 'europe-west2', { version: '0.39.0', installedAt: '2026-11-01T00:00:00.000Z' }));
    await run(g);
    expect(g.registry.get('dormeto-dev#europe-west2')).toMatchObject({ version: '0.40.0', controller: expect.stringContaining('https://'), installedAt: '2026-11-01T00:00:00.000Z' });
  });

  it('removes a registered router whose service is gone from a project listed', async () => {
    const g = fakeGoogle({ projects: ['dormeto-dev'], services: { 'dormeto-dev': [] } });
    g.registry.set('dormeto-dev#europe-west2', registered('dormeto-dev', 'europe-west2'));
    await run(g);
    expect(g.registry.size).toBe(0);
  });

  it('takes Cloud Run turned off for no router there, not for an error', async () => {
    const g = fakeGoogle({ projects: ['dormeto-dev'], services: { 'dormeto-dev': disabled } });
    g.registry.set('dormeto-dev#europe-west2', registered('dormeto-dev', 'europe-west2'));
    const record = await run(g);
    expect(g.registry.size).toBe(0);
    expect(record.status).toBe('ok');
    expect(record.google).toMatchObject({ projects: 1, routers: 0, errors: [] });
  });

  it('records a project whose listing failed, keeps its routers and goes on with the others', async () => {
    const g = fakeGoogle({ projects: ['dormeto-dev', 'dormeto-two'], services: { 'dormeto-dev': denied, 'dormeto-two': [service('dormeto-two', 'us-central1', '0.40.0')] } });
    g.registry.set('dormeto-dev#europe-west2', registered('dormeto-dev', 'europe-west2'));
    g.registry.set('dormeto-two#us-east1', registered('dormeto-two', 'us-east1'));
    const record = await run(g);
    expect([...g.registry.keys()].sort()).toEqual(['dormeto-dev#europe-west2', 'dormeto-two#us-central1']);
    expect(record.google!.errors).toEqual([{ project: 'dormeto-dev', error: 'permission denied' }]);
  });

  it('keeps and does not update a router of an unreachable region, records why, and still removes a gone router of another region', async () => {
    const g = fakeGoogle({ projects: ['dormeto-dev'], services: {} });
    g.registry.set('dormeto-dev#europe-west2', registered('dormeto-dev', 'europe-west2', { version: '0.39.0' }));
    g.registry.set('dormeto-dev#us-east1', registered('dormeto-dev', 'us-east1'));
    const call = g.port.call;
    g.port.call = (async (m: string, url: string) => (url.includes('/v2/projects/') ? { services: [service('dormeto-dev', 'europe-west2', '0.40.0')], unreachable: ['projects/dormeto-dev/locations/europe-west2'] } : call(m, url))) as GooglePort['call'];
    const record = await run(g);
    expect([...g.registry.keys()]).toEqual(['dormeto-dev#europe-west2']);
    expect(g.registry.get('dormeto-dev#europe-west2')!.version).toBe('0.39.0');
    expect(record.google!.errors).toEqual([{ project: 'dormeto-dev', error: 'regions unreachable: europe-west2' }]);
  });

  it('never touches an AWS registration or a router of a project not listed', async () => {
    const g = fakeGoogle({ projects: ['dormeto-dev'], services: { 'dormeto-dev': [] } });
    g.registry.set(`${A.id}#eu-west-1`, { ...registered(A.id, 'eu-west-1', { name: 'dmtr-1', controller: 'arn:fn', onboarder: 'arn:on' }), cloud: undefined });
    g.registry.set('elsewhere#europe-west2', registered('elsewhere', 'europe-west2'));
    await run(g);
    expect([...g.registry.keys()].sort()).toEqual([`${A.id}#eu-west-1`, 'elsewhere#europe-west2']);
  });

  it('follows the pages of projects and services, ten projects at a time', async () => {
    const projects = Array.from({ length: 25 }, (_, i) => `project-${String(i).padStart(2, '0')}`);
    let inFlight = 0;
    let most = 0;
    const g = fakeGoogle({ projects: [], services: {}, record: connection({ scopes: projects.map((p) => `projects/${p}`) }) });
    const pages: Record<string, unknown> = { '': { projects: projects.slice(0, 20).map((projectId) => ({ projectId })), nextPageToken: 'p2' }, p2: { projects: projects.slice(20).map((projectId) => ({ projectId })) } };
    g.port.call = (async (_m: string, url: string) => {
      const u = new URL(url);
      if (u.pathname === '/v3/projects:search') return pages[u.searchParams.get('pageToken') ?? ''];
      if (u.pathname.endsWith(':getAncestry')) return { ancestor: [] };
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      const project = /projects\/([^/]+)\//.exec(u.pathname)![1]!;
      if (project !== 'project-24') return { services: [] };
      return u.searchParams.get('pageToken') ? { services: [service(project, 'europe-west2', '0.40.0')] } : { services: [], nextPageToken: 's2' };
    }) as GooglePort['call'];
    const record = await run(g);
    expect(record.google).toMatchObject({ projects: 25, routers: 1 });
    expect(g.registry.has('project-24#europe-west2')).toBe(true);
    expect(most).toBe(10);
  });

  it('calls Google when there is no connection: never', async () => {
    const g = fakeGoogle({ projects: ['dormeto-dev'], services: { 'dormeto-dev': [service('dormeto-dev', 'europe-west2', '0.40.0')] }, record: null });
    const record = await run(g);
    expect(g.calls).toEqual([]);
    expect(g.registry.size).toBe(0);
    expect(record.google).toBeUndefined();
  });

  it('keeps the run and its routers when the project search itself fails', async () => {
    const g = fakeGoogle({ projects: [], services: {} });
    g.registry.set('dormeto-dev#europe-west2', registered('dormeto-dev', 'europe-west2'));
    g.port.call = async () => { throw denied; };
    const record = await run(g);
    expect(record.status).toBe('ok');
    expect(g.registry.size).toBe(1);
    expect(record.google).toMatchObject({ projects: 0, errors: [{ project: '*', error: 'permission denied' }] });
  });

  it('runs without a Google port as before', async () => {
    const s = setup({ cfg: config({ filters: [filter('b', [{ accountIds: [B.id] }])] }) });
    await s.ready;
    expect((await runDiscovery(s.deps, { source: 'manual' })).google).toBeUndefined();
  });

  it('puts the projects of the scopes in the inventory: a project scope and a folder scope, with their ancestry, display name and labels', async () => {
    const g = fakeGoogle({
      projects: [
        { id: 'shop-prod', displayName: 'Shop', labels: { env: 'prod' }, ancestry: [['folder', '222'], ['folder', '111'], ['organization', '9']] },
        { id: 'dormeto-dev' },
        { id: 'other-one', ancestry: [['folder', '333'], ['organization', '9']] },
        { id: 'loose-one' },
      ],
      services: {},
      record: connection({ scopes: ['projects/dormeto-dev', 'folders/111'] }),
    });
    const s = setup({ cfg: config({ filters: [filter('a', [{ accountIds: [A.id] }])] }) });
    await s.ready;
    s.deps.google = g.port;
    await runDiscovery(s.deps, { source: 'manual' });
    const projects = (await s.store.getInventory())!.accounts.filter((a) => !/^\d+$/.test(a.id));
    expect(projects).toEqual([
      { id: 'shop-prod', name: 'Shop', ouPath: ['organizations/9', 'folders/111', 'folders/222'], tags: { env: 'prod' } },
      { id: 'dormeto-dev', name: 'dormeto-dev', ouPath: [], tags: {} },
    ]);
    expect([...new Set(g.calls.filter((c) => c.startsWith('POST')))].sort()).toEqual([
      'POST https://cloudresourcemanager.googleapis.com/v1/projects/dormeto-dev:getAncestry',
      'POST https://cloudresourcemanager.googleapis.com/v1/projects/loose-one:getAncestry',
      'POST https://cloudresourcemanager.googleapis.com/v1/projects/other-one:getAncestry',
      'POST https://cloudresourcemanager.googleapis.com/v1/projects/shop-prod:getAncestry',
    ]);
  });

  it('reads only the projects of the scopes for the routers too', async () => {
    const g = fakeGoogle({ projects: ['dormeto-dev', 'elsewhere'], services: { 'dormeto-dev': [], elsewhere: [service('elsewhere', 'europe-west2', '0.40.0')] }, record: connection({ scopes: ['projects/dormeto-dev'] }) });
    await run(g);
    expect(g.registry.size).toBe(0);
    expect(g.calls.some((c) => c.includes('/projects/elsewhere/'))).toBe(false);
  });

  it('adds no project and makes no Google call without a connection', async () => {
    const g = fakeGoogle({ projects: ['dormeto-dev'], services: {}, record: null });
    const s = setup({ cfg: config({ filters: [filter('a', [{ accountIds: [A.id] }])] }) });
    await s.ready;
    s.deps.google = g.port;
    await runDiscovery(s.deps, { source: 'manual' });
    expect(g.calls).toEqual([]);
    expect((await s.store.getInventory())!.accounts.map((a) => a.id).sort()).toEqual([A.id, B.id, C.id]);
  });
});
