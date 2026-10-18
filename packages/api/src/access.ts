// Workload tags and tag-driven access control (tags design §3 and §4): the rules of the tags and of the groups' grants,
// and what a set of grants allows. The tag rules are the router's (lib/tags.mjs), with its words.
import type { Role } from './api.js';

export type Permission = 'read' | 'wake' | 'nap';
// A selector (every tag must match the workload's; empty means every workload) and what it gives.
export interface Grant { tags: Record<string, string>; permissions: Permission[] }

const TAGS_MAX = 50;
const KEY_MAX = 128;
const VALUE_MAX = 256;
const ALLOWED = /^[\p{L}\p{Z}\p{N}_.:/=+\-@]*$/u;
const PERMISSIONS: Permission[] = ['read', 'wake', 'nap'];
const GRANTS_MAX = 20;
const GROUP_NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;

// Lengths count characters (code points), as Terraform's length() does, not UTF-16 units.
const length = (s: string) => [...s].length;

// Why the tags are refused (naming the tag), or null.
export function tagsProblem(tags: unknown): string | null {
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) return 'tags: an object of key and value strings';
  const entries = Object.entries(tags);
  if (entries.length > TAGS_MAX) return `tags: at most ${TAGS_MAX}`;
  for (const [key, value] of entries) {
    if (length(key) < 1 || length(key) > KEY_MAX) return `tag "${key}": key of 1 to ${KEY_MAX} characters`;
    if (typeof value !== 'string') return `tag "${key}": value must be a string`;
    if (length(value) > VALUE_MAX) return `tag "${key}": value of at most ${VALUE_MAX} characters`;
    if (!ALLOWED.test(key)) return `tag "${key}": key characters: letters, digits, spaces and _ . : / = + - @`;
    if (!ALLOWED.test(value)) return `tag "${key}": value characters: letters, digits, spaces and _ . : / = + - @`;
    if (key.toLowerCase().startsWith('dormeto:')) return `tag "${key}": the dormeto: prefix is reserved`;
  }
  return null;
}

// A custom group's name: the dmt- prefix belongs to the built-in roles.
export function groupNameProblem(name: unknown): string | null {
  if (typeof name !== 'string' || !GROUP_NAME.test(name)) return 'group name: 1 to 48 lower-case letters, digits and hyphens, starting with a letter or digit';
  if (name.startsWith('dmt-')) return 'group name: the dmt- prefix is reserved for the built-in roles';
  return null;
}

// Why a group's grants are refused, or null.
export function grantsProblem(grants: unknown): string | null {
  if (!Array.isArray(grants)) return 'grants: an array';
  if (grants.length > GRANTS_MAX) return `grants: at most ${GRANTS_MAX}`;
  for (const [i, grant] of grants.entries()) {
    const at = `grant ${i + 1}`;
    if (!grant || typeof grant !== 'object' || Array.isArray(grant)) return `${at}: an object with tags and permissions`;
    const { tags, permissions } = grant as Record<string, unknown>;
    const problem = tagsProblem(tags);
    if (problem) return `${at}: ${problem}`;
    if (!Array.isArray(permissions) || permissions.length === 0 || !permissions.every((p) => PERMISSIONS.includes(p))) return `${at}: permissions: at least one of ${PERMISSIONS.join(', ')}`;
  }
  return null;
}

// The built-in roles' implicit grant: every workload (a member has none).
export function builtInGrants(role: Role): Grant[] {
  if (role === 'member') return [];
  return [{ tags: {}, permissions: role === 'viewer' ? ['read'] : [...PERMISSIONS] }];
}

// The grants a user acts with: their role's and their groups'. Where the multi-factor session is required and missing
// (mfaOk false), read only.
export function effective(role: Role, groupGrants: Grant[][], mfaOk: boolean): Grant[] {
  const all = [...builtInGrants(role), ...groupGrants.flat()];
  return mfaOk ? all : all.map(({ tags }) => ({ tags, permissions: ['read'] }));
}

// Whether the grants allow the permission on a workload with these tags; wake and nap imply read.
export function can(grants: Grant[], tags: Record<string, string> | undefined, permission: Permission): boolean {
  return grants.some((g) => (g.permissions.includes(permission) || (permission === 'read' && g.permissions.length > 0))
    && Object.entries(g.tags).every(([key, value]) => tags?.[key] === value));
}
