// The last run's problems of every target, ok ones included (the review's I2): the standalone scan without the discovery role's
// RDS actions, an idle share unread. A notice above the candidates, a line a problem with its account and region.
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import RunProblems from '../src/components/RunProblems.vue';

const RDS = 'RDS instances not listed: the discovery role may not call rds:DescribeDBInstances (apply the access module or the AWS CLI script of this release again)';
const IDLE = 'the idle share of 3 standalone candidates could not be read: ThrottlingException: Rate exceeded';
const mountIt = (targets: unknown[]) => mount(RunProblems, { props: { targets: targets as never }, global: { plugins: [createVuetify({ components, directives })] } });

describe('the last run\'s problems', () => {
  it('says each problem of an ok target with its account and region', () => {
    const w = mountIt([
      { account: '111122223333', region: 'eu-west-1', status: 'ok', rules: 4, problems: [RDS, IDLE] },
      { account: '444455556666', region: 'eu-west-3', status: 'ok', rules: 1 },
      { account: '777788889999', region: 'us-east-1', status: 'error', error: 'AccessDenied', problems: ['not said twice: the failure says it'] },
    ]);
    expect(w.find('[data-test="run-problems"]').exists()).toBe(true);
    expect(w.findAll('[data-test="run-problem"]').map((l) => l.text())).toEqual([`111122223333 · eu-west-1: ${RDS}`, `111122223333 · eu-west-1: ${IDLE}`]);
    expect(w.text()).toContain('The last run read these accounts and regions without all it should:');
  });

  it('shows nothing without a problem', () => {
    expect(mountIt([{ account: '111122223333', region: 'eu-west-1', status: 'ok', rules: 4 }]).find('[data-test="run-problems"]').exists()).toBe(false);
  });
});
