// The command role check of discovery (packaging design §3): the operations Lambda, which the role trusts, assumes it
// afresh (never from a cache: a role deleted since shows at once).
import { describe, expect, it } from 'vitest';
import { GoogleError, type GoogleConnection } from '@dormeto/google';
import { checkHandler, checkRole } from '../src/aws.js';
import { checkProject, COMMAND_PERMISSIONS } from '../src/google-check.js';

describe('command role check', () => {
  it('answers ok when the role can be assumed, else the error, assuming afresh each time', async () => {
    const calls: unknown[] = [];
    let deny = false;
    const sts = {
      async send(command: { input: unknown }) {
        calls.push(command.input);
        if (deny) throw Object.assign(new Error('User: arn:aws:sts::121014831971:assumed-role/dmt-dev-manager-operations is not authorized to perform: sts:AssumeRole'), { name: 'AccessDenied' });
        return { Credentials: { AccessKeyId: 'a', SecretAccessKey: 's', SessionToken: 't', Expiration: new Date(Date.now() + 3_600_000) } };
      },
    };
    const check = checkRole({ sts: sts as never, roleName: 'DmtCommandRole', sessionName: 'dmt-dev-access' });
    expect(await check('222222222222')).toEqual({ ok: true });
    deny = true;
    expect(await check('222222222222')).toEqual({ ok: false, name: 'AccessDenied', message: expect.stringContaining('not authorized') });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ RoleArn: 'arn:aws:iam::222222222222:role/DmtCommandRole', RoleSessionName: 'dmt-dev-access' });
  });

  it('the check function takes an account id and nothing else: anything else is refused without assuming any role', async () => {
    const asked: string[] = [];
    const handler = checkHandler(async (account) => { asked.push(account); return { ok: true }; });
    expect(await handler({ account: '222222222222' })).toEqual({ ok: true });
    for (const account of ['22222222222', '222222222222/x', undefined, 42]) {
      expect(await handler({ account } as never)).toEqual({ ok: false, name: 'InvalidInput', message: 'account must be 12 digits' });
    }
    expect(asked).toEqual(['222222222222']);
  });

  describe('a Google Cloud project', () => {
    const project = 'dev-project';
    const controller = `projects/${project}/locations/europe-west2/services/dmtr-europe-west2-controller`;
    const connection = { project: 'host-project', serviceAccounts: { discovery: 'd@x', command: 'dmt-dev-command@host-project.iam.gserviceaccount.com' } } as GoogleConnection;
    // The command account's permissions: what testIamPermissions answers, by the resource it is asked on.
    function google({ projectLacks = [] as string[], invoke = true, tag = 'ok' as 'ok' | 'unreadable' | 'unbindable' | 'down' } = {}) {
      const calls: { method: string; url: string; body?: unknown }[] = [];
      const call = async (method: string, url: string, body?: unknown) => {
        calls.push({ method, url, body });
        if (url.endsWith(`/v1/projects/${project}:testIamPermissions`)) return { permissions: COMMAND_PERMISSIONS.filter((p) => !projectLacks.includes(p)) };
        if (url === `https://run.googleapis.com/v2/${controller}:testIamPermissions`) return invoke ? { permissions: ['run.routes.invoke'] } : {};
        if (url.includes('/v3/tagValues/namespaced')) {
          if (tag === 'unreadable') throw new GoogleError({ status: 403, reason: 'IAM_PERMISSION_DENIED', message: 'denied' });
          if (tag === 'down') throw new GoogleError({ status: 503, reason: 'UNAVAILABLE', message: 'try later' });
          return { name: 'tagValues/123' };
        }
        if (url === 'https://cloudresourcemanager.googleapis.com/v3/tagValues/123:testIamPermissions') return tag === 'unbindable' ? {} : { permissions: ['resourcemanager.tagValueBindings.create'] };
        throw new Error(`unexpected ${method} ${url}`);
      };
      return { calls, check: checkProject({ call, connection: async () => connection, env: 'dev' }) };
    }

    it('refuses a controller the command account cannot invoke, naming it and the connect command', async () => {
      const g = google({ invoke: false });
      expect(await g.check(project, [controller])).toEqual({
        ok: false, name: 'AccessDenied',
        message: `the command account dmt-dev-command@host-project.iam.gserviceaccount.com is missing run.routes.invoke on ${controller}: dormeto gcp connect --project host-project --profile <profile> --env dev`,
      });
    });

    it('answers ok when the project, the controllers and the tag value are all held, asking each as the command account', async () => {
      const g = google();
      expect(await g.check(project, [controller])).toEqual({ ok: true });
      expect(g.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
        `POST https://cloudresourcemanager.googleapis.com/v1/projects/${project}:testIamPermissions`,
        `POST https://run.googleapis.com/v2/${controller}:testIamPermissions`,
        `GET https://cloudresourcemanager.googleapis.com/v3/tagValues/namespaced?name=${project}%2Fdormeto%2Fmanaged`,
        'POST https://cloudresourcemanager.googleapis.com/v3/tagValues/123:testIamPermissions',
      ]);
      expect(g.calls[0]!.body).toEqual({ permissions: COMMAND_PERMISSIONS });
    });

    it('names each permission of the project, an unreadable tag value and an unbindable one', async () => {
      const lacking = await google({ projectLacks: ['compute.instances.createTagBinding'], tag: 'unreadable' }).check(project, [controller]);
      expect(lacking).toMatchObject({ ok: false, message: expect.stringContaining(`compute.instances.createTagBinding on the project ${project}`) });
      expect((lacking as { message: string }).message).toContain(`can't read the tag value ${project}/dormeto/managed`);
      expect(await google({ tag: 'unbindable' }).check(project, [controller])).toMatchObject({ ok: false, message: expect.stringContaining(`resourcemanager.tagValueBindings.create on the tag value ${project}/dormeto/managed`) });
    });

    it('says what the command account is missing and what it can\'t read in a sentence', async () => {
      const connect = 'dormeto gcp connect --project host-project --profile <profile> --env dev';
      const account = 'the command account dmt-dev-command@host-project.iam.gserviceaccount.com';
      expect(await google({ projectLacks: ['compute.instances.createTagBinding'], invoke: false, tag: 'unreadable' }).check(project, [controller])).toEqual({
        ok: false, name: 'AccessDenied',
        message: `${account} is missing compute.instances.createTagBinding on the project ${project}; run.routes.invoke on ${controller} and can't read the tag value ${project}/dormeto/managed: ${connect}`,
      });
      expect(await google({ tag: 'unreadable' }).check(project, [controller])).toEqual({ ok: false, name: 'AccessDenied', message: `${account} can't read the tag value ${project}/dormeto/managed: ${connect}` });
    });

    // The manager acts as the command account through the federation (STS) and the account's grant (iamcredentials): a
    // refusal there comes before any permission is asked, and says so rather than listing every permission as missing.
    it.each([
      ['iamcredentials.googleapis.com', 'IAM_PERMISSION_DENIED', 'Permission \'iam.serviceAccounts.getAccessToken\' denied on resource (or it may not exist).'],
      ['sts.googleapis.com', 'PERMISSION_DENIED', 'The caller does not have permission'],
    ])('says the manager can\'t act as the command account when %s refuses its token', async (host, reason, message) => {
      const calls: string[] = [];
      const call = async (_method: string, url: string) => { calls.push(url); throw new GoogleError({ status: 403, reason, host, message }); };
      expect(await checkProject({ call, connection: async () => connection, env: 'dev' })(project, [controller])).toEqual({
        ok: false, name: 'AccessDenied',
        message: `the manager can't act as the command account dmt-dev-command@host-project.iam.gserviceaccount.com: the workload identity federation or the account's grant to the manager is missing (Google: ${host} 403 ${reason}): dormeto gcp connect --project host-project --profile <profile> --env dev`,
      });
      expect(calls).toHaveLength(1);
    });

    // A revoked federation: STS refuses the exchange with a 400 (the pool or provider gone, its condition refusing the role),
    // as the router calls read it: missing access, never a failure that keeps the last verdict.
    it.each(['invalid_grant', 'invalid_target', 'unauthorized_client'])('says the manager can\'t act as the command account when STS answers %s', async (reason) => {
      const call = async () => { throw new GoogleError({ status: 400, reason, host: 'sts.googleapis.com', message: 'The audience in ID Token does not match the expected audience.' }); };
      expect(await checkProject({ call, connection: async () => connection, env: 'dev' })(project, [controller])).toEqual({
        ok: false, name: 'AccessDenied',
        message: `the manager can't act as the command account dmt-dev-command@host-project.iam.gserviceaccount.com: the workload identity federation or the account's grant to the manager is missing (Google: sts.googleapis.com 400 ${reason}): dormeto gcp connect --project host-project --profile <profile> --env dev`,
      });
    });

    it('lets STS\'s other 400s and its failures through as errors: no verdict', async () => {
      for (const [status, reason] of [[400, 'invalid_request'], [503, '']] as const) {
        const call = async () => { throw new GoogleError({ status, reason, host: 'sts.googleapis.com', message: 'try later' }); };
        await expect(checkProject({ call, connection: async () => connection, env: 'dev' })(project, [controller])).rejects.toThrow('try later');
      }
    });

    it('checks nothing for a project without a router, and says so without a connection', async () => {
      const g = google({ invoke: false, tag: 'unreadable' });
      expect(await g.check(project, [])).toEqual({ ok: true });
      expect(g.calls).toEqual([]);
      const none = checkProject({ call: async () => ({}), connection: async () => null, env: 'dev' });
      expect(await none(project, [controller])).toEqual({ ok: false, name: 'AccessDenied', message: 'no Google Cloud connection: dormeto gcp connect makes one' });
    });

    it('lets a Google failure that is no refusal through as an error: no verdict', async () => {
      await expect(google({ tag: 'down' }).check(project, [controller])).rejects.toThrow('try later');
    });

    it('is reached through the function by a project and its own controllers only; an AWS account is unchanged', async () => {
      const asked: unknown[] = [];
      const handler = checkHandler(async (account) => ({ ok: true, account } as never), async (p, c) => { asked.push([p, c]); return { ok: true }; });
      expect(await handler({ account: project, controllers: [controller] })).toEqual({ ok: true });
      expect(await handler({ account: project })).toEqual({ ok: true });
      for (const controllers of [[`projects/other-project/locations/europe-west2/services/dmtr-europe-west2-controller`], ['projects/dev-project/locations/europe-west2/services/other'], 'x']) {
        expect(await handler({ account: project, controllers })).toMatchObject({ ok: false, name: 'InvalidInput' });
      }
      expect(asked).toEqual([[project, [controller]], [project, []]]);
      expect(await handler({ account: '222222222222' })).toEqual({ ok: true, account: '222222222222' });
      // Without a connection's check wired, a project is no account.
      expect(await checkHandler(async () => ({ ok: true }))({ account: project })).toMatchObject({ name: 'InvalidInput' });
    });
  });
});
