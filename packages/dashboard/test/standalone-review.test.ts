// The final review's words for a standalone workload (M1, M2, M12): what follows a failure, the 7-day bar's tooltip, the nap's
// latest time.
import { describe, expect, it } from 'vitest';
import { retryText } from '../src/failures';

const NOW = Date.UTC(2026, 10, 21, 12, 0);
const rel = (iso: string) => `at ${iso}`;

describe('what follows a standalone workload\'s failure', () => {
  it('names the check and its idle signals, never a request; an HTTP one\'s as before', () => {
    expect(retryText({ state: 'AWAKE' }, NOW, true, rel)).toBe('it naps again once idle');
    expect(retryText({ state: 'FAILED' }, NOW, true, rel)).toBe('the check retries it');
    expect(retryText({ state: 'FAILED', nextAttemptAt: '2026-11-21T12:05:00.000Z' }, NOW, true, rel)).toBe('next attempt at 2026-11-21T12:05:00.000Z');
    expect(retryText({ state: 'AWAKE' }, NOW, false, rel)).toBe('the next request wakes it again');
    expect(retryText({ state: 'FAILED' }, NOW, false, rel)).toBe('the next request retries it');
  });
});

describe('the 7-day bar\'s idle line', () => {
  it('says a standalone workload\'s hours by its signal, an HTTP one\'s by its requests as before', async () => {
    const { idleLine } = await import('../src/discovery');
    const { resourceKindOfArn } = await import('../src/kinds');
    expect(resourceKindOfArn('arn:aws:ec2:eu-west-1:111122223333:instance/i-1')).toBe('instance');
    expect(resourceKindOfArn('arn:aws:autoscaling:eu-west-1:111122223333:autoScalingGroup:x:autoScalingGroupName/w')).toBe('asg');
    expect(resourceKindOfArn('arn:aws:ecs:eu-west-1:111122223333:service/main/worker')).toBe('ecs');
    expect(resourceKindOfArn('arn:aws:rds:eu-west-1:111122223333:db:shop')).toBe('rds-instance');
    expect(resourceKindOfArn('arn:aws:rds:eu-west-1:111122223333:cluster:aurora')).toBe('rds-cluster');
    expect(resourceKindOfArn(undefined)).toBeUndefined();
    expect(idleLine({ idleHours7d: 150, resource: 'instance' })).toBe('Idle: 150 of 168 hours with its CPU under 5 % at every 5-minute point.');
    expect(idleLine({ idleHours7d: 150, resource: 'rds-cluster' })).toBe('Idle: 150 of 168 hours with no database connection at every 5-minute point.');
    expect(idleLine({ idleHours7d: 150, requests7d: 3 })).toBe('Requests: 150 of 168 hours without any request to its target group (3 requests in 7 days).');
  });
});

describe('when an idle nap comes', () => {
  it('the Activity card gives the nap\'s latest time and says once that it comes up to 15 minutes after the window', async () => {
    const { mount, flushPromises } = await import('@vue/test-utils');
    const { createVuetify } = await import('vuetify');
    const components = await import('vuetify/components');
    const { default: ActivityCard } = await import('../src/components/ActivityCard.vue');
    const latestAt = new Date(Date.now() + 25 * 60_000).toISOString();
    const status = {
      workloadId: 'sa', kind: 'standalone', state: 'AWAKE', pauses: [], type: { name: 'instance', from: 'backends' },
      idle: [{ signal: 'cpu', below: 5, value: 1, underSince: new Date(Date.now() - 60 * 60_000).toISOString(), applies: true, from: 'default' }],
      nap: { eligibleAt: new Date(Date.now() + 10 * 60_000).toISOString(), latestAt, inSeconds: 600 }, settings: { idleMinutes: 120, idleMetric: 'off' },
    };
    const w = mount(ActivityCard, { props: { status: status as never, now: Date.now() }, global: { plugins: [createVuetify({ components })] } });
    await flushPromises();
    const nap = w.find('[data-test="nap-estimate"]').text();
    expect(nap).toMatch(/^Nap: eligible in 10 min, at the latest .+$/);
    expect(w.text().match(/up to 15 minutes after/g)).toHaveLength(1);
    expect(w.text()).toContain('CloudWatch publishes the signals minutes late: an idle nap comes up to 15 minutes after the idle window.');
  });

  it('the idle window\'s help says it', async () => {
    const { standaloneSettingRows } = await import('../src/idle-settings');
    const help = standaloneSettingRows({ idleMinutes: 120 } as never, {} as never).find((r) => r.key === 'idleMinutes')!.help;
    expect(help).toContain('an idle nap comes up to 15 minutes after the window, as CloudWatch publishes the signals late');
  });
});

describe('a standalone row\'s type', () => {
  it('has only its kind\'s five settings: the waker\'s are optional (checked by the typecheck)', () => {
    const row: Pick<import('../src/types').WorkloadSummary, 'settings'> = { settings: { idleMinutes: 120, wakeTimeoutSeconds: 600, idleCpuPercent: 5, idleNetworkBytes: 'off', idleMetric: 'off' } };
    expect(Object.keys(row.settings)).toHaveLength(5);
  });
});
