// The dashboard's tables (tables design §5): a column's header, a row's or the table's action, what an export is called;
// the search, the sort and the text of a cell that DmTable applies, the same for the screen and the exports.

// Vuetify's header, plus what search reads and an export prints.
export interface DmHeader<T> {
  title: string;
  key: string;
  sortable?: boolean;
  align?: 'start' | 'end' | 'center';
  width?: string | number;
  minWidth?: string | number;
  maxWidth?: string | number;
  nowrap?: boolean;
  // What the column sorts on (Vuetify's): a path or a function of the row; the row's `key` by default.
  value?: string | ((item: T) => unknown);
  sort?: (a: unknown, b: unknown) => number;
  sortRaw?: (a: T, b: T) => number;
  headerProps?: Record<string, unknown>;
  cellProps?: Record<string, unknown> | ((data: { item: T; index: number; value: unknown; column: unknown }) => Record<string, unknown>);
  // What search reads and an export prints; by default the row's `key`, as text. A status shown as an icon says its word here.
  text?: (item: T) => string;
  // false keeps a column out of the exports (the Actions column always is).
  export?: boolean;
}

// An item of a row's menu, or of the table's (its header's "⋮"). A destructive one has a color; a disabled one says why
// (`help`, its tooltip). Consecutive actions of one `group` go together, the group's name above them, a line between groups.
export interface DmAction { title: string; icon: string; color?: string; disabled?: boolean; help?: string; group?: string; run: () => void }

// The file's name (its view part), the PDF's title, and the PDF's lines for the filters in force.
export interface DmExport { name: string; title: string; filters?: string[] }

// A server table: the rows matching the search and filters, in all; `all` reads every one for an export, `limit` at most.
export interface DmServer<T> { total: number; all: (limit: number) => Promise<T[]> }

export interface DmSort { key: string; order?: 'asc' | 'desc' | boolean }

// A server table's options, sent to its view on each change (page, size, sort).
export interface DmOptions { page: number; itemsPerPage: number; sortBy: DmSort[] }

// The most rows an export of a server table reads (and so the most API pages it asks for).
export const EXPORT_LIMIT = 5000;

const at = (item: unknown, path: string): unknown => path.split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), item);

// A cell's text: the column's own, else its value as a string ('' for nothing).
export function cellText<T>(header: DmHeader<T>, item: T): string {
  if (header.text) return header.text(item);
  const value = (item as Record<string, unknown>)[header.key];
  return value == null ? '' : String(value);
}

// A text as search compares it: its accents removed (decomposed, the combining marks dropped), in lower case.
const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();

// The rows whose cells say the query (any column, case and accents aside, the whole query in one cell).
export function searchRows<T>(rows: T[], headers: DmHeader<T>[], query: string | null | undefined): T[] {
  const words = fold((query ?? '').trim());
  if (!words) return rows;
  return rows.filter((row) => headers.some((h) => fold(cellText(h, row)).includes(words)));
}

// The value a column sorts on (Vuetify's reading of a header).
function sortValue<T>(header: DmHeader<T> | undefined, key: string, item: T): unknown {
  if (typeof header?.value === 'function') return header.value(item);
  return at(item, typeof header?.value === 'string' ? header.value : key);
}

const empty = (v: unknown) => v === null || v === undefined || v === '';

// Sorted as Vuetify's data table sorts (a header's sort functions, then dates, then numbers, then words by the locale's
// collation, nothing first), stable: the rows on screen and in an export are in the same order.
export function sortRows<T>(rows: T[], headers: DmHeader<T>[], sortBy: DmSort[], locale = 'en-US'): T[] {
  const keys = sortBy.filter((s) => s.order !== false);
  if (!keys.length) return rows;
  const collator = new Intl.Collator(locale, { sensitivity: 'accent', usage: 'sort' });
  const byKey = new Map(headers.map((h) => [h.key, h]));
  return rows.map((row, index) => ({ row, index })).sort((x, y) => {
    for (const { key, order } of keys) {
      const header = byKey.get(key);
      const [a, b] = order === 'desc' ? [y.row, x.row] : [x.row, y.row];
      if (header?.sortRaw) {
        const r = header.sortRaw(a, b);
        if (r) return r;
        continue;
      }
      let va = sortValue(header, key, a);
      let vb = sortValue(header, key, b);
      if (header?.sort) {
        const r = header.sort(va, vb);
        if (r) return r;
        continue;
      }
      if (va instanceof Date && vb instanceof Date) [va, vb] = [va.getTime(), vb.getTime()];
      const [sa, sb] = [va, vb].map((v) => (v == null ? v : String(v).toLocaleLowerCase())) as (string | null | undefined)[];
      if (sa === sb) continue;
      if (empty(sa) && empty(sb)) continue;
      if (empty(sa)) return -1;
      if (empty(sb)) return 1;
      if (!Number.isNaN(Number(sa)) && !Number.isNaN(Number(sb))) return Number(sa) - Number(sb);
      const r = collator.compare(sa!, sb!);
      if (r) return r;
    }
    return x.index - y.index;
  }).map(({ row }) => row);
}
