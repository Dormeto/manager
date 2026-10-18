// Workload tags (R11), as the router and the API rule them (tags design section 3): the same limits, in the router's words,
// so that the dialog refuses before the API does and says the same thing.
export type Tags = Record<string, string>;
export interface TagRow { key: string; value: string }

const TAGS_MAX = 50;
const KEY_MAX = 128;
const VALUE_MAX = 256;
const ALLOWED = /^[\p{L}\p{Z}\p{N}_.:/=+\-@]*$/u;
// Lengths count characters (code points), as the router's and Terraform's do.
const length = (s: string) => [...s].length;

// Why the tags are refused (naming the tag), or null.
export function tagsProblem(tags: Tags): string | null {
  const entries = Object.entries(tags);
  if (entries.length > TAGS_MAX) return `tags: at most ${TAGS_MAX}`;
  for (const [key, value] of entries) {
    if (length(key) < 1 || length(key) > KEY_MAX) return `tag "${key}": key of 1 to ${KEY_MAX} characters`;
    if (length(value) > VALUE_MAX) return `tag "${key}": value of at most ${VALUE_MAX} characters`;
    if (!ALLOWED.test(key)) return `tag "${key}": key characters: letters, digits, spaces and _ . : / = + - @`;
    if (!ALLOWED.test(value)) return `tag "${key}": value characters: letters, digits, spaces and _ . : / = + - @`;
    if (key.toLowerCase().startsWith('dormeto:')) return `tag "${key}": the dormeto: prefix is reserved`;
  }
  return null;
}

export const rowsOf = (tags: Tags | undefined): TagRow[] => Object.entries(tags ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, value }));
// A row with neither key nor value is an empty line of the editor: it says nothing.
const filled = (rows: TagRow[]) => rows.filter((r) => r.key !== '' || r.value !== '');
export const tagsOf = (rows: TagRow[]): Tags => Object.fromEntries(filled(rows).map((r) => [r.key, r.value]));

// Why the rows are refused, or null: a key twice (it would be silently merged), then the tag rules.
export function rowsProblem(rows: TagRow[]): string | null {
  const seen = new Set<string>();
  for (const { key } of filled(rows)) {
    if (seen.has(key)) return `tag "${key}": given twice`;
    seen.add(key);
  }
  return tagsProblem(tagsOf(rows));
}

export const tagText = (key: string, value: string) => `${key}=${value}`;
export const tagsList = (tags: Tags | undefined): { key: string; value: string; text: string }[] =>
  rowsOf(tags).map((r) => ({ ...r, text: tagText(r.key, r.value) }));

// The group name rules of the API (design section 4), for the Groups card.
export function groupNameProblem(name: string): string | null {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(name)) return 'group name: 1 to 48 lower-case letters, digits and hyphens, starting with a letter or digit';
  if (name.startsWith('dmt-')) return 'group name: the dmt- prefix is reserved for the built-in roles';
  return null;
}
