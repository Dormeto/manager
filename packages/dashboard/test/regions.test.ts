import { describe, expect, it } from 'vitest';
import { partitionOf, regionInfo } from '../src/regions';

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
});
