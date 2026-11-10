// The energy a nap saves, and its carbon, as an estimate (the overview's energy card, a workload's costs area): what the
// nap stopped (its items) times the hours asleep, with Cloud Carbon Footprint's coefficients for AWS (compute at 50%
// utilisation, memory, the data centres' PUE) and the region's grid intensity. Not a measure: the instances' real load and
// AWS's own figures differ. The API computes it (@dormeto/fleet/energy), the dashboard's demo mode too: this module and the
// one it reads its type from (prices.ts, with google-prices.ts) import nothing else, so none pulls the fleet's store nor
// the AWS SDK.
import type { StoppedItem } from './prices.js';

// Cloud Carbon Footprint, AWS: watts per vCPU at 0% and 100%, watts per GB of memory, power usage effectiveness.
const MIN_W = 0.74, MAX_W = 3.5, UTILISATION = 0.5, MEMORY_W = 0.392, PUE = 1.135;
// kg CO2e per kWh by region (Cloud Carbon Footprint's grid factors); others: the average of these.
const GRID: Record<string, number> = {
  'us-east-1': 0.379, 'us-east-2': 0.411, 'us-west-1': 0.322, 'us-west-2': 0.322, 'ca-central-1': 0.13, 'sa-east-1': 0.062,
  'eu-west-1': 0.279, 'eu-west-2': 0.225, 'eu-west-3': 0.051, 'eu-central-1': 0.311, 'eu-north-1': 0.009, 'eu-south-1': 0.233,
  'ap-south-1': 0.708, 'ap-southeast-1': 0.408, 'ap-southeast-2': 0.79, 'ap-northeast-1': 0.465, 'ap-northeast-2': 0.5,
};
const AVERAGE_GRID = Object.values(GRID).reduce((a, b) => a + b, 0) / Object.keys(GRID).length;
// Google Cloud's grid factors as Cloud Carbon Footprint lists them; another Google Cloud region: CCF's average.
const GOOGLE_GRID: Record<string, number> = {
  'us-central1': 0.413, 'us-central2': 0.372, 'us-east1': 0.576, 'us-east2': 0.34, 'us-east4': 0.323, 'us-east5': 0.323,
  'us-west1': 0.079, 'us-west2': 0.169, 'us-west3': 0.555, 'us-west4': 0.357, 'us-south1': 0.303, 'asia-east1': 0.439,
  'asia-east2': 0.505, 'asia-northeast1': 0.453, 'asia-northeast2': 0.296, 'asia-northeast3': 0.357, 'asia-south1': 0.679,
  'asia-south2': 0.532, 'asia-southeast1': 0.367, 'asia-southeast2': 0.561, 'australia-southeast1': 0.498,
  'australia-southeast2': 0.454, 'europe-central2': 0.643, 'europe-north1': 0.039, 'europe-north2': 0.003,
  'europe-southwest1': 0.089, 'europe-west1': 0.103, 'europe-west2': 0.106, 'europe-west3': 0.276, 'europe-west4': 0.209,
  'europe-west6': 0.015, 'europe-west8': 0.202, 'europe-west9': 0.016, 'europe-west10': 0.276, 'europe-west12': 0.202,
  'northamerica-northeast1': 0.005, 'northamerica-northeast2': 0.059, 'northamerica-south1': 0.305, 'southamerica-east1': 0.067,
  'southamerica-west1': 0.238, 'africa-south1': 0.657, 'me-central1': 0.366, 'me-central2': 0.382, 'me-west1': 0.434,
};
const GOOGLE_AVERAGE_GRID = 0.3101;
const GOOGLE_REGION = /^[a-z]+-[a-z]+\d{1,2}$/;
export const gridIntensity = (region: string): number =>
  GOOGLE_REGION.test(region) ? GOOGLE_GRID[region] ?? GOOGLE_AVERAGE_GRID : GRID[region] ?? AVERAGE_GRID;

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

// Cloud Carbon Footprint, Google Cloud: watts per vCPU at 0% and 100% by machine family (any other family, and Cloud SQL: the
// medians), memory 0.392 W a GB, PUE 1.1.
const GOOGLE_PUE = 1.1, MEDIAN_W: [number, number] = [0.68, 4.11];
const GOOGLE_FAMILY_W: Record<string, [number, number]> = {
  n2: [0.69, 3.75], c2: [0.69, 3.75], g2: [0.69, 3.75], t2d: [0.46, 1.83], c2d: [0.46, 1.83], c3: [1.04, 4.06], h3: [1.04, 4.06],
  c4: [0.81, 4.38], n4: [0.81, 4.38], a3: [0.81, 4.38], m3: [0.77, 3.65],
};
const googleWatts = (vcpus: number, memoryGb: number, [min, max]: [number, number]) =>
  (vcpus * (min + UTILISATION * (max - min)) + memoryGb * MEMORY_W) * GOOGLE_PUE;

// The watts an item draws while running; null when its shape is unknown (or nothing is saved).
export function itemWatts(item: StoppedItem): number | null {
  switch (item.kind) {
    case 'ec2': { const s = shape(item.type); return s ? watts(s.vcpu, s.memoryGb) * item.count : null; }
    case 'rds': { const s = shape(item.class); return s ? watts(s.vcpu, s.memoryGb) * (item.multiAz ? 2 : 1) : null; }
    case 'gce': return googleWatts(item.vcpus, item.memoryGb, GOOGLE_FAMILY_W[item.family] ?? MEDIAN_W) * item.count;
    case 'cloudsql':
      return item.vcpus === undefined || item.memoryGb === undefined ? null : googleWatts(item.vcpus, item.memoryGb, MEDIAN_W) * (item.ha ? 2 : 1);
    case 'fargate': return watts(item.vcpu, item.memoryGb) * item.count;
    case 'aurora-serverless': return watts(item.acu * 0.25, item.acu * 2); // an ACU: about 2 GB with its share of CPU
    case 'k8s-pods': return item.autoscaled ? watts(item.cpu, item.memoryGb) * item.count : null;
    default: return null;
  }
}

// estimated: how many items had a known shape (none: no estimate).
export interface Energy { kwh: number; co2Kg: number; estimated: number }

// The region an item's grid is read in: a Google Cloud item's own (a VM's zone's), else the region given.
const gridRegion = (item: StoppedItem, region: string): string =>
  item.kind === 'gce' ? item.zone.replace(/-[a-z]$/, '') : item.kind === 'cloudsql' ? item.region : region;

// What items stopped for so many hours saved, in a region (a Google Cloud item's own region wins).
export function savedEnergy(items: StoppedItem[], hours: number, region: string): Energy {
  let kwh = 0, co2Kg = 0, estimated = 0;
  for (const item of items) {
    const p = itemWatts(item);
    if (p === null) continue;
    const itemKwh = (p * hours) / 1000;
    kwh += itemKwh;
    co2Kg += itemKwh * gridIntensity(gridRegion(item, region));
    estimated += 1;
  }
  return { kwh, co2Kg, estimated };
}

export const addEnergy = (a: Energy, b: Energy): Energy => ({ kwh: a.kwh + b.kwh, co2Kg: a.co2Kg + b.co2Kg, estimated: a.estimated + b.estimated });
