// A router's access to the EKS clusters of its account and region (vision docs/specs/2026-10-11-kubernetes-design.md,
// section 4): its roles in the group dormeto:router, DmtDiscoveryRole with the view policy, by API calls only.
import { describe, expect, it } from 'vitest';
import { ensureClusterAccess } from '../src/cluster-access.js';
import { cluster, fakeEks } from './eks-fake.js';

const ACCOUNT = '121014831971';
const ROLES = ['controller', 'waker', 'onboarder'].map((r) => `arn:aws:iam::${ACCOUNT}:role/dormeto/router/dmtr-dev-eu-west-1-${r}`);
const DISCOVERY = `arn:aws:iam::${ACCOUNT}:role/DmtDiscoveryRole`;
const VIEW = 'arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy';

describe('the router\'s access to the EKS clusters', () => {
  it('creates an entry per router role in the group dormeto:router and DmtDiscoveryRole\'s with the view policy; a second run changes nothing', async () => {
    const eks = fakeEks([cluster('eks-demo')]);
    expect(await ensureClusterAccess(eks, { routerRoles: ROLES, discoveryRole: DISCOVERY })).toEqual([
      { cluster: 'eks-demo', status: 'done', ready: true, detail: 'cluster eks-demo: access entries created for 3 router roles (group dormeto:router) and DmtDiscoveryRole (AmazonEKSViewPolicy)' },
    ]);
    expect(eks.writes).toEqual([
      ...ROLES.map((principalArn) => ['createAccessEntry', { clusterName: 'eks-demo', principalArn, kubernetesGroups: ['dormeto:router'], type: 'STANDARD' }]),
      ['createAccessEntry', { clusterName: 'eks-demo', principalArn: DISCOVERY, type: 'STANDARD' }],
      ['associateAccessPolicy', { clusterName: 'eks-demo', principalArn: DISCOVERY, policyArn: VIEW, accessScope: { type: 'cluster' } }],
    ]);
    eks.writes.length = 0;
    expect(await ensureClusterAccess(eks, { routerRoles: ROLES, discoveryRole: DISCOVERY })).toEqual([{ cluster: 'eks-demo', status: 'skipped', ready: true, detail: 'cluster eks-demo: access entries in place' }]);
    expect(eks.writes).toEqual([]);
  });

  it('leaves a cluster on aws-auth only, or one it cannot reach, with what to do', async () => {
    const eks = fakeEks([cluster('legacy', { mode: 'CONFIG_MAP' }), cluster('private', { public: false }), cluster('office', { cidrs: ['198.51.100.0/24'] })]);
    expect(await ensureClusterAccess(eks, { routerRoles: ROLES, discoveryRole: DISCOVERY })).toEqual([
      { cluster: 'legacy', status: 'skipped', ready: true, detail: 'cluster legacy: authentication mode CONFIG_MAP (aws-auth only): switch it to API_AND_CONFIG_MAP, or map the router\'s roles to the group dormeto:router in aws-auth' },
      { cluster: 'private', status: 'skipped', ready: false, detail: 'cluster private: its endpoint is private (or limited to some addresses): Dormeto reaches it with the in-cluster agent (R10.6)' },
      { cluster: 'office', status: 'skipped', ready: false, detail: 'cluster office: its endpoint is private (or limited to some addresses): Dormeto reaches it with the in-cluster agent (R10.6)' },
    ]);
    expect(eks.writes).toEqual([]);
  });

  it('an entry the customer made without the group is left as it is, and said', async () => {
    const eks = fakeEks([cluster('eks-demo')]);
    eks.entries.set(`eks-demo ${ROLES[0]}`, { kubernetesGroups: ['ops'] });
    const [result] = await ensureClusterAccess(eks, { routerRoles: ROLES, discoveryRole: DISCOVERY });
    expect(result!.detail).toContain(`${ROLES[0]} has an access entry without the group dormeto:router (left as it is)`);
    expect(eks.writes.some(([, i]) => i.principalArn === ROLES[0])).toBe(false);
  });

  it('a command role that may not manage access entries fails the step, naming the organization module to apply again', async () => {
    const denied = Object.assign(new Error('User is not authorized to perform: eks:CreateAccessEntry'), { name: 'AccessDeniedException' });
    await expect(ensureClusterAccess(fakeEks([cluster('eks-demo')], { deny: denied }), { routerRoles: ROLES, discoveryRole: DISCOVERY }))
      .rejects.toThrow('the command role may not manage the access entries of cluster eks-demo: apply the organization module again (statement EksAccessEntries): User is not authorized to perform: eks:CreateAccessEntry');
  });
});
