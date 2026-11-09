// The tag `dormeto/managed` on what a Google Cloud onboarding makes a router manage (Google Cloud manager design §8): the
// manager, as its command account, binds it to the VMs and groups the preview names and to the databases it was given, and
// removes it again at the offboarding; the CLI does the same (`dormeto gcp workloads onboard`), parents and locations alike.
// Resource Manager binds in the resource's own location, a long-running operation each.
import { GoogleError } from './errors.js';
import type { Google } from './google.js';

// What a tag binding's parent names: label for the words, location the endpoint's prefix (a zone or a region).
export type TagTarget = { label: string; location: string; parent: string };

type Calls = Pick<Google, 'call'>;

export const OPERATION_WAIT_MS = 60_000;
export const OPERATION_POLL_MS = 2_000;

const base = (location: string) => `https://${location}-cloudresourcemanager.googleapis.com/v3/`;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const as = <T>(google: Calls, method: string, url: string, body?: unknown) => google.call<T>('command', method, url, body);

// The tag value `<project>/dormeto/managed` (`tagValues/<n>`). Resource Manager answers 403 for a value that does not
// exist, and 404 when it is not there: either way the connect command fixes it.
export async function tagValueOf(google: Calls, project: string): Promise<string> {
  const tag = `${project}/dormeto/managed`;
  try {
    const value = await as<{ name?: string }>(google, 'GET', `https://cloudresourcemanager.googleapis.com/v3/tagValues/namespaced?${new URLSearchParams({ name: tag })}`);
    if (typeof value.name === 'string' && value.name) return value.name;
  } catch (err) {
    if (!(err instanceof GoogleError) || (err.status !== 403 && err.status !== 404)) throw err;
  }
  throw new Error(`the tag value ${tag} can't be read: \`dormeto gcp connect\` gives the manager's command account access to it`);
}

// A long-running operation's failure (google.rpc.Status) as the HTTP status it stands for.
const HTTP_OF_RPC: Record<number, number> = { 3: 400, 5: 404, 6: 409, 7: 403, 9: 400, 10: 409 };
type Operation = { name?: string; done?: boolean; error?: { code?: number; message?: string } };

// The operation waited for, every 2 s, at most 60 s.
async function wait(google: Calls, location: string, operation: Operation, parent: string): Promise<void> {
  let op = operation;
  for (let waited = 0; !op.done; waited += OPERATION_POLL_MS) {
    if (waited >= OPERATION_WAIT_MS || !op.name) throw new Error(`the tag binding's operation on ${parent} didn't finish within ${OPERATION_WAIT_MS / 1000} s`);
    await sleep(OPERATION_POLL_MS);
    op = await as<Operation>(google, 'GET', `${base(location)}${op.name}`);
  }
  if (op.error) throw new GoogleError({ status: HTTP_OF_RPC[op.error.code ?? 0] ?? 500, reason: '', message: op.error.message || `operation failed (code ${op.error.code ?? 0})` });
}

// Binds the value to the target; true when this call made the binding, false when it was there already (409
// ALREADY_EXISTS: not this call's to remove).
export async function bindTag(google: Calls, target: TagTarget, value: string): Promise<boolean> {
  let operation: Operation;
  try {
    operation = await as<Operation>(google, 'POST', `${base(target.location)}tagBindings`, { parent: target.parent, tagValue: value });
  } catch (err) {
    if (err instanceof GoogleError && err.status === 409 && err.reason === 'ALREADY_EXISTS') return false;
    throw err;
  }
  await wait(google, target.location, operation, target.parent);
  return true;
}

// Removes the value's bindings from the target; how many. A binding gone meanwhile (404 on its delete) is skipped, a
// target with nothing to list (404) has none; a 403 on the list is an error: Resource Manager answers 403 for a resource
// that does not exist, the permission held, so it can't be told from the permission missing.
export async function unbindTag(google: Calls, target: TagTarget, value: string): Promise<number> {
  const found: string[] = [];
  let token = '';
  try {
    do {
      const page = await as<{ tagBindings?: { name: string; tagValue?: string }[]; nextPageToken?: string }>(google, 'GET',
        `${base(target.location)}tagBindings?parent=${encodeURIComponent(target.parent)}${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`);
      for (const b of page.tagBindings ?? []) if (b.tagValue === value) found.push(b.name);
      token = page.nextPageToken ?? '';
    } while (token);
  } catch (err) {
    if (err instanceof GoogleError && err.status === 404) return 0;
    if (err instanceof GoogleError && err.status === 403) throw new Error(`the tag bindings of ${target.parent} can't be read: ${err.message}`);
    throw err;
  }
  let removed = 0;
  for (const name of found) {
    let operation: Operation;
    try {
      operation = await as<Operation>(google, 'DELETE', `${base(target.location)}${name}`);
    } catch (err) {
      if (err instanceof GoogleError && err.status === 404) continue;
      throw err;
    }
    await wait(google, target.location, operation, target.parent);
    removed++;
  }
  return removed;
}

// A Cloud SQL instance's region (sqladmin v1), where its tag binding is made.
export async function sqlRegionOf(google: Calls, project: string, name: string): Promise<string> {
  const instance = await as<{ region?: string }>(google, 'GET', `https://sqladmin.googleapis.com/v1/projects/${project}/instances/${name}`);
  if (!instance.region) throw new Error(`Cloud SQL instance ${name} answered no region`);
  return instance.region;
}

// What an onboarding tags, as the preview names it (`vms`, `groups`) and the databases given (`databases`, each with its
// region); parents as the CLI's.
export function tagTargets({ project, number, vms, groups, databases }: {
  project: string;
  number: string;
  vms: { zone: string; id: string; name?: string }[];
  groups: { kind: 'zonal' | 'regional'; location: string; id: string; name?: string }[];
  databases: { name: string; region: string }[];
}): TagTarget[] {
  const compute = `//compute.googleapis.com/projects/${number}`;
  return [
    ...vms.map((v) => ({ label: `VM ${v.zone}/${v.name ?? v.id}`, location: v.zone, parent: `${compute}/zones/${v.zone}/instances/${v.id}` })),
    ...groups.map((g) => ({
      label: `managed instance group ${g.location}/${g.name ?? g.id}`, location: g.location,
      parent: `${compute}/${g.kind === 'regional' ? 'regions' : 'zones'}/${g.location}/instanceGroupManagers/${g.id}`,
    })),
    ...databases.map((d) => ({ label: `Cloud SQL instance ${d.name}`, location: d.region, parent: `//sqladmin.googleapis.com/projects/${project}/instances/${d.name}` })),
  ];
}

export type Tags = {
  tagValueOf(project: string): Promise<string>;
  bindTag(target: TagTarget, value: string): Promise<boolean>;
  unbindTag(target: TagTarget, value: string): Promise<number>;
  sqlRegionOf(project: string, name: string): Promise<string>;
};
