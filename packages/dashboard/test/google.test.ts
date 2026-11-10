import { describe, expect, it } from 'vitest';
import { GOOGLE_ROUTER_MINIMUM } from '@dormeto/fleet/clouds';
import { backendConsoleUrl, googleRouterTooOld, controllerConsoleUrl, googleResourcePath, installCommand, resourceName, uninstallCommand, urlMapConsoleUrl } from '../src/google';

describe('Google Cloud console links and commands', () => {
  it('links a VM, a managed group and a Cloud SQL instance from their resource paths, with the project', () => {
    expect(backendConsoleUrl({ kind: 'instance', id: 'projects/dormeto-dev/zones/europe-west2-a/instances/vm-demo' }, 'dormeto-dev'))
      .toBe('https://console.cloud.google.com/compute/instancesDetail/zones/europe-west2-a/instances/vm-demo?project=dormeto-dev');
    expect(backendConsoleUrl({ kind: 'asg', id: 'projects/dormeto-dev/zones/europe-west2-b/instanceGroupManagers/mig-demo' }, 'dormeto-dev'))
      .toBe('https://console.cloud.google.com/compute/instanceGroups/details/europe-west2-b/mig-demo?project=dormeto-dev');
    expect(backendConsoleUrl({ kind: 'asg', id: 'projects/dormeto-dev/regions/europe-west2/instanceGroupManagers/mig-demo' }, 'dormeto-dev'))
      .toBe('https://console.cloud.google.com/compute/instanceGroups/details/europe-west2/mig-demo?project=dormeto-dev');
    expect(backendConsoleUrl({ kind: 'cloudsql-instance', id: 'projects/dormeto-dev/instances/db-demo' }, 'dormeto-dev'))
      .toBe('https://console.cloud.google.com/sql/instances/db-demo/overview?project=dormeto-dev');
  });

  it('has no link for a backend whose id is not a resource path, or a Kubernetes workload', () => {
    expect(backendConsoleUrl({ kind: 'instance', id: 'vm-demo' }, 'dormeto-dev')).toBeNull();
    expect(backendConsoleUrl({ kind: 'k8s', id: 'gke/ns/Deployment/web' }, 'dormeto-dev')).toBeNull();
  });

  it('encodes each part of a link', () => {
    expect(backendConsoleUrl({ kind: 'instance', id: 'projects/a b/zones/z/instances/n&x' }, 'a b'))
      .toBe('https://console.cloud.google.com/compute/instancesDetail/zones/z/instances/n%26x?project=a%20b');
  });

  it('links a global or classic URL map, and the load balancers list for a regional one', () => {
    expect(urlMapConsoleUrl('projects/dormeto-dev/global/urlMaps/lb', { kind: 'global' }, 'dormeto-dev'))
      .toBe('https://console.cloud.google.com/net-services/loadbalancing/details/http/lb?project=dormeto-dev');
    expect(urlMapConsoleUrl('projects/dormeto-dev/regions/europe-west2/urlMaps/lb', { kind: 'regional', region: 'europe-west2' }, 'dormeto-dev'))
      .toBe('https://console.cloud.google.com/net-services/loadbalancing/list/loadBalancers?project=dormeto-dev');
  });

  it('links the controller of a router and names the commands, with the pinned version when behind', () => {
    expect(controllerConsoleUrl('dormeto-dev', 'europe-west2')).toBe('https://console.cloud.google.com/run/detail/europe-west2/dmtr-europe-west2-controller/metrics?project=dormeto-dev');
    expect(installCommand('dormeto-dev', 'europe-west2')).toBe('dormeto gcp install --project dormeto-dev --region europe-west2');
    expect(installCommand('dormeto-dev', 'europe-west2', '0.40.0')).toBe('dormeto gcp install --project dormeto-dev --region europe-west2 --version 0.40.0');
    expect(installCommand('dormeto-dev', 'europe-west2', '0.37.0')).toBe('dormeto gcp install --project dormeto-dev --region europe-west2 --version 0.40.0');
    expect(installCommand('dormeto-dev', 'europe-west2', '0.41.0')).toBe('dormeto gcp install --project dormeto-dev --region europe-west2 --version 0.41.0');
    expect(uninstallCommand('dormeto-dev', 'europe-west2')).toBe('dormeto gcp uninstall --project dormeto-dev --region europe-west2');
    expect(resourceName('projects/p/regions/r/backendServices/web-waker')).toBe('web-waker');
  });
});

describe('a Google Cloud resource\'s path from a workload\'s row', () => {
  it('builds it in the global scope for a missing or a global, classic or cross-region internal load balancer', () => {
    expect(googleResourcePath('dormeto-dev', 'backendServices', 'shop', undefined, 'global')).toBe('projects/dormeto-dev/global/backendServices/shop');
    for (const kind of ['global', 'classic', 'cross-region-internal']) expect(googleResourcePath('dormeto-dev', 'urlMaps', 'lb', { kind }, 'europe-west2')).toBe('projects/dormeto-dev/global/urlMaps/lb');
  });

  it('builds it in the load balancer\'s region, else the row\'s, for a regional or an internal one', () => {
    expect(googleResourcePath('dormeto-dev', 'urlMaps', 'lb', { kind: 'regional', region: 'europe-west1' }, 'europe-west2')).toBe('projects/dormeto-dev/regions/europe-west1/urlMaps/lb');
    expect(googleResourcePath('dormeto-dev', 'backendServices', 'shop', { kind: 'internal' }, 'europe-west2')).toBe('projects/dormeto-dev/regions/europe-west2/backendServices/shop');
  });

  it('keeps a path it is given', () => {
    expect(googleResourcePath('dormeto-dev', 'urlMaps', 'projects/dormeto-dev/global/urlMaps/lb', { kind: 'global' }, 'global')).toBe('projects/dormeto-dev/global/urlMaps/lb');
  });
});

describe('a Google Cloud router too old', () => {
  it('is one below the floor the manager keeps, by major.minor.patch, or one the API refused as router_too_old', () => {
    const [major, minor, patch] = GOOGLE_ROUTER_MINIMUM.split('.').map(Number) as [number, number, number];
    expect(googleRouterTooOld({ version: `${major}.${minor - 1}.${patch + 9}` })).toBe(true);
    expect(googleRouterTooOld({ version: GOOGLE_ROUTER_MINIMUM })).toBe(false);
    expect(googleRouterTooOld({ version: `${GOOGLE_ROUTER_MINIMUM}-dev.1` })).toBe(false);
    expect(googleRouterTooOld({ version: `${major}.${minor}.${patch + 1}` })).toBe(false);
    expect(googleRouterTooOld({ version: null })).toBe(false);
    expect(googleRouterTooOld({ version: null, refusal: 'router_too_old' })).toBe(true);
    expect(googleRouterTooOld({ version: `${major}.${minor}.${patch + 1}`, refusal: 'router_unknown' })).toBe(false);
  });
});
