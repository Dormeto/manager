import { describe, expect, it } from 'vitest';
import { backendIcon, backendMdi } from '../src/icons';

describe('backendIcon', () => {
  it('gives the official AWS icon of each backend kind', () => {
    for (const kind of ['instance', 'asg', 'ecs', 'k8s', 'rds-instance', 'rds-cluster']) expect(backendIcon(kind), kind).toMatch(/\.svg|^data:image\/svg/);
    expect(backendIcon('k8s')).not.toEqual(backendIcon('ecs'));
    expect(backendIcon('instance')).not.toEqual(backendIcon('asg'));
    expect(backendIcon('rds-cluster')).not.toEqual(backendIcon('rds-instance'));
    expect(backendIcon('unknown')).toBeNull();
  });

  it('gives a Material Design icon to each Google Cloud backend kind (Google\'s own product icons are not bundled)', () => {
    for (const kind of ['instance', 'asg', 'k8s', 'cloudsql-instance']) expect(backendMdi(kind), kind).toMatch(/^M[\d.\s,a-zA-Z-]+$/);
    expect(backendMdi('ecs')).toBeNull();
    expect(backendIcon('cloudsql-instance')).toBeNull();
  });
});
