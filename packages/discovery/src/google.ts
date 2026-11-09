// Google Cloud routers in a discovery run (Google Cloud manager design §6.1): with a connection, the projects the
// discovery service account sees (Cloud Resource Manager's projects:search), ten at a time, each one's Cloud Run services
// (all locations at once); a service `dmtr-<region>-controller` is the router of <region>, its URL the controller and its
// DMT_VERSION variable the version (the discovery account never calls a router). The registry follows: a router found is
// added or has its controller and version updated, a registered one no longer found in a project listed is removed. A
// project whose listing failed is recorded and its routers kept; Cloud Run turned off (SERVICE_DISABLED) is a project
// without routers. AWS registrations are never read or written. The manager never changes a Google IAM policy.
import { isProject, isRegion } from '@dormeto/fleet/clouds';
import type { InstalledRouter } from '@dormeto/fleet/registry';
import { GoogleError, type Google, type GoogleConnection } from '@dormeto/google';

export interface GooglePort {
  // The connection's record (`DISC#GOOGLE`), null while there is none.
  connection(): Promise<GoogleConnection | null>;
  // A Google API call as the discovery service account.
  call<T = unknown>(method: string, url: string, body?: unknown): Promise<T>;
  registry: { list(): Promise<InstalledRouter[]>; put(router: InstalledRouter): Promise<void>; delete(account: string, region: string): Promise<void> };
}

// What a run records of its Google Cloud part.
export interface GoogleSummary {
  projects: number; // listed
  routers: number; // found
  added: number;
  updated: number;
  removed: number;
  errors: { project: string; error: string }[]; // project '*': the search of projects itself
}

const PROJECTS_AT_ONCE = 10;
const SEARCH = 'https://cloudresourcemanager.googleapis.com/v3/projects:search';
const SERVICES = (project: string) => `https://run.googleapis.com/v2/projects/${project}/locations/-/services`;
const ROUTER_SERVICE = /\/services\/dmtr-(.+)-controller$/;

const messageOf = (err: unknown) => (err instanceof GoogleError ? err.message : String((err as Error)?.message ?? err)).slice(0, 300);

interface Service { name?: string; uri?: string; template?: { containers?: { env?: { name?: string; value?: string }[] }[] } }
interface Found { project: string; region: string; controller: string; version: string }

async function pages<T>(call: (token: string | undefined) => Promise<{ nextPageToken?: string } & T>, items: (page: T) => unknown[]): Promise<unknown[]> {
  const out: unknown[] = [];
  let token: string | undefined;
  do {
    const page = await call(token);
    out.push(...items(page));
    token = page.nextPageToken || undefined;
  } while (token);
  return out;
}

async function listProjects(port: GooglePort): Promise<string[]> {
  const found = await pages(
    (token) => port.call<{ projects?: { projectId?: string }[]; nextPageToken?: string }>('GET', `${SEARCH}?${new URLSearchParams({ query: 'state:ACTIVE', pageSize: '500', ...(token ? { pageToken: token } : {}) })}`),
    (page) => page.projects ?? [],
  );
  return (found as { projectId?: string }[]).map((p) => p.projectId).filter((id): id is string => isProject(id));
}

// The routers of one project; Cloud Run turned off means none.
async function routersOf(port: GooglePort, project: string): Promise<Found[]> {
  try {
    const services = await pages(
      (token) => port.call<{ services?: Service[]; nextPageToken?: string }>('GET', `${SERVICES(project)}${token ? `?${new URLSearchParams({ pageToken: token })}` : ''}`),
      (page) => page.services ?? [],
    ) as Service[];
    return services.flatMap((s) => {
      const region = ROUTER_SERVICE.exec(s.name ?? '')?.[1];
      if (!region || !isRegion('gcp', region) || !s.uri) return [];
      return [{ project, region, controller: s.uri, version: s.template?.containers?.[0]?.env?.find((e) => e.name === 'DMT_VERSION')?.value ?? '' }];
    });
  } catch (err) {
    if (err instanceof GoogleError && err.reason === 'SERVICE_DISABLED') return [];
    throw err;
  }
}

export async function discoverGoogleRouters(port: GooglePort, { now, log }: { now: () => number; log: { warn(event: string, data?: object): void } }): Promise<GoogleSummary | null> {
  if (!(await port.connection())) return null;
  const summary: GoogleSummary = { projects: 0, routers: 0, added: 0, updated: 0, removed: 0, errors: [] };
  let projects: string[];
  try {
    projects = await listProjects(port);
  } catch (err) {
    summary.errors.push({ project: '*', error: messageOf(err) });
    log.warn('GoogleProjectsFailed', { error: messageOf(err) });
    return summary;
  }
  const found: Found[] = [];
  const listed = new Set<string>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(PROJECTS_AT_ONCE, projects.length) }, async () => {
    while (next < projects.length) {
      const project = projects[next++]!;
      try {
        found.push(...await routersOf(port, project));
        listed.add(project);
      } catch (err) {
        summary.errors.push({ project, error: messageOf(err) });
        log.warn('GoogleProjectFailed', { project, error: messageOf(err) });
      }
    }
  }));
  summary.projects = listed.size;
  summary.routers = found.length;
  summary.errors.sort((a, b) => a.project.localeCompare(b.project));

  const registered = (await port.registry.list()).filter((r) => r.cloud === 'gcp');
  const known = new Map(registered.map((r) => [`${r.account}#${r.region}`, r]));
  for (const f of found) {
    const existing = known.get(`${f.project}#${f.region}`);
    if (!existing) {
      await port.registry.put({
        name: `dmtr-${f.region}`, account: f.project, region: f.region, controller: f.controller, onboarder: '', version: f.version, build: '', installedBy: 'cli', cloud: 'gcp',
        installedAt: new Date(now()).toISOString(),
      });
      summary.added += 1;
    } else if (existing.controller !== f.controller || (f.version && existing.version !== f.version)) {
      await port.registry.put({ ...existing, controller: f.controller, version: f.version || existing.version });
      summary.updated += 1;
    }
  }
  const still = new Set(found.map((f) => `${f.project}#${f.region}`));
  for (const r of registered) {
    if (!listed.has(r.account) || still.has(`${r.account}#${r.region}`)) continue;
    await port.registry.delete(r.account, r.region);
    summary.removed += 1;
  }
  return summary;
}

// One Google instance per execution environment, so the tokens are kept from one invocation to the next: built when the
// record is first read, built again only when the record changes.
export function createGoogleSource({ read, create }: { read(): Promise<GoogleConnection | null>; create(connection: GoogleConnection): Pick<Google, 'call'> }) {
  let kept: { record: string; google: Pick<Google, 'call'> } | undefined;
  return {
    async connection(): Promise<GoogleConnection | null> {
      const record = await read();
      if (!record) {
        kept = undefined;
        return null;
      }
      const text = JSON.stringify(record);
      if (kept?.record !== text) kept = { record: text, google: create(record) };
      return record;
    },
    async call<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
      if (!kept) throw new Error('no Google Cloud connection');
      return kept.google.call<T>('discovery', method, url, body);
    },
  };
}
