// What a nap stopped, as the manager keeps it (clean.ts): the known kinds, each field of its type and bounds; a Google
// Cloud router's items (routers 0.40.0, Google Cloud design §9.1) beside AWS's.
import { describe, expect, it } from 'vitest';
import { stoppedOf } from '../src/clean.js';

const gce = { kind: 'gce', machineType: 'e2-small', family: 'e2', vcpus: 0.5, memoryGb: 2, count: 2, os: 'Linux', spot: true, suspended: true, zone: 'europe-west2-b' };
const sql = { kind: 'cloudsql', tier: 'db-custom-2-7680', engine: 'postgres', edition: 'enterprise', ha: true, region: 'europe-west2', vcpus: 2, memoryGb: 7.5 };

describe('stopped items', () => {
  it('keeps a Google Cloud VM and a Cloud SQL instance, their known fields only', () => {
    expect(stoppedOf([
      { ...gce, extra: 'dropped' },
      { kind: 'gce', machineType: 'n2d-custom-4-8192', family: 'n2d', vcpus: 4, memoryGb: 8, count: 1, os: 'Windows', spot: 'yes', suspended: false, zone: 'us-central1-a' },
      sql,
      { kind: 'cloudsql', tier: 'db-f1-micro', engine: 'mysql', edition: 'enterprise', ha: 'yes', region: 'europe-west1' },
      { kind: 'cloudsql', tier: 'db-perf-optimized-N-4', engine: 'postgres', edition: 'enterprise-plus', ha: false, region: 'europe-west1', vcpus: 4, memoryGb: 32 },
      { kind: 'unknown', backend: 'cloudsql-instance:orders', reason: 'Cloud SQL could not be read' },
    ])).toEqual([
      gce,
      { kind: 'gce', machineType: 'n2d-custom-4-8192', family: 'n2d', vcpus: 4, memoryGb: 8, count: 1, os: 'Windows', zone: 'us-central1-a' },
      sql,
      { kind: 'cloudsql', tier: 'db-f1-micro', engine: 'mysql', edition: 'enterprise', ha: false, region: 'europe-west1' },
      { kind: 'cloudsql', tier: 'db-perf-optimized-N-4', engine: 'postgres', edition: 'enterprise-plus', ha: false, region: 'europe-west1', vcpus: 4, memoryGb: 32 },
      { kind: 'unknown', backend: 'cloudsql-instance:orders', reason: 'Cloud SQL could not be read' },
    ]);
  });

  it('drops a Google Cloud item outside its bounds: no vCPU, another engine, a region for a zone, and the like', () => {
    expect(stoppedOf([
      { ...gce, vcpus: 0 },
      { ...gce, vcpus: 1025 },
      { ...gce, memoryGb: 12_289 },
      { ...gce, count: 0 },
      { ...gce, os: 'linux' },
      { ...gce, zone: 'europe-west2' },
      { ...gce, machineType: 'e2.small' },
      { ...gce, family: 'E2' },
      { ...sql, engine: 'oracle' },
      { ...sql, edition: 'standard' },
      { ...sql, tier: 'n1-standard-2' },
      { ...sql, region: 'eu-west-1' },
    ])).toEqual([]);
  });

  it('keeps a Cloud SQL instance whose shape is out of bounds without its shape (not priced, its hours kept)', () => {
    expect(stoppedOf([{ ...sql, vcpus: 0, memoryGb: 'x' }])).toEqual([{ kind: 'cloudsql', tier: 'db-custom-2-7680', engine: 'postgres', edition: 'enterprise', ha: true, region: 'europe-west2' }]);
  });

  it('keeps AWS\'s items as before', () => {
    const aws = [
      { kind: 'ec2', type: 't3.medium', count: 2, os: 'Linux', spot: true },
      { kind: 'fargate', vcpu: 0.5, memoryGb: 1, count: 2, arch: 'x86_64', os: 'Linux' },
      { kind: 'rds', class: 'db.t4g.micro', engine: 'postgres', multiAz: true },
      { kind: 'aurora-serverless', engine: 'aurora-mysql', acu: 0.5 },
      { kind: 'k8s-pods', count: 2, cpu: 0.5, memoryGb: 1, nodeType: 'm5.large', os: 'Linux', autoscaled: true, allocatable: { cpu: 1.93, memoryGb: 6.886 } },
      { kind: 'unknown', backend: 'ecs:web', reason: 'denied' },
    ];
    expect(stoppedOf(aws)).toEqual(aws);
    expect(stoppedOf([{ kind: 'ec2', type: 't3.medium', count: 0, os: 'Linux' }, { kind: 'rds', class: 'm5.large', engine: 'postgres' }])).toEqual([]);
  });
});
