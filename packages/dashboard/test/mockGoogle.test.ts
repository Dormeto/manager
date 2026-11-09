import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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

  it('names its workloads\' backend services and URL map by name, as the router\'s row does, with the load balancer\'s kind', async () => {
    const detail = await mockApi(`/workloads/${ROUTER}/vm-demo`) as Record<string, unknown>;
    expect(detail).toMatchObject({ backendService: 'vm-demo', wakerBackendService: 'vm-demo-waker', urlMap: 'dormeto-dev-lb', lb: { kind: 'regional', region: 'europe-west2' } });
  });

  type Row = Record<string, any>;
  const candidates = async (status: string, extra = '') => (await mockApi(`/discovery/candidates?status=${status}&limit=500${extra}`) as { candidates: Row[] }).candidates;
  const google = async (status: string) => (await candidates(status)).filter((c) => c.account === 'dormeto-dev');

  it('finds the project\'s candidates as the API answers them: the backend service\'s path as the id, its name and the URL map\'s, global, the kind of load balancer', async () => {
    const [eligible] = await google('pending-onboarding');
    expect(eligible).toMatchObject({
      id: 'projects/dormeto-dev/global/backendServices/shop-bs', cloud: 'gcp', account: 'dormeto-dev', region: 'global', targetGroup: 'shop-bs', targetGroupArn: null, loadBalancer: 'shop-lb',
      loadBalancerArn: '', listener: '', priority: '', rules: [], backendService: 'projects/dormeto-dev/global/backendServices/shop-bs', urlMap: 'projects/dormeto-dev/global/urlMaps/shop-lb',
      lb: { kind: 'global' }, backend: { kind: 'asg' }, status: 'pending-onboarding',
    });
    expect(eligible!.idleHours7d).toEqual(expect.any(Number));
  });

  it('has the demo\'s two workloads as managed candidates of their regional load balancer, with their workload', async () => {
    const managed = await google('managed');
    expect(managed.map((c) => [c.targetGroup, c.workloadId, c.workload?.name, c.region, c.backend.kind]).sort()).toEqual([
      ['mig-demo', 'mig-demo', 'mig-demo', 'europe-west2', 'asg'], ['vm-demo', 'vm-demo', 'Demo VM', 'europe-west2', 'instance'],
    ]);
    expect(managed.find((c) => c.targetGroup === 'vm-demo')).toMatchObject({ id: 'projects/dormeto-dev/regions/europe-west2/backendServices/vm-demo', lb: { kind: 'regional' }, workload: { router: ROUTER } });
  });

  it('refuses a GKE workload and a backend service named in two URL maps, in the router\'s words', async () => {
    const ineligible = await google('ineligible');
    const gke = ineligible.find((c) => c.backend?.kind === 'k8s')!;
    expect(gke.statusReason).toBe('a GKE workload is onboarded with dormeto gcp workloads onboard, after dormeto gcp workloads access grant');
    const twice = ineligible.find((c) => /is also named in URL map/.test(c.statusReason))!;
    expect(twice.statusReason).toBe(`backend service ${twice.targetGroup} is also named in URL map shop-lb: that load balancer would lose its backends during a nap; give it a backend service of its own`);
  });

  it('filters the candidates by the project, and by its region, or by global', async () => {
    expect((await candidates('pending-onboarding', '&account=dormeto-dev&region=global')).map((c) => c.targetGroup)).toEqual(['shop-bs']);
    expect(await candidates('pending-onboarding', '&account=dormeto-dev&region=europe-west2')).toEqual([]);
    expect((await candidates('managed', '&account=dormeto-dev&region=europe-west2')).length).toBe(2);
  });

  it('keeps the AWS candidates AWS: none has a Google Cloud project, a backend service or a null target group ARN of a Google one', async () => {
    for (const status of ['pending-onboarding', 'managed', 'ineligible']) {
      for (const c of (await candidates(status)).filter((x) => x.account !== 'dormeto-dev')) expect(c.backendService).toBeUndefined();
    }
  });

  it('lists a project in the access report: readable, its command missing, with the reason naming the connect command', async () => {
    const report = await mockApi('/discovery/access?limit=1000') as { accounts: { account: string; discovery: { ok: boolean }; command: { ok: boolean; reason?: string } }[]; counts: { commandMissing: number } };
    const project = report.accounts.find((a) => a.account === 'shop-prod')!;
    expect(project.discovery.ok).toBe(true);
    expect(project.command.ok).toBe(false);
    expect(project.command.reason).toContain('on the project shop-prod: dormeto gcp connect --project dormeto-dev --profile <profile> --env dev');
    expect(report.counts.commandMissing).toBe(report.accounts.length);
  });

  it('excludes a backend service by its path as the API does, and its project, and keeps a managed one\'s workload paused', async () => {
    const path = 'projects/dormeto-dev/global/backendServices/shop-bs';
    await mockApi('/exclusions', { method: 'POST', body: JSON.stringify({ target: { kind: 'target-group', path }, reason: 'shared' }) });
    expect((await google('excluded')).map((c) => c.id)).toEqual([path]);
    const { exclusions } = await mockApi('/exclusions') as { exclusions: { target: Row }[] };
    expect(exclusions.find((e) => e.target.path === path)!.target).toMatchObject({ kind: 'target-group', path, account: 'dormeto-dev', region: 'global', name: 'shop-bs' });
    await mockApi('/exclusions', { method: 'POST', body: JSON.stringify({ target: { kind: 'load-balancer', path: 'projects/dormeto-dev/regions/europe-west2/urlMaps/dormeto-dev-lb' }, reason: 'frozen' }) });
    const paused = await google('pending-offboarding');
    expect(paused.map((c) => c.targetGroup).sort()).toEqual(['mig-demo', 'vm-demo']);
    const wrong = await mockApi('/exclusions', { method: 'POST', body: JSON.stringify({ target: { kind: 'target-group', path: 'arn:aws:x' }, reason: 'x' }) }).catch((e: unknown) => e) as { status: number };
    expect(wrong.status).toBe(400);
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

  describe('onboarding and offboarding', () => {
    afterEach(() => vi.useRealTimers());
    // The exclusions an earlier test made on the project.
    beforeAll(async () => {
      const { exclusions } = await mockApi('/exclusions') as { exclusions: { id: string; target: { account: string } }[] };
      for (const e of exclusions.filter((x) => x.target.account === 'dormeto-dev')) await mockApi(`/exclusions/${e.id}`, { method: 'DELETE' });
    });
    const SHOP = 'projects/dormeto-dev/global/backendServices/shop-bs';
    type Op = { id: string; status: string; steps: { name: string; status: string; detail?: string }[]; target: Record<string, string> };
    const post = (body: Record<string, unknown>) => mockApi('/operations', { method: 'POST', body: JSON.stringify(body) }).catch((e: unknown) => e) as Promise<{ operation: Op } & { status: number; message: string }>;
    const later = (ms: number) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + ms); };

    it('onboards a global candidate through the project\'s router in the Google Cloud plan, then shows it managed with its workload', async () => {
      expect((await post({ type: 'onboard', candidateId: SHOP, router: 'dmtr-nope', settings: {}, databases: [] })).status).toBe(404);
      const answer = await post({ type: 'onboard', candidateId: SHOP, name: 'Shop', settings: { idleMinutes: 20, fallbackInstanceTypes: ['e2-medium'] }, databases: [{ kind: 'cloudsql-instance', id: 'db-shop' }], tags: { team: 'shop' } });
      if (!answer.operation) throw new Error(JSON.stringify(answer));
      const { operation } = answer;
      expect(operation.steps.map((x) => x.name)).toEqual(['find router', 'slot', 'lock load balancer', 'preview', 'tag', 'onboard', 'verify', 'candidate']);
      expect(operation.steps[0]!.detail).toContain(ROUTER);
      expect(operation.target).toMatchObject({ account: 'dormeto-dev', region: 'europe-west2', router: ROUTER, backendService: SHOP });
      const running = (await google('pending-onboarding')).find((c) => c.id === SHOP)!;
      expect(running.operation).toMatchObject({ id: operation.id, type: 'onboard' });
      later(5 * 60_000);
      const managed = (await google('managed')).find((c) => c.id === SHOP)!;
      expect(managed.workload).toMatchObject({ router: ROUTER, name: 'Shop' });
      const w = await mockApi(`/workloads/${ROUTER}/${managed.workloadId}`) as { name: string; source: string; cloud: string; backendService: string; urlMap: string; tags: Record<string, string> };
      expect(w).toMatchObject({ name: 'Shop', source: 'manager', cloud: 'gcp', backendService: 'shop-bs', urlMap: 'shop-lb', tags: { team: 'shop' } });
    });

    it('refuses a GKE candidate, which is ineligible', async () => {
      const gke = (await google('ineligible')).find((c) => c.backend?.kind === 'k8s')!;
      const refused = await post({ type: 'onboard', candidateId: gke.id, settings: {}, databases: [] });
      expect(refused.status).toBe(409);
    });

    it('offboards one of its workloads in the Google Cloud plan, and gives its candidate back', async () => {
      const { operation } = await post({ type: 'offboard', router: ROUTER, workloadId: 'vm-demo' });
      expect(operation.steps.map((x) => x.name)).toEqual(['locate', 'slot', 'lock load balancer', 'pause', 'wait awake', 'offboard', 'untag', 'candidate']);
      later(5 * 60_000);
      const { workloads } = await mockApi(`/workloads?router=${ROUTER}`) as { workloads: WorkloadSummary[] };
      expect(workloads.map((w) => w.workloadId)).not.toContain('vm-demo');
      expect((await google('pending-onboarding')).map((c) => c.targetGroup)).toContain('vm-demo');
    });
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
