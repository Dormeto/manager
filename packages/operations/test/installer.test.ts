import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import published from './fixtures/blueprint.json' with { type: 'json' };
import { fill, type Blueprint } from '../src/blueprint.js';
import { INSTALL_STEPS, RetryLater, UNINSTALL_STEPS, createInstaller } from '../src/installer.js';
import { fakeInstallAccount } from './install-fake.js';

const VALUES = {
  name: 'dmtr-dev', region: 'eu-west-3', account: '121014831971', partition: 'aws', checkSchedule: 'rate(5 minutes)', ipLists: '[]', noWakeRules: '[]', metrics: 'false',
  managerBus: 'arn:aws:events:eu-west-1:121014831971:event-bus/dmt-dev-manager',
};
const BOUNDARY = 'arn:aws:iam::121014831971:policy/DmtRouterBoundary';
const PRINCIPALS = ['arn:aws:iam::121014831971:role/dmt-dev-manager-api'];
const ZIP = new Uint8Array([1, 2, 3]);

const blueprintOf = (over: Partial<typeof VALUES> = {}) => fill(published as unknown as Blueprint, { ...VALUES, ...over });

function setup(zip = ZIP) {
  const account = fakeInstallAccount();
  const installer = createInstaller(account.ports, { boundaryArn: BOUNDARY, principals: PRINCIPALS, zip: async () => zip, codeSha256: createHash('sha256').update(zip).digest('base64') });
  return { ...account, installer };
}

// Each step until it is no longer pending or asked to retry (the workflow waits between attempts).
async function installAll(s: ReturnType<typeof setup>, blueprint: Blueprint) {
  const statuses: string[] = [];
  for (const step of INSTALL_STEPS) {
    let changed = false;
    for (let attempt = 0; ; attempt += 1) {
      if (attempt > 6) throw new Error(`${step} never settled`);
      try {
        const result = await s.installer.install(step, blueprint);
        changed ||= result.changed === true;
        if (result.status !== 'pending') {
          statuses.push(changed ? 'done' : result.status);
          break;
        }
      } catch (err) {
        if (!(err instanceof RetryLater)) throw err;
      }
    }
  }
  return statuses;
}

describe('installer', () => {
  it('installs every resource of the blueprint, roles within the boundary, waiting for the table and the IAM propagation', async () => {
    const s = setup();
    const b = blueprintOf();
    expect(await s.installer.install('table', b)).toEqual({ status: 'pending', detail: 'table dmtr-dev-router CREATING', changed: true });
    expect(await installAll(s, b)).toEqual(INSTALL_STEPS.map(() => 'done'));
    expect([...s.state.roles.keys()]).toEqual(['dmtr-dev-eu-west-3-controller', 'dmtr-dev-eu-west-3-waker', 'dmtr-dev-eu-west-3-scheduler', 'dmtr-dev-eu-west-3-onboarder']);
    for (const role of s.state.roles.values()) {
      expect(role.path).toBe('/dormeto/router/');
      expect(role.boundary).toBe(BOUNDARY);
      expect(role.tags).toEqual({ 'dormeto:router': 'dmtr-dev' });
      expect(role.policies.size).toBe(1);
    }
    expect(JSON.parse(s.state.roles.get('dmtr-dev-eu-west-3-onboarder')!.policies.get('onboarder')!)).toEqual(b.roles[3]!.policy);
    expect(s.state.tables.get('dmtr-dev-router')).toMatchObject({ status: 'ACTIVE', ttl: 'expiresAt', pitr: true, tags: { 'dormeto:router': 'dmtr-dev' } });
    expect([...s.state.queues.keys()]).toEqual(['dmtr-dev-check-failures', 'dmtr-dev-controller-failures']);
    expect(s.state.queues.get('dmtr-dev-check-failures')!.attributes).toEqual({ MessageRetentionPeriod: '1209600', SqsManagedSseEnabled: 'true' });
    expect([...s.state.logGroups].map(([n, g]) => [n, g.retention])).toEqual([
      ['/aws/lambda/dmtr-dev-controller', 14], ['/aws/lambda/dmtr-dev-waker', 14], ['/aws/lambda/dmtr-dev-onboarder', 14],
    ]);
    expect([...s.state.functions.keys()]).toEqual(['dmtr-dev-controller', 'dmtr-dev-waker', 'dmtr-dev-onboarder']);
    expect(s.state.functions.get('dmtr-dev-controller')!.config).toMatchObject({
      Role: 'arn:aws:iam::121014831971:role/dormeto/router/dmtr-dev-eu-west-3-controller', Handler: 'controller.handler', Runtime: 'nodejs24.x', Timeout: 900, MemorySize: 256, Architectures: ['arm64'],
    });
    expect(s.state.functions.get('dmtr-dev-controller')!.asyncInvoke).toMatchObject({ MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 120, DestinationConfig: { OnFailure: { Destination: 'arn:aws:sqs:eu-west-3:121014831971:dmtr-dev-controller-failures' } } });
    expect([...s.state.functions.get('dmtr-dev-controller')!.permissions.values()]).toEqual(PRINCIPALS);
    expect([...s.state.functions.get('dmtr-dev-onboarder')!.permissions.values()]).toEqual([...PRINCIPALS, 'events.amazonaws.com arn:aws:events:eu-west-3:121014831971:rule/dmtr-dev-drift']);
    const drift = s.state.eventRules.get('dmtr-dev-drift')!;
    expect(drift.state).toBe('ENABLED');
    expect(JSON.parse(drift.pattern).$or[0].detail.userIdentity.arn).toEqual([{ 'anything-but': { prefix: 'arn:aws:sts::121014831971:assumed-role/dmtr-dev-' } }]);
    expect(drift.targets).toEqual([{ Id: 'onboarder', Arn: 'arn:aws:lambda:eu-west-3:121014831971:function:dmtr-dev-onboarder' }]);
    // One permission for every waker target group of the router (routers 0.20.0 and later).
    expect([...s.state.functions.get('dmtr-dev-waker')!.permissions]).toEqual([
      ['dormeto-alb', 'elasticloadbalancing.amazonaws.com arn:aws:elasticloadbalancing:eu-west-3:121014831971:targetgroup/dmtr-dev-*/*'],
    ]);
    expect(s.state.schedules.get('dmtr-dev-check')).toMatchObject({
      ScheduleExpression: 'rate(5 minutes)', FlexibleTimeWindow: { Mode: 'OFF' },
      Target: { Arn: 'arn:aws:lambda:eu-west-3:121014831971:function:dmtr-dev-controller', RetryPolicy: { MaximumRetryAttempts: 0 }, DeadLetterConfig: { Arn: 'arn:aws:sqs:eu-west-3:121014831971:dmtr-dev-check-failures' } },
    });
  });

  it('retries the waker permission on a conflict (a function being updated) and never skips it while it is missing', async () => {
    const s = setup();
    await installAll(s, blueprintOf());
    s.state.functions.get('dmtr-dev-waker')!.permissions.clear();
    s.state.conflicts = 1;
    await expect(s.installer.install('permissions', blueprintOf())).rejects.toBeInstanceOf(RetryLater);
    await s.installer.install('permissions', blueprintOf());
    expect([...s.state.functions.get('dmtr-dev-waker')!.permissions.keys()]).toEqual(['dormeto-alb']);
  });

  it('replaces a waker permission whose source differs from the blueprint', async () => {
    const s = setup();
    await installAll(s, blueprintOf());
    s.state.functions.get('dmtr-dev-waker')!.permissions.set('dormeto-alb', 'elasticloadbalancing.amazonaws.com arn:aws:elasticloadbalancing:eu-west-3:121014831971:targetgroup/other-*/*');
    expect((await s.installer.install('permissions', blueprintOf())).status).toBe('done');
    expect(s.state.functions.get('dmtr-dev-waker')!.permissions.get('dormeto-alb')).toBe('elasticloadbalancing.amazonaws.com arn:aws:elasticloadbalancing:eu-west-3:121014831971:targetgroup/dmtr-dev-*/*');
  });

  it('an upgrade adds the waker permission before any function runs the new code (onboardings rely on it)', async () => {
    const s = setup();
    const { wakerPermission: _w, ...older } = blueprintOf();
    await installAll(s, older as Blueprint);
    const code = new Uint8Array([9, 9]);
    const installer = createInstaller(s.ports, { boundaryArn: BOUNDARY, principals: PRINCIPALS, zip: async () => code, codeSha256: createHash('sha256').update(code).digest('base64') });
    s.state.calls.length = 0;
    await installer.install('functions', blueprintOf());
    expect(s.state.calls.filter((c) => c === 'addPermission' || c === 'updateFunctionCode')[0]).toBe('addPermission');
    expect(s.state.functions.get('dmtr-dev-waker')!.permissions.has('dormeto-alb')).toBe(true);
  });

  it('adds no waker permission for a blueprint older than 0.20.0 (its onboarder adds one per workload)', async () => {
    const s = setup();
    const { wakerPermission: _w, ...older } = blueprintOf();
    await installAll(s, older as Blueprint);
    expect(s.state.functions.get('dmtr-dev-waker')!.permissions.size).toBe(0);
  });

  it('asks to retry when Lambda cannot assume a new role yet', async () => {
    const s = setup();
    const b = blueprintOf();
    for (const step of INSTALL_STEPS.slice(0, 4)) while ((await s.installer.install(step, b)).status === 'pending');
    await expect(s.installer.install('functions', b)).rejects.toThrow(RetryLater);
  });

  it('installs again without changing anything', async () => {
    const s = setup();
    await installAll(s, blueprintOf());
    s.state.calls.length = 0;
    expect(await installAll(s, blueprintOf())).toEqual(INSTALL_STEPS.map(() => 'skipped'));
    expect(s.state.calls.filter((c) => /^(create|update|put|add|delete)/.test(c))).toEqual([]);
  });

  it('upgrades to a new version: policies, configuration and code', async () => {
    const s = setup();
    await installAll(s, blueprintOf());
    const next = blueprintOf({ metrics: 'true' });
    next.roles[0]!.policy.Statement.push({ Effect: 'Allow', Action: ['xray:PutTraceSegments'], Resource: ['*'] });
    for (const f of next.functions) f.environment.DMT_VERSION = '0.18.0';
    const upgraded = setup(new Uint8Array([9, 9]));
    upgraded.state.roles = s.state.roles; upgraded.state.tables = s.state.tables; upgraded.state.queues = s.state.queues;
    upgraded.state.logGroups = s.state.logGroups; upgraded.state.functions = s.state.functions; upgraded.state.schedules = s.state.schedules;
    upgraded.state.eventRules = s.state.eventRules;
    expect(await installAll(upgraded, next)).toEqual(['done', 'skipped', 'skipped', 'skipped', 'done', 'skipped', 'skipped', 'skipped', 'skipped']);
    expect(JSON.parse(s.state.roles.get('dmtr-dev-eu-west-3-controller')!.policies.get('controller')!).Statement).toHaveLength(15);
    const controller = s.state.functions.get('dmtr-dev-controller')!;
    expect((controller.config.Environment as { Variables: Record<string, string> }).Variables).toMatchObject({ DMT_VERSION: '0.18.0', DMT_METRICS: 'true' });
    expect(controller.codeSha256).toBe(createHash('sha256').update(new Uint8Array([9, 9])).digest('base64'));
  });

  it('refuses to adopt a role that exists without the permissions boundary', async () => {
    const s = setup();
    await s.ports.iam.createRole({ RoleName: 'dmtr-dev-eu-west-3-controller', AssumeRolePolicyDocument: '{}' });
    await expect(s.installer.install('roles', blueprintOf())).rejects.toThrow('role dmtr-dev-eu-west-3-controller exists without the permissions boundary DmtRouterBoundary: not created by Dormeto');
  });

  it('uninstalls every resource in reverse order, then finds nothing to do', async () => {
    const s = setup();
    const b = blueprintOf();
    await installAll(s, b);
    const statuses = [];
    for (const step of UNINSTALL_STEPS) statuses.push((await s.installer.uninstall(step, b)).status);
    expect(statuses).toEqual(UNINSTALL_STEPS.map(() => 'done'));
    expect([s.state.roles.size, s.state.tables.size, s.state.queues.size, s.state.logGroups.size, s.state.functions.size, s.state.schedules.size, s.state.eventRules.size]).toEqual([0, 0, 0, 0, 0, 0, 0]);
    const again = [];
    for (const step of UNINSTALL_STEPS) again.push((await s.installer.uninstall(step, b)).status);
    expect(again).toEqual(UNINSTALL_STEPS.map(() => 'skipped'));
  });
});
