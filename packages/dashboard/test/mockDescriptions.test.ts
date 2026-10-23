import { describe, expect, it } from 'vitest';
import { mockApi } from '../src/mock';
import { state } from '../src/mock/state';
import type { RouterDetails, RouterInfo, WorkloadStatus, WorkloadSummary } from '../src/types';

const put = (path: string, text: unknown) => mockApi(path, { method: 'PUT', body: JSON.stringify({ text }) }) as Promise<{ description: { text: string; by: string; at: string } | null }>;

describe('the demo\'s descriptions', () => {
  it('seeds a few, with a heading, a list and a link, and lists their first line', async () => {
    const { workloads } = await mockApi('/workloads') as { workloads: WorkloadSummary[] };
    const described = workloads.filter((w) => w.summary);
    expect(described.length).toBeGreaterThanOrEqual(2);
    expect(described.length).toBeLessThan(workloads.length);
    const w = described[0]!;
    const status = await mockApi(`/workloads/${w.router}/${w.workloadId}`) as WorkloadStatus;
    expect(status.description!.text).toMatch(/^# .*\n[\s\S]*\n(- |1\. )[\s\S]*\]\(https:\/\//);
    expect(w.summary).toBe(status.description!.text.split('\n')[0]!.replace(/^#+\s*/, ''));
    const { routers } = await mockApi('/routers') as { routers: RouterInfo[] };
    expect(routers.some((r) => r.summary)).toBe(true);
    expect(routers.some((r) => !r.summary)).toBe(true);
  });

  it('answers null for a workload without one, and sets, replaces and clears (audited)', async () => {
    const { workloads } = await mockApi('/workloads') as { workloads: WorkloadSummary[] };
    const w = workloads.find((x) => !x.summary)!;
    const path = `/workloads/${w.router}/${w.workloadId}`;
    expect(((await mockApi(path)) as WorkloadStatus).description).toBeNull();
    const set = await put(`${path}/description`, '  # Hello\r\n\r\nworld  ');
    expect(set.description).toMatchObject({ text: '# Hello\n\nworld', by: state().me.email });
    expect(((await mockApi(path)) as WorkloadStatus).description!.text).toBe('# Hello\n\nworld');
    expect((await mockApi('/workloads') as { workloads: WorkloadSummary[] }).workloads.find((x) => x.workloadId === w.workloadId)!.summary).toBe('Hello');
    expect(state().audit[0]).toMatchObject({ action: 'description', result: 'set (14 characters)' });
    expect(await mockApi(`${path}/description`, { method: 'DELETE' })).toEqual({ description: null });
    expect(state().audit[0]).toMatchObject({ action: 'description', result: 'cleared' });
    expect(await put(`${path}/description`, '  ')).toEqual({ description: null });
    expect(((await mockApi(path)) as WorkloadStatus).description).toBeNull();
  });

  it('refuses a long text and a control character with a 400, and an unknown workload with a 404', async () => {
    const { workloads } = await mockApi('/workloads') as { workloads: WorkloadSummary[] };
    const w = workloads[0]!;
    const path = `/workloads/${w.router}/${w.workloadId}/description`;
    await expect(put(path, 'a'.repeat(4001))).rejects.toMatchObject({ status: 400, message: expect.stringContaining('4000') });
    await expect(put(path, 'a\u0007b')).rejects.toMatchObject({ status: 400, message: expect.stringContaining('control') });
    await expect(put(`/workloads/${w.router}/nope/description`, 'x')).rejects.toMatchObject({ status: 404 });
  });

  it('does the same for a router', async () => {
    const { routers } = await mockApi('/routers') as { routers: RouterInfo[] };
    const r = routers.find((x) => !x.summary)!;
    expect(((await mockApi(`/routers/${r.name}`)) as RouterDetails).description).toBeNull();
    expect((await put(`/routers/${r.name}/description`, 'The router')).description!.text).toBe('The router');
    expect(((await mockApi(`/routers/${r.name}`)) as RouterDetails).description!.text).toBe('The router');
    expect(await mockApi(`/routers/${r.name}/description`, { method: 'DELETE' })).toEqual({ description: null });
    await expect(put('/routers/nope/description', 'x')).rejects.toMatchObject({ status: 404 });
  });
});
