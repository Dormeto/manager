import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, validateConfig } from '../src/config.js';

const valid = {
  version: 1,
  mode: 'organization',
  regions: ['eu-west-1', 'eu-west-3'],
  refreshHours: 24,
  globalExcludes: [{ note: 'production', ouIds: ['ou-1u0b-pppppppp'] }],
  filters: [{ name: 'test accounts', include: [{ accountIds: ['121014831971', '038606077307'] }] }],
};

describe('validateConfig', () => {
  it('accepts a valid configuration and normalizes a missing exclude list', () => {
    const { config, errors } = validateConfig(valid);
    expect(errors).toEqual([]);
    expect(config!.filters[0]!.exclude).toEqual([]);
    expect(config!.globalExcludes[0]!.ouIds).toEqual(['ou-1u0b-pppppppp']);
  });

  it('accepts every dimension with well-formed values, the root ID and regions ["*"]', () => {
    const { errors } = validateConfig({
      ...valid,
      regions: ['*'],
      filters: [{
        name: 'all dimensions',
        include: [{
          accountIds: ['121014831971'], ouIds: ['r-1u0b'], accountTags: { env: [] }, regions: ['ap-southeast-7'],
          loadBalancers: ['web-*', 'arn:aws:elasticloadbalancing:eu-west-1:121014831971:loadbalancer/app/web/1'],
          hosts: ['*.example.com'], resourceTags: { env: ['preview'] }, backendKinds: ['instance', 'asg', 'ecs'],
        }],
        exclude: [{}],
      }],
    });
    expect(errors).toEqual([]);
  });

  it('refuses another version, and lists every error at once', () => {
    const { config, errors } = validateConfig({
      version: 2,
      mode: 'everything',
      regions: ['eu-west1'],
      refreshHours: 0,
      globalExcludes: [{ accountIds: ['1234'], foo: ['x'] }],
      filters: [
        { name: 'a', include: [{ ouIds: ['ou-bad'], backendKinds: ['lambda'], hosts: ['x'.repeat(257)] }] },
        { name: 'a', include: [] },
        { name: '', include: [{ regions: [] }], exclude: [{ resourceTags: { '': ['x'] } }] },
      ],
    });
    expect(config).toBeNull();
    expect(errors).toEqual([
      'version: must be 1',
      'mode: must be "organization" or "account"',
      'regions: "eu-west1" is not a region name',
      'refreshHours: must be an integer from 1 to 168',
      'globalExcludes[0].accountIds: "1234" is not a 12-digit account ID',
      'globalExcludes[0]: unknown dimension "foo"',
      'filters[0].include[0].ouIds: "ou-bad" is not an OU or root ID',
      'filters[0].include[0].hosts: patterns are at most 256 characters',
      'filters[0].include[0].backendKinds: "lambda" is not one of instance, asg, ecs, k8s',
      'filters[1]: duplicate filter name "a"',
      'filters[1].include: at least one include criterion',
      'filters[2].name: required, at most 64 characters',
      'filters[2].include[0].regions: at least one value',
      'filters[2].exclude[0].resourceTags: tag keys are 1 to 128 characters',
    ]);
  });

  it('refuses more than 50 filters or 100 criteria in total', () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ name: `f${i}`, include: [{}] }));
    expect(validateConfig({ ...valid, filters: many }).errors).toContain('filters: at most 50 filters');
    const crowded = [{ name: 'big', include: Array.from({ length: 101 }, () => ({})) }];
    expect(validateConfig({ ...valid, filters: crowded }).errors).toContain('at most 100 criteria in total');
  });

  it('accepts event-driven refresh, on or off, for every ready account or some; refuses a malformed one', () => {
    // Packaging design §5: off by default; accounts lets an administrator connect some accounts first.
    expect(validateConfig(valid).config?.eventRefresh).toBeUndefined();
    expect(validateConfig({ ...valid, eventRefresh: { enabled: true } }).config?.eventRefresh).toEqual({ enabled: true });
    expect(validateConfig({ ...valid, eventRefresh: { enabled: false, accounts: ['121014831971'] } }).config?.eventRefresh).toEqual({ enabled: false, accounts: ['121014831971'] });
    expect(validateConfig({ ...valid, eventRefresh: { enabled: 'yes' } }).errors).toEqual(['eventRefresh.enabled: must be true or false']);
    expect(validateConfig({ ...valid, eventRefresh: { enabled: true, accounts: ['12'] } }).errors).toEqual(['eventRefresh.accounts: "12" is not an account id']);
    expect(validateConfig({ ...valid, eventRefresh: true }).errors).toEqual(['eventRefresh: must be an object']);
  });

  it('refuses something that is not an object', () => {
    expect(validateConfig('nope').errors).toEqual(['configuration: must be an object']);
  });

  it('has a default without any filter, so a new installation scans nothing', () => {
    expect(DEFAULT_CONFIG.filters).toEqual([]);
    expect(validateConfig(DEFAULT_CONFIG).errors).toEqual([]);
  });
});
