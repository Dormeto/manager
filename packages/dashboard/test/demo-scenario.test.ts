// The demo's generated organization (src/mock/scenario.ts, npm run dev:mock): read from a scenario's text, the same for
// the same seed, of the sizes asked, and consistent enough for the whole demo to build on it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SCENARIO, organization, parseScenario } from '../src/mock/scenario';

describe('demo scenario', () => {
  afterEach(() => {
    sessionStorage.clear();
    vi.resetModules();
  });

  it('reads the seed and the sizes, keeping the default for what is missing or wrong', () => {
    expect(parseScenario(undefined)).toEqual(DEFAULT_SCENARIO);
    expect(parseScenario('acme, workloads=60 ,routers=5')).toMatchObject({ seed: 'acme', workloads: 60, routers: 5, accounts: DEFAULT_SCENARIO.accounts });
    expect(parseScenario('workloads=100000,people=-3,accounts=x')).toMatchObject({ workloads: 400, people: 1, accounts: DEFAULT_SCENARIO.accounts });
    expect(parseScenario('regions=us-west-2+mars-1').regions).toEqual(['us-west-2']);
    expect(parseScenario('regions=mars-1').regions).toEqual(DEFAULT_SCENARIO.regions);
    expect(parseScenario('domain=acme.test').domain).toBe('acme.test');
    expect(parseScenario('domain=not a domain').domain).toBe(DEFAULT_SCENARIO.domain);
  });

  it('gives the same organization for the same seed, another for another seed', () => {
    const a = organization(parseScenario('acme'));
    expect(organization(parseScenario('acme'))).toEqual(a);
    const b = organization(parseScenario('globex'));
    expect(b.accounts.map((x) => x.id)).not.toEqual(a.accounts.map((x) => x.id));
    expect(b.workloads.map((w) => w.name)).not.toEqual(a.workloads.map((w) => w.name));
  });

  for (const text of ['', 'acme', 'tiny,people=1,accounts=1,routers=1,workloads=2,candidates=1', 'big,accounts=20,routers=30,workloads=300,candidates=120,people=12']) {
    it(`builds a consistent organization (${text || 'default'})`, () => {
      const s = parseScenario(text);
      const org = organization(s);
      expect(org.people).toHaveLength(s.people);
      expect(org.people[0]).toMatchObject({ email: org.me, role: 'admin' });
      expect(org.accounts).toHaveLength(s.accounts);
      expect(new Set(org.accounts.map((a) => a.id)).size).toBe(s.accounts);
      for (const a of org.accounts) expect(a.id).toMatch(/^[1-9]\d{11}$/);
      expect(org.routers.length).toBeGreaterThan(0);
      expect(org.routers.length).toBeLessThanOrEqual(s.routers);
      expect(new Set(org.routers.map((r) => `${r.account}/${r.region}`)).size).toBe(org.routers.length);
      expect(org.workloads).toHaveLength(s.workloads);
      expect(org.candidates).toHaveLength(s.candidates);
      // Names are target groups: unique across workloads and candidates.
      const names = [...org.workloads, ...org.candidates].map((x) => x.name);
      expect(new Set(names).size).toBe(names.length);
      for (const w of org.workloads) {
        const router = org.routers.find((r) => r.name === w.router);
        expect(router, w.name).toBeDefined();
        for (const b of w.backends) if (b.kind === 'k8s') expect(router!.clusters).toContain(b.cluster);
        expect(w.hosts?.[0]).toBe(`${w.name}.${s.domain}`);
      }
      for (const c of org.candidates) {
        expect(org.accounts.some((a) => a.id === c.account), c.name).toBe(true);
        expect(s.regions).toContain(c.region);
      }
    });
  }

  it('gives the default demo every state and story', () => {
    const org = organization(DEFAULT_SCENARIO);
    const states = new Set(org.workloads.map((w) => w.state));
    for (const state of ['ASLEEP', 'AWAKE', 'NAPPING', 'WAKING', 'FAILED']) expect(states).toContain(state);
    expect(org.workloads.some((w) => w.paused)).toBe(true);
    expect(org.workloads.some((w) => w.drift)).toBe(true);
    expect(org.routers.some((r) => r.version !== org.routers[0]!.version)).toBe(true);
    for (const status of ['pending-onboarding', 'ineligible', 'dismissed', 'gone']) expect(org.candidates.map((c) => c.status)).toContain(status);
    expect(org.accountExclusion).not.toBeNull();
  });

  it('builds the whole demo on the scenario kept for the tab', async () => {
    sessionStorage.setItem('dormeto.demo', 'initech,workloads=40,routers=4');
    const { mockApi } = await import('../src/mock');
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const call = <T>(path: string) => {
      const answer = mockApi(path) as Promise<T>;
      vi.runAllTimers();
      return answer;
    };
    const { workloads } = await call<{ workloads: { router: string }[] }>('/workloads?limit=1000');
    expect(workloads).toHaveLength(40);
    const { routers } = await call<{ routers: unknown[] }>('/routers');
    expect(routers.length).toBeGreaterThanOrEqual(4);
    const audit = await call<{ entries: { who: string }[] }>('/audit');
    expect(audit.entries.length).toBeGreaterThan(10);
    expect(audit.entries.every((e) => e.who.endsWith('@example.com') || e.who === 'discovery')).toBe(true);
    vi.useRealTimers();
  });
});
