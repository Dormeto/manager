import { describe, expect, it, vi } from 'vitest';

// What the handler hands the run and the region scan, with no AWS call: the run is replaced by one that scans a pair, the
// scan by one that records its options.
const seen = vi.hoisted(() => ({ options: undefined as { storedIdle?: () => Promise<Map<string, unknown>> } | undefined }));
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
    await deps.scan({}, { account: '111122223333', region: 'eu-west-1' }, { storedIdle: async () => new Map() });
    return { runId: 'r', status: 'ok', targets: [], skipped: [], counts: {}, lint: [] };
  },
  runSummary: () => ({}),
}));

describe('the handler\'s region scan', () => {
  it('gets the run\'s stored idle shares, for the target groups CloudWatch fails for', async () => {
    const { handler } = await import('../src/handler.js');
    await handler({});
    expect(seen.options?.storedIdle).toBeTypeOf('function');
  });
});
