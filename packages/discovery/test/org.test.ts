import { describe, expect, it } from 'vitest';
import { loadInventory, type OrganizationsPort } from '../src/org.js';

// root ─ acc 1, acc 2 (suspended)
//      └ ou-a ─ acc 3
//               └ ou-b ─ acc 4, acc 5, acc 6 (three accounts: two pages)
const OUS: Record<string, { Id: string; Name: string }[]> = {
  'r-1u0b': [{ Id: 'ou-1u0b-aaaaaaaa', Name: 'a' }],
  'ou-1u0b-aaaaaaaa': [{ Id: 'ou-1u0b-bbbbbbbb', Name: 'b' }],
  'ou-1u0b-bbbbbbbb': [],
};
const ACCOUNTS: Record<string, { Id: string; Name: string; State: string }[]> = {
  'r-1u0b': [{ Id: '100000000001', Name: 'one', State: 'ACTIVE' }, { Id: '100000000002', Name: 'two', State: 'SUSPENDED' }],
  'ou-1u0b-aaaaaaaa': [{ Id: '100000000003', Name: 'three', State: 'ACTIVE' }],
  'ou-1u0b-bbbbbbbb': [{ Id: '100000000004', Name: 'four', State: 'ACTIVE' }, { Id: '100000000005', Name: 'five', State: 'ACTIVE' }, { Id: '100000000006', Name: 'six', State: 'ACTIVE' }],
};
const TAGS: Record<string, { Key: string; Value: string }[]> = { '100000000004': [{ Key: 'env', Value: 'dev' }] };

function fakeOrganizations() {
  const calls: string[] = [];
  const paged = <T>(items: T[], token?: string) => {
    const start = Number(token ?? 0);
    return { items: items.slice(start, start + 2), next: start + 2 < items.length ? String(start + 2) : undefined };
  };
  const port: OrganizationsPort = {
    async listRoots() { calls.push('roots'); return { Roots: [{ Id: 'r-1u0b', Name: 'Root' }] }; },
    async listOrganizationalUnitsForParent({ ParentId, NextToken }) {
      const { items, next } = paged(OUS[ParentId] ?? [], NextToken);
      return { OrganizationalUnits: items, NextToken: next };
    },
    async listAccountsForParent({ ParentId, NextToken }) {
      calls.push(`accounts ${ParentId} ${NextToken ?? ''}`.trim());
      const { items, next } = paged(ACCOUNTS[ParentId] ?? [], NextToken);
      return { Accounts: items, NextToken: next };
    },
    async listTagsForResource({ ResourceId }) { calls.push(`tags ${ResourceId}`); return { Tags: TAGS[ResourceId] ?? [] }; },
  };
  return { port, calls };
}

describe('loadInventory', () => {
  it('walks the OU tree, follows pages, and gives each active account its OU path from the root', async () => {
    const { port, calls } = fakeOrganizations();
    const inventory = await loadInventory(port);
    expect(inventory.accounts.map((a) => [a.id, a.ouPath])).toEqual([
      ['100000000001', ['r-1u0b']],
      ['100000000003', ['r-1u0b', 'ou-1u0b-aaaaaaaa']],
      ['100000000004', ['r-1u0b', 'ou-1u0b-aaaaaaaa', 'ou-1u0b-bbbbbbbb']],
      ['100000000005', ['r-1u0b', 'ou-1u0b-aaaaaaaa', 'ou-1u0b-bbbbbbbb']],
      ['100000000006', ['r-1u0b', 'ou-1u0b-aaaaaaaa', 'ou-1u0b-bbbbbbbb']],
    ]);
    expect(inventory.ous).toEqual({
      'r-1u0b': { name: 'Root', parent: null },
      'ou-1u0b-aaaaaaaa': { name: 'a', parent: 'r-1u0b' },
      'ou-1u0b-bbbbbbbb': { name: 'b', parent: 'ou-1u0b-aaaaaaaa' },
    });
    expect(calls).toContain('accounts ou-1u0b-bbbbbbbb 2');
    expect(calls.some((c) => c.startsWith('tags'))).toBe(false);
  });

  it('reads account tags only when asked', async () => {
    const { port } = fakeOrganizations();
    const inventory = await loadInventory(port, { tags: true });
    expect(inventory.accounts.find((a) => a.id === '100000000004')!.tags).toEqual({ env: 'dev' });
    expect(inventory.accounts.find((a) => a.id === '100000000005')!.tags).toEqual({});
  });
});

describe('account tags', () => {
  it('reads them 5 accounts at a time (Organizations allows 10 calls a second)', async () => {
    const { port } = fakeOrganizations();
    let running = 0;
    let peak = 0;
    const many: OrganizationsPort = {
      ...port,
      async listAccountsForParent({ ParentId }) {
        return { Accounts: ParentId === 'r-1u0b' ? Array.from({ length: 23 }, (_, i) => ({ Id: String(200000000000 + i), Name: `a${i}`, State: 'ACTIVE' })) : [] };
      },
      async listTagsForResource({ ResourceId }) {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 2));
        running -= 1;
        return { Tags: [{ Key: 'id', Value: ResourceId }] };
      },
    };
    const inventory = await loadInventory(many, { tags: true });
    expect(peak).toBe(5);
    expect(inventory.accounts.every((a) => a.tags.id === a.id)).toBe(true);
  });
});
