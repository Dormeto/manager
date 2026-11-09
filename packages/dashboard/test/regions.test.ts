import { describe, expect, it } from 'vitest';
import { partitionOf, regionCloud, regionInfo, regionKind } from '../src/regions';

describe('regions', () => {
  it('gives the flag, the AWS location and the country of a region', () => {
    const ireland = regionInfo('eu-west-1');
    expect([ireland.code, ireland.location, ireland.country]).toEqual(['eu-west-1', 'Europe (Ireland)', 'Ireland']);
    expect(ireland.flag).toMatch(/\.svg|^data:image\/svg/);
    expect(regionInfo('eu-west-3').flag).not.toEqual(ireland.flag);
    expect([regionInfo('us-east-1').location, regionInfo('us-east-1').country]).toEqual(['US East (N. Virginia)', 'United States']);
    expect(regionInfo('us-west-2').flag).toEqual(regionInfo('us-east-1').flag);
  });

  it('knows a flag for every region it knows, and nothing for an unknown one', () => {
    for (const code of ['af-south-1', 'ap-east-1', 'ap-northeast-3', 'ap-south-2', 'ap-southeast-7', 'ca-west-1', 'cn-northwest-1', 'eu-central-2', 'eu-north-1', 'eu-south-2', 'il-central-1', 'me-central-1', 'mx-central-1', 'sa-east-1', 'us-gov-west-1']) {
      const r = regionInfo(code);
      expect(r.flag, code).toMatch(/\.svg|^data:image\/svg/);
      expect(r.location && r.country, code).toBeTruthy();
    }
    expect(regionInfo('xx-moon-1')).toEqual({ code: 'xx-moon-1', location: null, country: null, flag: null });
  });

  it('gives the partition of a region', () => {
    expect(['eu-west-1', 'cn-north-1', 'us-gov-west-1'].map(partitionOf)).toEqual(['aws', 'aws-cn', 'aws-us-gov']);
  });

  it('gives the location Google names for a Google Cloud region, with its country\'s flag', () => {
    const london = regionInfo('europe-west2');
    expect([london.code, london.location, london.country]).toEqual(['europe-west2', 'London', 'United Kingdom']);
    expect(london.flag).toMatch(/\.svg|^data:image\/svg/);
    expect(['europe-west1', 'europe-west3', 'europe-west4', 'us-central1'].map((c) => regionInfo(c).location)).toEqual(['Belgium', 'Frankfurt', 'Netherlands', 'Iowa']);
    expect(regionInfo('europe-west1').country).toBe('Belgium');
    expect(regionInfo('us-central1').flag).toEqual(regionInfo('us-east4').flag);
  });

  it('knows every region Google Cloud lists today (43), each with a location and a flag, and none of them an AWS region', () => {
    const all = ['africa-south1', 'asia-east1', 'asia-east2', 'asia-northeast1', 'asia-northeast2', 'asia-northeast3', 'asia-south1', 'asia-south2', 'asia-southeast1', 'asia-southeast2', 'asia-southeast3',
      'australia-southeast1', 'australia-southeast2', 'europe-central2', 'europe-north1', 'europe-north2', 'europe-southwest1', 'europe-west1', 'europe-west2', 'europe-west3', 'europe-west4',
      'europe-west6', 'europe-west8', 'europe-west9', 'europe-west10', 'europe-west12', 'me-central1', 'me-central2', 'me-west1', 'northamerica-northeast1', 'northamerica-northeast2',
      'northamerica-south1', 'southamerica-east1', 'southamerica-west1', 'us-central1', 'us-east1', 'us-east4', 'us-east5', 'us-south1', 'us-west1', 'us-west2', 'us-west3', 'us-west4'];
    expect(all).toHaveLength(43);
    for (const code of all) {
      const r = regionInfo(code);
      expect(r.location && r.country && r.flag, code).toBeTruthy();
      expect(regionCloud(code), code).toBe('gcp');
    }
  });

  it('tells the cloud of a region from its code, and what its location is called', () => {
    expect(['eu-west-1', 'cn-north-1', 'europe-west2', 'us-central1', 'xx-moon-1', 'moon'].map(regionCloud)).toEqual(['aws', 'aws', 'gcp', 'gcp', 'aws', null]);
    expect(regionKind('europe-west2')).toBe('Google Cloud location');
    expect(regionKind('eu-west-1')).toBe('AWS location');
    expect(regionKind('moon')).toBeNull();
  });
});
