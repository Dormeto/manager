// The energy and carbon a nap saves (energy.ts): an estimate from what the nap stopped, never a measure.
import { describe, expect, it } from 'vitest';
import { equivalents, gridIntensity, itemWatts, rounded, savedEnergy, shape } from '../src/energy';

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
    expect(itemWatts({ kind: 'k8s-pods', count: 2, cpu: 1, memoryGb: 2, nodeType: 'm6i.large', os: 'linux', autoscaled: false, allocatable: { cpu: 2, memoryGb: 8 } })).toBeNull();
    expect(itemWatts({ kind: 'ec2', type: 't3.small', count: 2, os: 'linux' })).toBeCloseTo(2 * (2 * 2.12 + 2 * 0.392) * 1.135, 6);
  });

  it('counts the hours asleep and the region\'s grid', () => {
    const items = [{ kind: 'fargate' as const, vcpu: 1, memoryGb: 2, count: 1, arch: 'x86_64', os: 'linux' }];
    const ireland = savedEnergy(items, 400, 'eu-west-1');
    const paris = savedEnergy(items, 400, 'eu-west-3');
    expect(ireland.kwh).toBeCloseTo(((2.12 + 2 * 0.392) * 1.135 * 400) / 1000, 6);
    expect(paris.kwh).toBe(ireland.kwh);
    expect(paris.co2Kg).toBeLessThan(ireland.co2Kg);
    expect(gridIntensity('mars-1')).toBeGreaterThan(0);
  });

  it('gives everyday equivalents and rounds them to two significant digits', () => {
    const [phone, , , car] = equivalents({ kwh: 1.5, co2Kg: 0.4, estimated: 1 });
    expect(phone?.value).toBeCloseTo(100, 6);
    expect(car?.value).toBeCloseTo(2, 6);
    expect(rounded(1234)).toBe('1,200');
    expect(rounded(0.456)).toBe('0.46');
    expect(rounded(0)).toBe('0');
  });
});
