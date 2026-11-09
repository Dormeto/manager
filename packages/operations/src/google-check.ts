// The command account's access on a Google Cloud project (Google Cloud manager design §7.4), the twin of `checkRole`: what
// the manager does there is calling the project's routers and binding the tag `dormeto/managed`, each checked with a
// `testIamPermissions` as the command account. A permission an answer does not list is missing. A refusal of the token
// itself (STS's exchange through the federation, iamcredentials' impersonation through the account's grant) comes before
// any permission is asked: the manager can't act as the command account at all.
import { connectCommand, GoogleError, type GoogleConnection } from '@dormeto/google';

// router gcp/access.json, manager.roles.dormetoCommand.permissions (what the CLI's connect grants on the project).
export const COMMAND_PERMISSIONS = [
  'compute.instances.listTagBindings',
  'compute.instances.createTagBinding',
  'compute.instances.deleteTagBinding',
  'compute.instanceGroupManagers.listTagBindings',
  'compute.instanceGroupManagers.createTagBinding',
  'compute.instanceGroupManagers.deleteTagBinding',
  'cloudsql.instances.get',
  'cloudsql.instances.listTagBindings',
  'cloudsql.instances.createTagBinding',
  'cloudsql.instances.deleteTagBinding',
];

export type CheckAnswer = { ok: true } | { ok: false; name: string; message: string };

type Call = (method: string, url: string, body?: unknown) => Promise<any>;

const TOKEN_HOSTS = new Set(['sts.googleapis.com', 'iamcredentials.googleapis.com']);
const refused = (err: unknown): err is GoogleError => err instanceof GoogleError && (err.status === 403 || err.status === 404);
const atToken = (err: unknown): err is GoogleError => refused(err) && TOKEN_HOSTS.has(err.host);

// `call`: a Google API call as the command account; `connection`: the connection's record, null while there is none.
export function checkProject({ call, connection, env }: { call: Call; connection(): Promise<GoogleConnection | null>; env: string }) {
  return async (project: string, controllers: string[]): Promise<CheckAnswer> => {
    const record = await connection();
    if (!record) return { ok: false, name: 'AccessDenied', message: 'no Google Cloud connection: dormeto gcp connect makes one' };
    // Nothing to do on the project without a router: no command to check.
    if (!controllers.length) return { ok: true };
    const connect = connectCommand(record.project, env);
    const account = record.serviceAccounts.command;
    // A refusal says it is missing; Google failing otherwise (a 5xx, a timeout) says nothing and is thrown, as a refusal of
    // the token is (said below).
    const refusal = <T>(read: Promise<T>, missing: T) => read.catch((err) => {
      if (refused(err) && !atToken(err)) return missing;
      throw err;
    });
    const held = async (url: string, permissions: string[]) => {
      const answer = await refusal(call('POST', url, { permissions }), {} as { permissions?: string[] });
      const has = new Set(answer.permissions ?? []);
      return permissions.filter((p) => !has.has(p));
    };
    const missing: string[] = [];
    const tag = `${project}/dormeto/managed`;
    let unreadable = false;
    try {
      const lacks = await held(`https://cloudresourcemanager.googleapis.com/v1/projects/${project}:testIamPermissions`, COMMAND_PERMISSIONS);
      if (lacks.length) missing.push(`${lacks.join(', ')} on the project ${project}`);
      for (const controller of controllers) {
        if ((await held(`https://run.googleapis.com/v2/${controller}:testIamPermissions`, ['run.routes.invoke'])).length) missing.push(`run.routes.invoke on ${controller}`);
      }
      const value = await refusal(call('GET', `https://cloudresourcemanager.googleapis.com/v3/tagValues/namespaced?${new URLSearchParams({ name: tag })}`), null);
      if (typeof value?.name !== 'string') unreadable = true;
      else if ((await held(`https://cloudresourcemanager.googleapis.com/v3/${value.name}:testIamPermissions`, ['resourcemanager.tagValueBindings.create'])).length) missing.push(`resourcemanager.tagValueBindings.create on the tag value ${tag}`);
    } catch (err) {
      if (!atToken(err)) throw err;
      const google = `Google: ${[err.host, err.status, err.reason].filter((part) => part !== '').join(' ')}`;
      return { ok: false, name: 'AccessDenied', message: `the manager can't act as the command account ${account}: the workload identity federation or the account's grant to the manager is missing (${google}): ${connect}` };
    }
    if (!missing.length && !unreadable) return { ok: true };
    const lacking = [...(missing.length ? [`is missing ${missing.join('; ')}`] : []), ...(unreadable ? [`can't read the tag value ${tag}`] : [])].join(' and ');
    return { ok: false, name: 'AccessDenied', message: `the command account ${account} ${lacking}: ${connect}` };
  };
}
