// The energy a nap saves, and its carbon, as the API estimates it (packages/fleet/src/energy.ts: what the nap stopped times
// the hours asleep, with Cloud Carbon Footprint's coefficients for AWS and each region's grid intensity); here, only how
// it is said. Not a measure: the instances' real load and AWS's own figures differ.

// estimated: how many items had a known shape (none: no estimate).
export interface Energy { kwh: number; co2Kg: number; estimated: number }
// The fleet's (GET /workloads/states): workloads, how many had an estimate.
export interface FleetEnergy extends Energy { workloads: number }

// Everyday equivalents (sources: a smartphone charge ≈ 15 Wh; an hour of video streaming ≈ 77 Wh, IEA 2020; a cup of tea,
// 25 cl boiled ≈ 25 Wh; a petrol car ≈ 0.2 kg CO2e per km, ADEME).
export interface Equivalent { icon: 'phone' | 'stream' | 'tea' | 'car'; value: number; text: string }
export function equivalents(e: Energy): Equivalent[] {
  return [
    { icon: 'phone', value: e.kwh / 0.015, text: 'smartphone charges' },
    { icon: 'stream', value: e.kwh / 0.077, text: 'hours of video streaming' },
    { icon: 'tea', value: e.kwh / 0.025, text: 'cups of tea boiled' },
    { icon: 'car', value: e.co2Kg / 0.2, text: 'km not driven by a petrol car' },
  ];
}

// Two significant digits, as estimates deserve.
export function rounded(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  const digits = Math.max(0, 1 - Math.floor(Math.log10(value)));
  const v = Number(value.toFixed(Math.min(2, digits)));
  return v.toLocaleString('en-US', { maximumSignificantDigits: 2 });
}
