import { describe, expect, it } from 'vitest';
import { operationProgress, operationTitle, stepColor } from '../src/operations';
import type { Operation } from '../src/types';

const op = (over: Partial<Operation> = {}): Operation => ({
  id: 'op1', type: 'onboard', target: { account: '121014831971', region: 'eu-west-3', targetGroupArn: 'arn:aws:elasticloadbalancing:eu-west-3:1:targetgroup/paris-app/73e2d6bc24d8a067' },
  input: { name: 'Paris' }, status: 'running', cursor: 2, by: 'ops@example.com', createdAt: '2026-10-05T12:00:00.000Z', updatedAt: '2026-10-05T12:00:10.000Z',
  steps: [{ name: 'find router', status: 'done' }, { name: 'lock router', status: 'skipped' }, { name: 'preview', status: 'running', detail: 'waiting' }, { name: 'onboard', status: 'pending' }],
  ...over,
});

describe('operations', () => {
  it('titles an operation by what it does', () => {
    // By the names people gave (the workload id is not for them).
    expect(operationTitle(op())).toBe('Onboard paris-app as Paris');
    expect(operationTitle(op({ input: {}, context: { name: 'paris-app' } }))).toBe('Onboard paris-app as paris-app');
    expect(operationTitle(op({ input: {} }))).toBe('Onboard paris-app');
    expect(operationTitle(op({ type: 'offboard', target: { router: 'dmt-dev', workloadId: '7010ea54b5c02245', account: '1', region: 'eu-west-3' }, input: {}, context: { name: 'Paris' } }))).toBe('Offboard Paris from dmt-dev');
    expect(operationTitle(op({ type: 'offboard', target: { router: 'dmt-dev', workloadId: '7010ea54b5c02245', account: '1', region: 'eu-west-3' }, input: { name: 'Not checked' } }))).toBe('Offboard 7010ea54b5c02245 from dmt-dev');
    expect(operationTitle(op({ type: 'offboard', target: { router: 'dmt-dev', workloadId: 'demo', account: '1', region: 'eu-west-3' }, input: {} }))).toBe('Offboard demo from dmt-dev');
    expect(operationTitle(op({ type: 'install-router', target: { account: '121014831971', region: 'eu-west-3' }, input: {} }))).toBe('Install a router in 121014831971/eu-west-3');
    expect(operationTitle(op({ type: 'exclude', target: { exclusionId: 'x1', account: '121014831971' }, input: {} }))).toBe('Pause the workloads of an exclusion in 121014831971');
    expect(operationTitle(op({ type: 'lift-exclusion', target: { exclusionId: 'x1', account: '121014831971' }, input: {} }))).toBe('Resume the workloads of a lifted exclusion in 121014831971');
    expect(operationTitle(op({ type: 'upgrade-router', target: { account: '1', region: 'eu-west-3' }, input: {} }))).toBe('Upgrade the router of 1/eu-west-3');
    expect(operationTitle(op({ type: 'uninstall-router', target: { account: '1', region: 'eu-west-3' }, input: {} }))).toBe('Uninstall the router of 1/eu-west-3');
    // Event-driven refresh (packaging design §5): an account's forwarder.
    expect(operationTitle(op({ type: 'connect-account', target: { account: '121014831971' }, input: { regions: ['eu-west-1', 'eu-west-3'] } }))).toBe('Connect 121014831971 to event-driven refresh (eu-west-1, eu-west-3)');
    expect(operationTitle(op({ type: 'disconnect-account', target: { account: '121014831971' }, input: { regions: [] } }))).toBe('Disconnect 121014831971 from event-driven refresh');
    // The manager's update, by the request of the Update page.
    const target = { account: '121014831971', region: 'eu-west-1', version: '0.13.0' };
    expect(operationTitle(op({ type: 'update-manager', target, input: { action: 'plan', version: '0.13.0', request: 'r' } }))).toBe('Prepare the update of the manager to 0.13.0');
    expect(operationTitle(op({ type: 'update-manager', target, input: { action: 'apply', version: '0.13.0', request: 'r', planBuild: 'p' } }))).toBe('Update the manager to 0.13.0');
  });

  it('shows the progress over the steps that ran', () => {
    expect(operationProgress(op())).toEqual({ done: 2, total: 4, current: 'preview: waiting' });
    expect(operationProgress(op({ status: 'succeeded', cursor: 4, steps: op().steps.map((s) => ({ ...s, status: 'done' })) }))).toEqual({ done: 4, total: 4, current: null });
  });

  it('colors steps by status', () => {
    expect(['done', 'skipped', 'running', 'pending', 'failed'].map(stepColor)).toEqual(['success', 'grey', 'primary', 'grey', 'error']);
  });

});
