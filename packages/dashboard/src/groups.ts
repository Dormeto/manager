// Custom groups and their grants (R11, tags design section 4), as the dashboard edits them.
import { rowsOf, rowsProblem, tagsOf, type TagRow, type Tags } from './tags';

export type Permission = 'read' | 'wake' | 'nap';
export const PERMISSIONS: Permission[] = ['read', 'wake', 'nap'];
export const GRANTS_MAX = 20;
export const DESCRIPTION_MAX = 200;

export interface Grant { tags: Tags; permissions: Permission[] }
// What the API gives of a group (GET /api/groups).
export interface Group { name: string; description: string; grants: Grant[]; updatedAt: string | null; updatedBy: string | null }
// A grant in the editor: the selector's rows and the boxes ticked (read is implied by the two others).
export interface GrantRow { rows: TagRow[]; permissions: Permission[] }

export const grantRowsOf = (grants: Grant[]): GrantRow[] => grants.map((g) => ({ rows: rowsOf(g.tags), permissions: [...g.permissions] }));
// wake and nap imply read: it is sent with them, in the canonical order.
const withRead = (p: Permission[]): Permission[] => PERMISSIONS.filter((x) => p.includes(x) || (x === 'read' && p.length > 0));
export const grantsOf = (rows: GrantRow[]): Grant[] => rows.map((g) => ({ tags: tagsOf(g.rows), permissions: withRead(g.permissions) }));

// Why the grants are refused, or null.
export function grantRowsProblem(rows: GrantRow[]): string | null {
  if (rows.length > GRANTS_MAX) return `grants: at most ${GRANTS_MAX}`;
  for (const [i, g] of rows.entries()) {
    const problem = rowsProblem(g.rows);
    if (problem) return `grant ${i + 1}: ${problem}`;
    if (!g.permissions.length) return `grant ${i + 1}: choose at least one permission`;
  }
  return null;
}

export const selectorText = (tags: Tags): string => {
  const entries = rowsOf(tags);
  return entries.length ? entries.map((r) => `${r.key}=${r.value}`).join(', ') : 'every workload';
};
export const grantText = (g: Grant): string => `${selectorText(g.tags)} · ${g.permissions.join(', ')}`;
