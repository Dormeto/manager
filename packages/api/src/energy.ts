// The energy a nap saves, and its carbon, as an estimate (the overview's energy card, a workload's costs area): what the
// nap stopped (its items) times the hours asleep, with Cloud Carbon Footprint's coefficients for AWS (compute at 50%
// utilisation, memory, the data centres' PUE) and the region's grid intensity. Not a measure: the instances' real load and
// AWS's own figures differ. The dashboard's demo mode imports it too (@dormeto/manager-api/energy).
import type { StoppedItem } from '@dormeto/fleet';

// Cloud Carbon Footprint, AWS: watts per vCPU at 0% and 100%, watts per GB of memory, power usage effectiveness.
const MIN_W = 0.74, MAX_W = 3.5, UTILISATION = 0.5, MEMORY_W = 0.392, PUE = 1.135;
// kg CO2e per kWh by region (Cloud Carbon Footprint's grid factors); others: the average of these.
const GRID: Record<string, number> = {
  'us-east-1': 0.379, 'us-east-2': 0.411, 'us-west-1': 0.322, 'us-west-2': 0.322, 'ca-central-1': 0.13, 'sa-east-1': 0.062,
  'eu-west-1': 0.279, 'eu-west-2': 0.225, 'eu-west-3': 0.051, 'eu-central-1': 0.311, 'eu-north-1': 0.009, 'eu-south-1': 0.233,
  'ap-south-1': 0.708, 'ap-southeast-1': 0.408, 'ap-southeast-2': 0.79, 'ap-northeast-1': 0.465, 'ap-northeast-2': 0.5,
};
const AVERAGE_GRID = Object.values(GRID).reduce((a, b) => a + b, 0) / Object.keys(GRID).length;
export const gridIntensity = (region: string): number => GRID[region] ?? AVERAGE_GRID;

const SIZE_VCPU: Record<string, number> = { nano: 2, micro: 2, small: 2, medium: 2, large: 2, xlarge: 4, '2xlarge': 8, '3xlarge': 12, '4xlarge': 16, '6xlarge': 24,
  '8xlarge': 32, '9xlarge': 36, '12xlarge': 48, '16xlarge': 64, '18xlarge': 72, '24xlarge': 96, '32xlarge': 128, '48xlarge': 192, metal: 96 };
const T_MEMORY: Record<string, number> = { nano: 0.5, micro: 1, small: 2, medium: 4, large: 8, xlarge: 16, '2xlarge': 32 };
const GB_PER_VCPU: Record<string, number> = { c: 2, m: 4, r: 8, x: 16, z: 8, i: 8, d: 8, h: 4 };

// vCPU and memory of an EC2 instance type or an RDS class (db.<type>), from its family and size; null when unknown.
export function shape(type: string): { vcpu: number; memoryGb: number } | null {
  const [family, size] = type.replace(/^db\./, '').split('.');
  if (!family || !size || SIZE_VCPU[size] === undefined) return null;
  if (family.startsWith('t')) return T_MEMORY[size] === undefined ? null : { vcpu: SIZE_VCPU[size], memoryGb: T_MEMORY[size] };
  const vcpu = size === 'medium' ? 1 : SIZE_VCPU[size];
  return { vcpu, memoryGb: vcpu * (GB_PER_VCPU[family.charAt(0)] ?? 4) };
}

const watts = (vcpu: number, memoryGb: number) => (vcpu * (MIN_W + UTILISATION * (MAX_W - MIN_W)) + memoryGb * MEMORY_W) * PUE;

// The watts an item draws while running; null when its shape is unknown (or nothing is saved).
export function itemWatts(item: StoppedItem): number | null {
  switch (item.kind) {
    case 'ec2': { const s = shape(item.type); return s ? watts(s.vcpu, s.memoryGb) * item.count : null; }
    case 'rds': { const s = shape(item.class); return s ? watts(s.vcpu, s.memoryGb) * (item.multiAz ? 2 : 1) : null; }
    case 'fargate': return watts(item.vcpu, item.memoryGb) * item.count;
    case 'aurora-serverless': return watts(item.acu * 0.25, item.acu * 2); // an ACU: about 2 GB with its share of CPU
    case 'k8s-pods': return item.autoscaled ? watts(item.cpu, item.memoryGb) * item.count : null;
    default: return null;
  }
}

// estimated: how many items had a known shape (none: no estimate).
export interface Energy { kwh: number; co2Kg: number; estimated: number }

// What items stopped for so many hours saved, in a region.
export function savedEnergy(items: StoppedItem[], hours: number, region: string): Energy {
  let w = 0, estimated = 0;
  for (const item of items) {
    const p = itemWatts(item);
    if (p !== null) { w += p; estimated += 1; }
  }
  const kwh = (w * hours) / 1000;
  return { kwh, co2Kg: kwh * gridIntensity(region), estimated };
}

export const addEnergy = (a: Energy, b: Energy): Energy => ({ kwh: a.kwh + b.kwh, co2Kg: a.co2Kg + b.co2Kg, estimated: a.estimated + b.estimated });
