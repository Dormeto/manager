// The command role check of discovery (packaging design §3): the operations Lambda, which the role trusts, assumes it
// afresh (never from a cache: a role deleted since shows at once).
import { describe, expect, it } from 'vitest';
import { checkHandler, checkRole } from '../src/aws.js';

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
});
