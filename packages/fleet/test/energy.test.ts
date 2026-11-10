// The energy and carbon a nap saves (energy.ts: the API computes it, the dashboard's demo mode too): an estimate from what the
// nap stopped, never a measure.
import { describe, expect, it } from 'vitest';
import { addEnergy, gridIntensity, itemWatts, savedEnergy, shape } from '../src/energy.js';

describe('energy', () => {
  it('reads an instance type or a database class into vCPU and memory', () => {
    expect(shape('t3.small')).toEqual({ vcpu: 2, memoryGb: 2 });
    expect(shape('m6i.large')).toEqual({ vcpu: 2, memoryGb: 8 });
    expect(shape('c6g.medium')).toEqual({ vcpu: 1, memoryGb: 2 });
    expect(shape('db.r6g.xlarge')).toEqual({ vcpu: 4, memoryGb: 32 });
    expect(shape('weird')).toBeNull();
  });

  it('prices nothing it cannot shape, and nothing a non-autoscaled pod saves', () => {
    expect(itemWatts({ kind: 'unknown', backend: 'x', reason: 'r' })).toBeNull();
    expect(itemWatts({ kind: 'ec2', type: 'weird', count: 1, os: 'linux' })).toBeNull();
    expect(itemWatts({ kind: 'k8s-pods', count: 2, cpu: 1, memoryGb: 2, nodeType: 'm6i.large', os: 'linux', autoscaled: false, allocatable: { cpu: 2, memoryGb: 8 } })).toBeNull();
    // 2 vCPU at 50% (0.74 + 0.5 × 2.76 = 2.12 W each) and 2 GB (0.392 W each), times the PUE (1.135), twice.
    expect(itemWatts({ kind: 'ec2', type: 't3.small', count: 2, os: 'linux' })).toBeCloseTo(2 * (2 * 2.12 + 2 * 0.392) * 1.135, 6);
    expect(itemWatts({ kind: 'rds', class: 'db.t4g.micro', engine: 'postgres', multiAz: true })).toBeCloseTo(2 * (2 * 2.12 + 0.392) * 1.135, 6);
    expect(itemWatts({ kind: 'k8s-pods', count: 3, cpu: 0.5, memoryGb: 1, nodeType: 'm6i.large', os: 'linux', autoscaled: true, allocatable: { cpu: 2, memoryGb: 8 } }))
      .toBeCloseTo(3 * (0.5 * 2.12 + 0.392) * 1.135, 6);
  });

  it('counts the hours asleep and the region\'s grid; an unknown region at the average', () => {
    const items = [{ kind: 'fargate' as const, vcpu: 1, memoryGb: 2, count: 1, arch: 'x86_64', os: 'linux' }];
    const ireland = savedEnergy(items, 400, 'eu-west-1');
    const paris = savedEnergy(items, 400, 'eu-west-3');
    expect(ireland.kwh).toBeCloseTo(((2.12 + 2 * 0.392) * 1.135 * 400) / 1000, 6);
    expect(ireland.co2Kg).toBeCloseTo(ireland.kwh * 0.279, 9);
    expect(paris.kwh).toBe(ireland.kwh);
    expect(paris.co2Kg).toBeCloseTo(paris.kwh * 0.051, 9);
    expect(gridIntensity('mars-1')).toBeCloseTo(5.605 / 17, 6);
    expect(savedEnergy([{ kind: 'unknown', backend: 'x', reason: 'r' }], 400, 'eu-west-1')).toEqual({ kwh: 0, co2Kg: 0, estimated: 0 });
  });

  it('estimates a Google Cloud VM or database with Cloud Carbon Footprint\'s figures, on its own region\'s grid', () => {
    const vm = (machineType: string, family: string, vcpus: number, memoryGb: number, count = 1) =>
      ({ kind: 'gce' as const, machineType, family, vcpus, memoryGb, count, os: 'Linux' as const, zone: 'europe-west1-b' });
    // e2-small: 0.5 vCPU at 50% (0.68 + 0.5 × 3.43), 2 GB, PUE 1.1.
    expect(itemWatts(vm('e2-small', 'e2', 0.5, 2))).toBeCloseTo(2.17965, 6);
    expect(itemWatts(vm('e2-small', 'e2', 0.5, 2, 3))).toBeCloseTo(3 * 2.17965, 6);
    expect(itemWatts(vm('n2-standard-2', 'n2', 2, 8))).toBeCloseTo(8.3336, 6);
    const e = savedEnergy([vm('e2-small', 'e2', 0.5, 2)], 10, 'eu-west-1');
    expect(e.kwh).toBeCloseTo(0.0217965, 7);
    expect(e.co2Kg).toBeCloseTo(0.002245, 6);
    expect(e.estimated).toBe(1);
    const sql = { kind: 'cloudsql' as const, tier: 'db-custom-2-8192', engine: 'postgres' as const, edition: 'enterprise' as const, ha: false, region: 'europe-west1', vcpus: 2, memoryGb: 8 };
    const zonal = itemWatts(sql);
    expect(zonal).toBeCloseTo((2 * (0.68 + 0.5 * 3.43) + 8 * 0.392) * 1.1, 6);
    expect(itemWatts({ ...sql, ha: true })).toBeCloseTo(2 * zonal!, 6);
    expect(itemWatts({ kind: 'cloudsql', tier: 'db-f1-micro', engine: 'mysql', edition: 'enterprise', ha: false, region: 'europe-west1' })).toBeNull();
    expect(savedEnergy([sql], 10, 'eu-west-1').co2Kg).toBeCloseTo(savedEnergy([sql], 10, 'eu-west-1').kwh * 0.103, 9);
  });

  it('reads Google Cloud\'s grid for its regions, 0.3101 for an unknown one, AWS\'s untouched', () => {
    expect(gridIntensity('europe-west1')).toBe(0.103);
    expect(gridIntensity('europe-west99')).toBe(0.3101);
    expect(gridIntensity('eu-west-1')).toBe(0.279);
    expect(gridIntensity('mars-1')).toBeCloseTo(5.605 / 17, 6);
  });

  it('adds up estimates', () => {
    expect(addEnergy({ kwh: 1, co2Kg: 0.5, estimated: 2 }, { kwh: 0.5, co2Kg: 0.25, estimated: 1 })).toEqual({ kwh: 1.5, co2Kg: 0.75, estimated: 3 });
  });
});
