import { describe, expect, it, vi } from 'vitest';

// The handler hands the region scan the perimeter's standalone scan (vision standalone workloads design §6), with no AWS
// call: the run is replaced by one that scans a pair with it on, the scan by one that records its options.
const seen = vi.hoisted(() => ({ options: undefined as { standalone?: boolean; onStandalone?: unknown } | undefined }));
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class { send = async () => ({ Account: '111122223333' }); },
  GetCallerIdentityCommand: class {},
}));
vi.mock('../src/proxy-prefix.js', () => ({ createProxyPrefixes: () => async () => null }));
vi.mock('../src/scan.js', () => ({
  scanRegion: async (_ports: unknown, _where: unknown, options: typeof seen.options) => { seen.options = options; return []; },
}));
vi.mock('../src/run.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/run.js')>()),
  runDiscovery: async (deps: { scan(credentials: unknown, where: { account: string; region: string }, options?: unknown): Promise<unknown> }) => {
    await deps.scan({}, { account: '111122223333', region: 'eu-west-1' }, { storedIdle: async () => new Map(), standalone: true, onStandalone: () => {} });
    return { runId: 'r', status: 'ok', targets: [], skipped: [], counts: {}, lint: [] };
  },
  runSummary: () => ({}),
}));

describe('the handler\'s region scan', () => {
  it('scans for standalone candidates when the run asks, and tells the run what the scan could not read', async () => {
    const { handler } = await import('../src/handler.js');
    await handler({});
    expect([seen.options?.standalone, seen.options?.onStandalone]).toEqual([true, expect.any(Function)]);
  });
});
