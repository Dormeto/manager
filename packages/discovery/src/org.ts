// Organization inventory through the read-only Organizations delegation: OU tree, active accounts with their OU path
// (root first) and, when a criterion needs them, their tags.
import type { Account, OrgInventory } from './types.js';

type Page<K extends string, T> = { [key in K]?: T[] } & { NextToken?: string };

export interface OrganizationsPort {
  listRoots(input: { NextToken?: string }): Promise<Page<'Roots', { Id?: string; Name?: string }>>;
  listOrganizationalUnitsForParent(input: { ParentId: string; NextToken?: string }): Promise<Page<'OrganizationalUnits', { Id?: string; Name?: string }>>;
  listAccountsForParent(input: { ParentId: string; NextToken?: string }): Promise<Page<'Accounts', { Id?: string; Name?: string; State?: string; Status?: string }>>;
  listTagsForResource(input: { ResourceId: string; NextToken?: string }): Promise<Page<'Tags', { Key?: string; Value?: string }>>;
}

async function pages<T>(call: (token?: string) => Promise<{ NextToken?: string } & Record<string, unknown>>, key: string): Promise<T[]> {
  const items: T[] = [];
  let token: string | undefined;
  do {
    const page = await call(token);
    items.push(...((page[key] as T[] | undefined) ?? []));
    token = page.NextToken;
  } while (token);
  return items;
}

export async function loadInventory(org: OrganizationsPort, { tags = false }: { tags?: boolean } = {}): Promise<OrgInventory> {
  const roots = await pages<{ Id?: string; Name?: string }>((t) => org.listRoots({ NextToken: t }), 'Roots');
  const ous: OrgInventory['ous'] = {};
  const accounts: Account[] = [];
  const queue: { id: string; path: string[] }[] = [];
  for (const root of roots) {
    if (!root.Id) continue;
    ous[root.Id] = { name: root.Name ?? 'Root', parent: null };
    queue.push({ id: root.Id, path: [root.Id] });
  }
  while (queue.length) {
    const { id, path } = queue.shift()!;
    const members = await pages<{ Id?: string; Name?: string; State?: string; Status?: string }>((t) => org.listAccountsForParent({ ParentId: id, NextToken: t }), 'Accounts');
    for (const a of members) {
      // State replaces the deprecated Status; only active accounts can be scanned.
      if (!a.Id || (a.State ?? a.Status) !== 'ACTIVE') continue;
      accounts.push({ id: a.Id, name: a.Name ?? a.Id, ouPath: path, tags: {} });
    }
    const children = await pages<{ Id?: string; Name?: string }>((t) => org.listOrganizationalUnitsForParent({ ParentId: id, NextToken: t }), 'OrganizationalUnits');
    for (const ou of children) {
      if (!ou.Id) continue;
      ous[ou.Id] = { name: ou.Name ?? ou.Id, parent: id };
      queue.push({ id: ou.Id, path: [...path, ou.Id] });
    }
  }
  if (tags) {
    for (const account of accounts) {
      const list = await pages<{ Key?: string; Value?: string }>((t) => org.listTagsForResource({ ResourceId: account.id, NextToken: t }), 'Tags');
      account.tags = Object.fromEntries(list.map((t) => [t.Key ?? '', t.Value ?? '']));
    }
  }
  return { accounts, ous };
}
