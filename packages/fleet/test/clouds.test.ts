// One model for both clouds (Google Cloud design §3): the account is an AWS account or a Google Cloud project, and the
// regions are checked per cloud.
import { describe, expect, it } from 'vitest';
import { cloudOf, fiveFieldMinutes, GOOGLE_REPORT_MINIMUM, googlePath, googleScopeOf, googleServicePath, installCommand, isAccount, isCandidateRegion, isProject, isRegion, reportsTooOld, routerTooOld, tooOldText } from '../src/clouds.js';

describe('clouds', () => {
  it('tells the cloud of an account: twelve digits are AWS, a project ID is Google Cloud, anything else is neither', () => {
    expect([cloudOf('123456789012'), cloudOf('dormeto-dev'), cloudOf('12345'), cloudOf('')]).toEqual(['aws', 'gcp', null, null]);
    expect([isAccount('123456789012'), isAccount('dormeto-dev')]).toEqual([true, false]);
    expect([isProject('dormeto-dev'), isProject('123456789012'), isProject('Dormeto'), isProject('a-b')]).toEqual([true, false, false, false]);
  });

  it('checks a region against its cloud: europe-west1 is Google Cloud\'s, eu-west-3 is AWS\'s', () => {
    expect([isRegion('gcp', 'europe-west1'), isRegion('aws', 'europe-west1'), isRegion('aws', 'eu-west-3'), isRegion('gcp', 'eu-west-3')]).toEqual([true, false, true, false]);
    expect([isRegion('gcp', 'northamerica-northeast1'), isRegion('aws', 'us-gov-west-1'), isRegion('aws', 'ap-southeast-12')]).toEqual([true, true, true]);
  });

  it('accepts global as a candidate\'s region on Google Cloud only', () => {
    expect([isCandidateRegion('gcp', 'global'), isCandidateRegion('gcp', 'europe-west1'), isCandidateRegion('aws', 'global'), isRegion('gcp', 'global')]).toEqual([true, true, false, false]);
  });

  it('reads the minutes of a five-field schedule every N minutes, and nothing else', () => {
    expect([fiveFieldMinutes('*/5 * * * *'), fiveFieldMinutes('*/10 * * * *'), fiveFieldMinutes('0 * * * *'), fiveFieldMinutes('rate(5 minutes)'), fiveFieldMinutes('*/0 * * * *')]).toEqual([5, 10, null, null, null]);
  });

  it('reads a Google Cloud path: a backend service or a URL map, global or regional, and nothing else', () => {
    expect(googlePath('projects/dormeto-dev/global/backendServices/web')).toEqual({ project: 'dormeto-dev', region: 'global', kind: 'backendServices', name: 'web' });
    expect(googlePath('projects/dormeto-dev/regions/europe-west2/urlMaps/lb-1')).toEqual({ project: 'dormeto-dev', region: 'europe-west2', kind: 'urlMaps', name: 'lb-1' });
    for (const bad of ['projects/123456789012/global/urlMaps/x', 'projects/dormeto-dev/regions/global/urlMaps/x', 'projects/dormeto-dev/global/forwardingRules/x',
      'projects/dormeto-dev/global/urlMaps/X', 'projects/dormeto-dev/global/urlMaps/-x', 'projects/dormeto-dev/global/urlMaps/x-', `projects/dormeto-dev/global/urlMaps/a${'b'.repeat(63)}`,
      'projects/dormeto-dev/global/urlMaps/x/y', 'arn:aws:x', '']) expect(googlePath(bad)).toBeNull();
    expect(googlePath(5)).toBeNull();
  });

  // One rule for the API, the operations and the dashboard (the router's own is gcp/src/switch.mjs isRegionalLb).
  it('scopes a Google Cloud name by its load balancer: a regional or internal one\'s region (else the row\'s), the others global', () => {
    expect([googleScopeOf({ kind: 'regional', region: 'europe-west1' }, 'europe-west2'), googleScopeOf({ kind: 'internal' }, 'europe-west2')]).toEqual(['regions/europe-west1', 'regions/europe-west2']);
    expect([googleScopeOf(undefined, 'europe-west2'), ...['global', 'classic', 'cross-region-internal'].map((kind) => googleScopeOf({ kind, region: 'europe-west2' }, 'europe-west2'))]).toEqual(['global', 'global', 'global', 'global']);
    expect(googleServicePath('dormeto-dev', 'urlMaps', 'lb', { kind: 'regional' }, 'europe-west2')).toBe('projects/dormeto-dev/regions/europe-west2/urlMaps/lb');
    expect(googleServicePath('dormeto-dev', 'backendServices', 'shop', undefined, 'europe-west2')).toBe('projects/dormeto-dev/global/backendServices/shop');
    // A path is kept as it is.
    expect(googleServicePath('dormeto-dev', 'urlMaps', 'projects/dormeto-dev/global/urlMaps/lb', { kind: 'regional' }, 'europe-west2')).toBe('projects/dormeto-dev/global/urlMaps/lb');
  });
});

// A Google Cloud router too old for the manager, and the command that installs one: the API, the operations, the fleet's probe,
// the watchdog and the dashboard say them alike.
describe('routerTooOld', () => {
  it('is a known version below 0.40.0; an unknown version is called', () => {
    expect(['0.39.0', '0.9.12', '0.39.9-rc.1'].map(routerTooOld)).toEqual([true, true, true]);
    expect(['0.40.0', '0.40.0-rc.1', '1.0.0', '', 'dev'].map(routerTooOld)).toEqual([false, false, false, false, false]);
  });

  it('compares major.minor.patch only: a dev router of 0.40.0 meets the minimum, one of 0.39.0 doesn\'t', () => {
    expect(['0.40.0-dev.1', '0.41.0-dev.2', '0.39.0-dev.3', '0.39.12-dev.1'].map(routerTooOld)).toEqual([false, false, true, true]);
  });
});

// A Google Cloud router too old to report (router push design 2026-11-14 §6.4): the manager still calls a router of 0.40.0, but
// only 0.41.0 sends its events to the manager's API.
describe('reportsTooOld', () => {
  it('is a known version below 0.41.0, by major.minor.patch; an unknown version is called', () => {
    expect(GOOGLE_REPORT_MINIMUM).toBe('0.41.0');
    expect(['0.40.0', '0.40.9-rc.1', '0.40.0-dev.3', '0.39.0'].map(reportsTooOld)).toEqual([true, true, true, true]);
    expect(['0.41.0', '0.41.0-dev.1', '1.0.0', '', 'dev'].map(reportsTooOld)).toEqual([false, false, false, false, false]);
  });

  it('names the install command with the pinned version but never below 0.41.0', () => {
    expect(installCommand('dormeto-dev', 'europe-west2', '0.40.0', GOOGLE_REPORT_MINIMUM)).toBe('dormeto gcp routers install --project dormeto-dev --region europe-west2 --version 0.41.0');
    expect(tooOldText('0.40.0', 'dormeto-dev', 'europe-west2', '0.41.2', GOOGLE_REPORT_MINIMUM)).toBe('router 0.40.0 can\'t report to the manager: dormeto gcp routers install --project dormeto-dev --region europe-west2 --version 0.41.2');
    expect(tooOldText('', 'dormeto-dev', 'europe-west2', undefined, GOOGLE_REPORT_MINIMUM)).toBe('router older than 0.41.0 can\'t report to the manager: dormeto gcp routers install --project dormeto-dev --region europe-west2');
  });
});

describe('the refusals\' texts', () => {
  it('names the install command with the pinned version but never below the router minimum', () => {
    expect(installCommand('dormeto-dev', 'europe-west2', '0.37.0')).toBe('dormeto gcp routers install --project dormeto-dev --region europe-west2 --version 0.40.0');
    expect(installCommand('dormeto-dev', 'europe-west2', '0.41.0')).toBe('dormeto gcp routers install --project dormeto-dev --region europe-west2 --version 0.41.0');
    expect(installCommand('dormeto-dev', 'europe-west2', undefined)).toBe('dormeto gcp routers install --project dormeto-dev --region europe-west2');
    expect(tooOldText('0.39.0', 'dormeto-dev', 'europe-west2', '0.37.0')).toContain('--version 0.40.0');
  });

  it('name the command that fixes a router too old, as the API answers it and the probe records it', () => {
    expect(tooOldText('0.39.0', 'dormeto-dev', 'europe-west2', '0.40.0')).toBe('router 0.39.0 can\'t report to the manager: dormeto gcp routers install --project dormeto-dev --region europe-west2 --version 0.40.0');
    expect(tooOldText('', 'dormeto-dev', 'europe-west2', undefined)).toBe('router older than 0.40.0 can\'t report to the manager: dormeto gcp routers install --project dormeto-dev --region europe-west2');
  });
});
