// In-memory discovery store and candidates for the API tests.
import type { Candidate, DiscoveryConfig, DiscoveryStore, Exclusion, OrgInventory, RunRecord, StoredConfig } from '@dormeto/discovery';

export const NOW = Date.UTC(2026, 9, 4, 12, 0);

export function memoryStore(candidates: Candidate[] = [], run: RunRecord | null = null): DiscoveryStore & { config: StoredConfig | null; exclusions: Map<string, Exclusion> } {
  const items = new Map(candidates.map((c) => [c.id, c]));
  const store = {
    config: null as StoredConfig | null,
    async getConfig() { return store.config; },
    async putConfig(config: DiscoveryConfig, by: string) { store.config = { config, updatedAt: new Date(NOW).toISOString(), updatedBy: by }; },
    async acquireLock() { return true; },
    async releaseLock() {},
    async lastRun() { return run; },
    async putRun() {},
    async listCandidates() { return [...items.values()]; },
    async getCandidate(id: string) { return items.get(id) ?? null; },
    async putCandidates(list: Candidate[]) { for (const c of list) items.set(c.id, c); },
    async deleteCandidates(ids: string[]) { for (const id of ids) items.delete(id); },
    async getInventory(): Promise<OrgInventory | null> { return { accounts: [{ id: '121014831971', name: 'dormeto', ouPath: ['r-1u0b'], tags: {} }], ous: { 'r-1u0b': { name: 'Root', parent: null } } }; },
    async putInventory() {},
    exclusions: new Map<string, Exclusion>(),
    async listExclusions() { return [...store.exclusions.values()]; },
    async getExclusion(id: string) { return store.exclusions.get(id) ?? null; },
    async putExclusion(e: Exclusion) { store.exclusions.set(e.id, structuredClone(e)); },
    async deleteExclusion(id: string) { store.exclusions.delete(id); },
  };
  return store;
}

export const candidate = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  id, account: '121014831971', region: 'eu-west-1', loadBalancer: 'web', loadBalancerArn: 'lb', listener: 'HTTPS:443', priority: '10',
  conditions: 'host a.example.com', hosts: ['a.example.com'], targetGroup: 'a', targetGroupArn: 'tg', suggestedId: 'a',
  backend: { kind: 'instance', id: 'i-1' }, tags: {}, rules: [], eligibility: 'eligible', idleHours7d: 160, requests7d: 3,
  accountName: 'dormeto', ouPath: ['r-1u0b'], scope: 'in', scopeReason: 'in scope: filter "a", include 1',
  status: 'pending-onboarding', statusReason: 'eligible: instance i-1', firstSeenAt: '2026-10-04T11:00:00.000Z', lastSeenAt: '2026-10-04T11:00:00.000Z',
  history: [{ at: '2026-10-04T11:00:00.000Z', status: 'pending-onboarding', reason: 'eligible: instance i-1' }],
  ...over,
});

