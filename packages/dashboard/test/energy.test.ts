// How the energy and carbon a nap saves are said (energy.ts): the API estimates them (packages/api/test/energy.test.ts).
import { describe, expect, it } from 'vitest';
import { equivalents, rounded } from '../src/energy';

describe('energy', () => {
  it('gives everyday equivalents and rounds them to two significant digits', () => {
    const [phone, , , car] = equivalents({ kwh: 1.5, co2Kg: 0.4, estimated: 1 });
    expect(phone?.value).toBeCloseTo(100, 6);
    expect(car?.value).toBeCloseTo(2, 6);
    expect(rounded(1234)).toBe('1,200');
    expect(rounded(0.456)).toBe('0.46');
    expect(rounded(0)).toBe('0');
  });
});
