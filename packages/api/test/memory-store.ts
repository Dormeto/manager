// In-memory discovery store and candidates for the API tests.
import { InvalidCursor, type Candidate, type DiscoveryConfig, type DiscoveryStore, type Exclusion, type OrgInventory, type RunRecord, type StoredConfig } from '@dormeto/discovery';

export const NOW = Date.UTC(2026, 9, 4, 12, 0);

export function memoryStore(candidates: Candidate[] = [], run: RunRecord | null = null): DiscoveryStore & { config: StoredConfig | null; exclusions: Map<string, Exclusion>; runs: RunRecord[] } {
  const items = new Map(candidates.map((c) => [c.id, c]));
  const store = {
    config: null as StoredConfig | null,
    async getConfig() { return store.config; },
    async putConfig(config: DiscoveryConfig, by: string) { store.config = { config, updatedAt: new Date(NOW).toISOString(), updatedBy: by }; },
    async acquireLock() { return true; },
    async releaseLock() {},
    // Runs by start time; the last one, or the last one not skipped.
    runs: (run ? [run] : []) as RunRecord[],
    async lastRun({ completed = false }: { completed?: boolean } = {}) {
      return [...store.runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).find((r) => !completed || r.status !== 'skipped') ?? null;
    },
    async putRun(r: RunRecord) { store.runs = [...store.runs.filter((x) => x.startedAt !== r.startedAt), r]; },
    async listCandidates() { return [...items.values()]; },
    async getCandidate(id: string) { return items.get(id) ?? null; },
    async putCandidates(list: Candidate[]) { for (const c of list) items.set(c.id, c); },
    async deleteCandidates(list: Pick<Candidate, 'id'>[]) { for (const c of list) items.delete(c.id); },
    // As the index: in account, region and id order, after the cursor's position (the candidate there may have moved).
    async pageCandidates({ status, limit, cursor, account, region }: { status: Candidate['status']; limit: number; cursor?: string; account?: string; region?: string }) {
      const keyOf = (c: Candidate) => `${c.account}#${c.region}#${c.id}`;
      const prefix = account ? `${account}#${region ? `${region}#` : ''}` : '';
      if (cursor && !cursor.startsWith('k:')) throw new InvalidCursor();
      const after = cursor?.slice(2) ?? '';
      const all = [...items.values()].filter((c) => c.status === status && keyOf(c).startsWith(prefix) && keyOf(c) > after).sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
      const page = all.slice(0, limit);
      return { candidates: page, cursor: all.length > limit ? `k:${keyOf(page.at(-1)!)}` : null };
    },
    counts: null as { counts: Partial<Record<Candidate['status'], number>>; at: string } | null,
    async getCounts() { return structuredClone(store.counts); },
    async putCounts(counts: Partial<Record<Candidate['status'], number>>) { store.counts = { counts: { ...counts }, at: new Date(NOW).toISOString() }; },
    async replaceCandidates(after: Candidate[], before: Candidate[]) {
      for (const c of after) items.set(c.id, c);
      if (!store.counts) return;
      const counts = store.counts.counts;
      for (const c of after) {
        const from = before.find((b) => b.id === c.id)?.status;
        if (from === c.status) continue;
        if (from && !(counts[from] = (counts[from] ?? 0) - 1)) delete counts[from];
        counts[c.status] = (counts[c.status] ?? 0) + 1;
      }
    },
    async accountCandidates(account: string) { return [...items.values()].filter((c) => c.account === account); },
    async getAccountScan() { return null; },
    async putAccountScan() {},
    async deleteAccountScan() {},
    async listAccountScans() { return []; },
    async getAccountScans() { return []; },
    async getRun() { return null; },
    async countCandidates() { return {}; },
    async getInventory(): Promise<OrgInventory | null> { return { accounts: [{ id: '121014831971', name: 'dormeto', ouPath: ['r-1u0b'], tags: {} }], ous: { 'r-1u0b': { name: 'Root', parent: null } } }; },
    async putInventory() {},
    async getAccess() { return null; },
    async putAccess() {},
    async accessReport() { return { counts: { ready: 0, discoveryMissing: 0, commandMissing: 0, unchecked: 0 }, accounts: [], cursor: null, delegation: null, checkedAt: null }; },
    exclusions: new Map<string, Exclusion>(),
    async listExclusions() { return [...store.exclusions.values()]; },
    async getExclusion(id: string) { return store.exclusions.get(id) ?? null; },
    async putExclusion(e: Exclusion) { store.exclusions.set(e.id, structuredClone(e)); },
    async updateExclusion(id: string, change: (e: Exclusion) => Exclusion | Promise<Exclusion>) {
      const e = store.exclusions.get(id);
      if (!e) return null;
      const next = await change(structuredClone(e));
      store.exclusions.set(id, structuredClone(next));
      return next;
    },
    async deleteExclusion(id: string) { store.exclusions.delete(id); },
  };
  return store;
}

export const candidate = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  id, account: '121014831971', region: 'eu-west-1', loadBalancer: 'web', loadBalancerArn: 'lb', listener: 'HTTPS:443', priority: '10',
  conditions: 'host a.example.com', hosts: ['a.example.com'], targetGroup: 'a', targetGroupArn: 'tg',
  backend: { kind: 'instance', id: 'i-1' }, tags: {}, rules: [], eligibility: 'eligible', idleHours7d: 160, requests7d: 3,
  accountName: 'dormeto', ouPath: ['r-1u0b'], scope: 'in', scopeReason: 'in scope: filter "a", include 1',
  status: 'pending-onboarding', statusReason: 'eligible', firstSeenAt: '2026-10-04T11:00:00.000Z', lastSeenAt: '2026-10-04T11:00:00.000Z',
  history: [{ at: '2026-10-04T11:00:00.000Z', status: 'pending-onboarding', reason: 'eligible' }],
  ...over,
});

