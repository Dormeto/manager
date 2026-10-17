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

  it('adds up estimates', () => {
    expect(addEnergy({ kwh: 1, co2Kg: 0.5, estimated: 2 }, { kwh: 0.5, co2Kg: 0.25, estimated: 1 })).toEqual({ kwh: 1.5, co2Kg: 0.75, estimated: 3 });
  });
});
