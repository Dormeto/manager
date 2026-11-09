import { describe, expect, it } from 'vitest';
import { mockApi } from '../src/mock';
import type { GoogleConnectionAnswer, RouterInfo, WorkloadSummary } from '../src/types';

const ROUTER = 'dmtr-dormeto-dev-europe-west2';

describe('the demo\'s Google Cloud router', () => {
  it('lists a Google Cloud router of the project dormeto-dev next to the AWS ones, installed by the CLI', async () => {
    const { routers } = await mockApi('/routers') as { routers: RouterInfo[] };
    expect(routers.find((r) => r.name === ROUTER)).toMatchObject({ cloud: 'gcp', account: 'dormeto-dev', region: 'europe-west2', version: '0.40.0', source: 'cli', workloads: 2 });
    expect(routers.filter((r) => r.name !== ROUTER).every((r) => r.cloud === 'aws')).toBe(true);
  });

  it('lists its two workloads, a VM and a managed group, with their cloud and a project', async () => {
    const { workloads } = await mockApi(`/workloads?router=${ROUTER}`) as { workloads: (WorkloadSummary & { region: string })[] };
    const byName = Object.fromEntries(workloads.map((w) => [w.workloadId, w]));
    expect(Object.keys(byName).sort()).toEqual(['mig-demo', 'vm-demo']);
    expect(byName['vm-demo']).toMatchObject({ name: 'Demo VM', cloud: 'gcp', account: 'dormeto-dev', region: 'europe-west2', tags: { team: 'payments' }, backends: ['instance'] });
    expect(byName['mig-demo']).toMatchObject({ cloud: 'gcp', backends: ['asg'] });
    expect(byName['mig-demo']!.name).toBeUndefined();
    expect(JSON.stringify(workloads)).not.toContain('targetGroupArn');
  });

  it('marks every AWS workload aws, and reads the workload by its Google Cloud router', async () => {
    const { workloads } = await mockApi('/workloads') as { workloads: WorkloadSummary[] };
    expect(workloads.filter((w) => w.cloud === 'gcp')).toHaveLength(2);
    expect(workloads.filter((w) => w.cloud !== 'gcp').every((w) => w.cloud === 'aws')).toBe(true);
    const vm = workloads.find((w) => w.workloadId === 'vm-demo')!;
    const detail = await mockApi(`/workloads/${vm.router}/${vm.workloadId}`) as Record<string, unknown>;
    expect(detail).toMatchObject({ cloud: 'gcp', account: 'dormeto-dev', region: 'europe-west2', name: 'Demo VM', lb: { kind: 'regional', region: 'europe-west2' } });
    expect(detail.backendService).toBeTruthy();
    expect(detail.urlMap).toBeTruthy();
    expect(detail.targetGroupArn).toBeUndefined();
  });

  it('finds no candidate of Google Cloud (discovery of its projects comes later), and no AWS router is touched', async () => {
    const { candidates } = await mockApi('/discovery/candidates?status=managed&limit=500') as { candidates: { account: string; cloud?: string }[] };
    expect(candidates.some((c) => c.account === 'dormeto-dev')).toBe(false);
  });

  it('has the router\'s own view with the CLI as the source of its settings, and resource paths for the VM\'s backend', async () => {
    const details = await mockApi(`/routers/${ROUTER}`) as { configuration: { checkSchedule: { source: string } } };
    expect(details.configuration.checkSchedule.source).toBe('cli');
    const status = await mockApi(`/workloads/${ROUTER}/vm-demo`) as { backends: { id: string }[]; targets: unknown[]; source: string };
    expect(status.source).toBe('cli');
    expect(status.targets).toEqual([]);
    expect(status.backends[0]!.id).toBe('projects/dormeto-dev/zones/europe-west2-a/instances/vm-demo');
  });

  it('answers its router\'s organization level as a Google Cloud router does: pushed (a readAt), no URL', async () => {
    const details = await mockApi(`/routers/${ROUTER}`) as { managerSettings?: { url: string | null; readAt: string | null } };
    expect(details.managerSettings?.url).toBeNull();
    expect(details.managerSettings?.readAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('refuses to offboard one of its workloads as the API does: the CLI\'s command', async () => {
    const refused = await mockApi('/operations', { method: 'POST', body: JSON.stringify({ type: 'offboard', router: ROUTER, workloadId: 'vm-demo' }) }).catch((e: unknown) => e) as { status: number; message: string };
    expect([refused.status, refused.message]).toEqual([400, 'a Google Cloud workload is offboarded with the CLI: dormeto gcp workloads offboard vm-demo --project dormeto-dev --region europe-west2']);
    const { workloads } = await mockApi(`/workloads?router=${ROUTER}`) as { workloads: WorkloadSummary[] };
    expect(workloads.map((w) => w.workloadId).sort()).toEqual(['mig-demo', 'vm-demo']);
  });

  it('answers the connection of its host project at GET /discovery/google as the API does, under connection', async () => {
    const answer = await mockApi('/discovery/google') as GoogleConnectionAnswer;
    expect(Object.keys(answer)).toEqual(['connection']);
    const connection = answer.connection!;
    expect(connection.project).toBe('dormeto-dev');
    expect(connection.routers.map((r) => r.region)).toEqual(['europe-west2']);
    expect(connection.serviceAccounts.discovery).toMatch(/^dmt-.*-discovery@dormeto-dev\.iam\.gserviceaccount\.com$/);
  });
});
