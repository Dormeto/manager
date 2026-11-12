<script setup lang="ts" generic="T extends object">
// The dashboard's tables (tables design §5): a toolbar (a view's filters, then the search), sort, pages of 25, 50, 100 or
// all rows, and an Actions column: each row's "⋮" opens its actions, the header's the table's (Export CSV, Export PDF, a
// view's own). An export takes the rows matching the search and filters, in the order shown, every page (a server table
// reads them through `server.all`, 5,000 at most), each column as its text, the Actions column left out.
//
// A client table is filtered, sorted and cut into pages here (then shown by Vuetify's server table, which does neither):
// the screen and the exports read the same rows in the same order. A server table (`server`) shows the page it is given
// and sends its options (page, size, sort) to the view, which also sends the search to its API.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useAttrs, useId, watch } from 'vue';
import { useDisplay } from 'vuetify';
import { mdiChevronDown, mdiChevronUp, mdiFileDelimitedOutline, mdiFilePdfBox, mdiMagnify } from '@mdi/js';
import { cellText, EXPORT_LIMIT, searchRows, sortRows, type DmAction, type DmExport, type DmHeader, type DmOptions, type DmServer, type DmSort } from '../table';
import { csv, download, fileName, pdf } from '../table-export';
import DmActionsMenu, { type MenuAction } from './DmActionsMenu.vue';
import DmLogo from './DmLogo.vue';

defineOptions({ inheritAttrs: false });

const props = withDefaults(defineProps<{
  headers: DmHeader<T>[];
  items: T[];
  itemValue: string | ((item: T) => unknown);
  loading?: boolean;
  // A row's menu: none shows no button.
  actions?: (item: T) => DmAction[];
  // A row's name, for its "⋮" (`Actions for <name>`): its first column's text by default.
  rowName?: (item: T) => string;
  // The header's menu, after the exports.
  tableActions?: DmAction[];
  exported: DmExport;
  // The page's size at first: 25, 50, 100 or -1 (all).
  perPage?: number;
  noSearch?: boolean;
  server?: DmServer<T>;
  // Each row's toggle opens its part under it (the `expanded-row` slot); `expandTitle` says what it opens: the toggles'
  // column and each toggle's name (`<title> of <row's name>`).
  expandable?: boolean;
  expandTitle?: string;
  selectable?: boolean;
}>(), { loading: false, actions: undefined, rowName: undefined, tableActions: () => [], perPage: 50, noSearch: false, server: undefined, expandable: false, expandTitle: 'Details', selectable: false });

const emit = defineEmits<{ 'update:options': [options: DmOptions] }>();
const search = defineModel<string>('search', { default: '' });
const sortBy = defineModel<DmSort[]>('sortBy', { default: () => [] });
const page = defineModel<number>('page', { default: 1 });
const selected = defineModel<unknown[]>('selected', { default: () => [] });
const expanded = defineModel<string[]>('expanded', { default: () => [] });

// Vuetify's slots, a row's typed as the view's rows; and the toolbar (a view's filters, left of the search).
interface RowScope { item: T; index: number; internalItem: unknown; value: unknown; column: unknown; isSelected: (items: unknown) => boolean; toggleSelect: (item: unknown) => void; isExpanded: (item: unknown) => boolean; toggleExpand: (item: unknown) => void }
// The part under a row (Vuetify's expanded-row scope, its row's toggles taken as they are).
interface ExpandedScope { item: T; index: number; internalItem: unknown; columns: unknown[]; isExpanded: (item: never) => boolean; toggleExpand: (item: never) => void }
const slots = defineSlots<{
  toolbar?: () => unknown;
  loading?: () => unknown;
  'no-data'?: () => unknown;
  // `expandedId`: the id its part takes, which the row's toggle names (aria-controls).
  'expanded-row'?: (scope: ExpandedScope & { expandedId: string }) => unknown;
  [slot: `item.${string}`]: ((scope: RowScope) => unknown) | undefined;
  // Vuetify's other slots (header.<key>, top, bottom…), passed through as they are.
  [slot: string]: ((scope: any) => unknown) | undefined;
}>();
const attrs = useAttrs();
const { smAndDown } = useDisplay();
const ACTIONS = 'dm-actions';
// Vuetify's key for the toggles' column: given here, it is not added after the Actions column.
const EXPAND = 'data-table-expand';
const OPTIONS = [{ value: 25, title: '25' }, { value: 50, title: '50' }, { value: 100, title: '100' }];

// The view's class and style on the root (its scoped styles reach the table through it); its other attributes (density,
// row-props, click:row…) on Vuetify's table.
const rootAttrs = computed(() => ({ class: attrs.class, style: attrs.style }));
const tableAttrs = computed(() => Object.fromEntries(Object.entries(attrs).filter(([k]) => k !== 'class' && k !== 'style')));

const itemsPerPage = ref(props.perPage);
const rows = computed(() => (props.server ? props.items : sortRows(searchRows(props.items, props.headers, search.value), props.headers, sortBy.value)));
// A server table's total not known: its page's (the view pages it, in its own footer).
const total = computed(() => (props.server ? props.server.total ?? props.items.length : rows.value.length));
const shown = computed(() => {
  if (props.server || itemsPerPage.value === -1) return rows.value;
  const start = (page.value - 1) * itemsPerPage.value;
  return rows.value.slice(start, start + itemsPerPage.value);
});
// A client table goes back to its first page on a new search, and to its last when the rows no longer reach the page.
watch(search, () => { if (!props.server) page.value = 1; });
watch([total, itemsPerPage], () => {
  if (props.server || itemsPerPage.value === -1) return;
  const last = Math.max(1, Math.ceil(total.value / itemsPerPage.value));
  if (page.value > last) page.value = last;
});
// The footer while the rows go beyond a page (the one chosen, or the first size, so a larger size can be undone).
const size = (n: number) => (n === -1 ? Infinity : n);
const footer = computed(() => total.value > Math.min(size(itemsPerPage.value), size(props.perPage)));
// "All" for a client table of 1,000 rows at most: more, drawn at once, would freeze the page.
const ALL_MOST = 1000;
const pageSizes = computed(() => (props.server || rows.value.length > ALL_MOST ? OPTIONS : [...OPTIONS, { value: -1, title: 'All' }]));

// Vuetify's headers: the view's (without what is DmTable's), the toggles of an expandable table, then the Actions column.
const columns = computed(() => [
  ...props.headers.map(({ text: _text, export: _export, exportTitle: _exportTitle, ...header }) => header),
  ...(props.expandable ? [{ title: props.expandTitle, key: EXPAND, sortable: false, width: 48, cellProps: { class: 'dm-table__expand' } }] : []),
  { title: 'Actions', key: ACTIONS, sortable: false, align: 'end' as const, width: 56, headerProps: { class: 'dm-table__actions' }, cellProps: { class: 'dm-table__actions' } },
]);

// A table wider than its card scrolls sideways: its Actions column then stays in view at the end (the view's columns wrap
// or cut first, so that most tables never scroll).
const root = ref<HTMLElement | null>(null);
const wide = ref(false);
// Kept in view only when a row has an action there (a table whose rows have none scrolls it with the others).
const rowsAct = computed(() => props.items.some((item) => rowActions(item).length > 0));
const scrolls = computed(() => wide.value && rowsAct.value);
// The table's "⋮" in the toolbar: a phone's (no header row), and a table scrolling with no row's action, whose header would
// take it out of view. Its header then narrower by the "⋮" (28 px and its padding beyond the column's 56 px), the table
// stays said to scroll until it fits with this much to spare, so that the "⋮" never goes back and forth.
const MENU_SLACK = 24;
const menuInToolbar = computed(() => mobile.value || (wide.value && !rowsAct.value));
let observer: ResizeObserver | undefined;
let check: (() => void) | undefined;
onMounted(() => {
  const wrapper = root.value?.querySelector<HTMLElement>('.v-table__wrapper');
  if (!wrapper) return;
  check = () => { wide.value = wrapper.scrollWidth > wrapper.clientWidth + 1 - (wide.value && !rowsAct.value ? MENU_SLACK : 0); };
  observer = new ResizeObserver(check);
  observer.observe(wrapper);
  const table = wrapper.querySelector('table');
  if (table) observer.observe(table);
  check();
});
onBeforeUnmount(() => observer?.disconnect());
// The view's slots go to Vuetify's table but the toolbar and the empty state (DmTable says when the search matches nothing).
// Read at each render, not cached: the slots object is not reactive, and a view's slot comes and goes (a loading slot given
// only before the first rows would otherwise stay, and Vuetify show it instead of the rows at each reload).
const forwarded = () => Object.keys(slots).filter((name) => name !== 'toolbar' && name !== 'no-data' && name !== 'expanded-row');
// A column with a text and no cell of the view's shows its text.
const textCells = () => props.headers.filter((h) => h.text && !slots[`item.${h.key}`]);
// In development, a column with a cell of its own but no text, its rows without its field: search and the exports would
// read nothing there.
if (import.meta.env.DEV) {
  const warned = new Set<string>();
  watch(() => props.items[0], (row) => {
    if (!row) return;
    for (const h of props.headers) {
      if (h.export === false || h.text || !slots[`item.${h.key}`] || h.key in row || warned.has(h.key)) continue;
      warned.add(h.key);
      console.warn(`DmTable: the column "${h.title}" (${h.key}) has a cell of its own but no text, and its rows no field ${h.key}: search and the exports read nothing there; give it text(item).`);
    }
  }, { immediate: true });
}
const searching = computed(() => (search.value ?? '').trim());
// The table named in its search's name ("Search routers", "Search IP lists"): two tables on a page told apart.
const named = computed(() => { const t = props.exported.title; return /^[A-Z][a-z]/.test(t) ? `${t.charAt(0).toLowerCase()}${t.slice(1)}` : t; });
const noMatch = computed(() => !props.server && Boolean(searching.value) && props.items.length > 0 && rows.value.length === 0);
const mobile = computed(() => smAndDown.value);

// A row's name, for its "⋮" button and its toggle: the view's, else its first column's text.
const nameOf = (item: T) => props.rowName?.(item) ?? (props.headers[0] ? cellText(props.headers[0], item) : '');
const rowActions = (item: T) => props.actions?.(item) ?? [];
// Rows with actions or none: the table's width is read again, with the slack or without.
watch(rowsAct, () => check?.());
// A row's value (its item-value), and the id of its part under it: this table's, then the row's value.
const valueOf = (item: T): unknown => (typeof props.itemValue === 'function' ? props.itemValue(item) : (item as Record<string, unknown>)[props.itemValue]);
const tableId = useId();
const expandedId = (item: T) => `${tableId}-expanded-${String(valueOf(item))}`;

// A row brought into view (a link naming it): the page holding it in the sort shown, the search cleared if it hides the
// row. A client table only (a server table's view pages it); false when the table does not hold it.
async function reveal(value: unknown): Promise<boolean> {
  if (props.server) return false;
  // Rows just given: Vuetify's table counts them first (it holds a page beyond its count to the last it knows).
  await nextTick();
  const at = (list: T[]) => list.findIndex((item) => valueOf(item) === value);
  if (at(rows.value) < 0) {
    if (!props.items.some((item) => valueOf(item) === value)) return false;
    search.value = '';
    // The search's watcher goes back to the first page: the row's page after it.
    await nextTick();
  }
  const index = at(rows.value);
  if (index < 0) return false;
  if (itemsPerPage.value !== -1) page.value = Math.floor(index / itemsPerPage.value) + 1;
  return true;
}
defineExpose({ reveal });

// The exports.
const busy = ref(false);
const failure = ref('');
const count = (n: number) => n.toLocaleString('en-US');
const exportable = computed(() => props.headers.filter((h) => h.export !== false));
// A client table's rows, with the view's note when they are a part of a list; a server table's, read through `all`, and
// the line saying they were cut (at the limit, or where the view's reading stopped).
async function exportRows(viewNote: string | null): Promise<{ list: T[]; note: string | null }> {
  if (!props.server) return { list: rows.value, note: viewNote };
  const server = props.server;
  const matching = server.total;
  // Without a total, one row more than the limit tells there are others. Called as the server's method: a view's object
  // may read its own fields.
  const answer = await server.all(matching === null ? EXPORT_LIMIT + 1 : EXPORT_LIMIT);
  const [all, stopped] = Array.isArray(answer) ? [answer, null] : [answer.rows, answer.note];
  const of = matching === null ? null : Math.max(matching, all.length);
  const rest = 'narrow the search or the filters to export the others.';
  const cut = (of ?? all.length) <= EXPORT_LIMIT ? null : of === null ? `The first ${count(EXPORT_LIMIT)} rows: ${rest}` : `The first ${count(EXPORT_LIMIT)} rows of ${count(of)}: ${rest}`;
  return { list: all.slice(0, EXPORT_LIMIT), note: stopped ?? cut };
}
async function exportAs(kind: 'csv' | 'pdf') {
  busy.value = true;
  failure.value = '';
  // What the export says is what was in force when it was asked, though a server table's rows take a while to read.
  const query = searching.value;
  const { name, title, filters = [], note: viewNote = null } = props.exported;
  const kept = exportable.value;
  try {
    const { list, note } = await exportRows(viewNote);
    const titles = kept.map((h) => h.exportTitle ?? h.title);
    const cells = list.map((item) => kept.map((h) => cellText(h, item)));
    if (kind === 'csv') {
      // The cut said on a last line, the other cells empty (each line has every column).
      const lines = note ? [...cells, [note, ...titles.slice(1).map(() => '')]] : cells;
      download(fileName(name, 'csv'), 'text/csv;charset=utf-8', csv(titles, lines));
      return;
    }
    const when = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    const lines = [
      `Exported ${when} · ${count(list.length)} row${list.length === 1 ? '' : 's'}`,
      ...(query ? [`Search: “${query}”`] : []),
      ...filters,
      ...(note ? [note] : []),
    ];
    download(fileName(name, 'pdf'), 'application/pdf', await pdf({ title, lines, headers: titles, rows: cells }));
  } catch (err) {
    failure.value = `The export failed: ${(err as Error).message}`;
  } finally {
    busy.value = false;
  }
}
const exports = computed<MenuAction[]>(() => [
  { title: 'Export CSV', icon: mdiFileDelimitedOutline, test: 'dm-table-export-csv', disabled: busy.value, run: () => void exportAs('csv') },
  { title: 'Export PDF', icon: mdiFilePdfBox, test: 'dm-table-export-pdf', disabled: busy.value, run: () => void exportAs('pdf') },
]);

function options(o: DmOptions) {
  if (props.server) emit('update:options', { page: o.page, itemsPerPage: o.itemsPerPage, sortBy: o.sortBy });
}
</script>

<template>
  <div ref="root" class="dm-table" :class="{ 'dm-table--scrolls': scrolls }" v-bind="rootAttrs">
    <div v-if="!noSearch || slots.toolbar || menuInToolbar" class="dm-table__toolbar">
      <div class="dm-table__tools"><slot name="toolbar" /></div>
      <!-- Cleared, the search is empty text, never null (a server table's view sends it to its API). -->
      <v-text-field v-if="!noSearch" :model-value="search" data-test="dm-table-search" :prepend-inner-icon="mdiMagnify" label="Search" :aria-label="`Search ${named}`" density="compact" hide-details single-line clearable
        class="dm-table__search" @update:model-value="search = $event ?? ''" />
      <!-- A phone's table has no header row, and a table scrolling with no row's action would scroll its header's: its menu is
           here, at the toolbar's end. -->
      <div v-if="menuInToolbar" class="dm-table__menu"><DmActionsMenu :lead="exports" :actions="tableActions" :busy="busy" :label="`Table actions: ${exported.title}`" test="dm-table-menu" /></div>
    </div>
    <v-alert v-if="failure" type="error" variant="tonal" density="compact" closable class="ma-3" :text="failure" @click:close="failure = ''" />
    <v-data-table-server v-model="selected" v-model:page="page" v-model:items-per-page="itemsPerPage" v-model:sort-by="sortBy" v-model:expanded="expanded"
      :headers="columns" :items="shown" :items-length="total" :item-value="itemValue" :loading="loading" :mobile="mobile" :items-per-page-options="pageSizes"
      :hide-default-footer="!footer" :show-select="selectable" :show-expand="expandable" v-bind="tableAttrs" @update:options="options">
      <template v-for="name in forwarded()" :key="name" #[name]="scope"><slot :name="name" v-bind="scope ?? {}" /></template>
      <template v-for="h in textCells()" :key="h.key" #[`item.${h.key}`]="{ item }">{{ cellText(h, item as T) }}</template>
      <!-- The column's name for screen readers (and a phone's cells, which show it); the "⋮" on a wide screen. -->
      <template #[`header.${ACTIONS}`]>
        <span :class="{ 'd-sr-only': !mobile }">Actions</span>
        <DmActionsMenu v-if="!menuInToolbar" :lead="exports" :actions="tableActions" :busy="busy" :label="`Table actions: ${exported.title}`" test="dm-table-menu" />
      </template>
      <!-- An expandable table's toggles, named by what they open and the row (a phone's says its title). -->
      <template v-if="expandable" #[`header.${EXPAND}`]><span :class="{ 'd-sr-only': !mobile }">{{ expandTitle }}</span></template>
      <template v-if="expandable && !slots[`item.${EXPAND}`]" #[`item.${EXPAND}`]="{ item, internalItem, isExpanded, toggleExpand }">
        <v-btn data-test="dm-row-expand" variant="text" size="small" :icon="mobile ? undefined : isExpanded(internalItem) ? mdiChevronUp : mdiChevronDown"
          :append-icon="mobile ? (isExpanded(internalItem) ? mdiChevronUp : mdiChevronDown) : undefined" :text="mobile ? expandTitle : undefined"
          :aria-label="`${expandTitle} of ${nameOf(item as T)}`" :aria-expanded="isExpanded(internalItem)" :aria-controls="expandedId(item as T)" @click.stop="toggleExpand(internalItem)" />
      </template>
      <template v-if="slots['expanded-row']" #expanded-row="scope"><slot name="expanded-row" v-bind="{ ...scope, expandedId: expandedId(scope.item as T) }" /></template>
      <template #[`item.${ACTIONS}`]="{ item }">
        <DmActionsMenu v-if="rowActions(item as T).length" :actions="rowActions(item as T)" :label="`Actions for ${nameOf(item as T)}`" test="dm-row-menu" />
      </template>
      <template #no-data>
        <div v-if="noMatch" class="dm-table__calm"><DmLogo state="sleep" :size="40" /><span class="text-medium-emphasis">No row matches “{{ searching }}”.</span></div>
        <slot v-else-if="slots['no-data']" name="no-data" />
        <div v-else class="dm-table__calm"><DmLogo state="sleep" :size="40" /><span class="text-medium-emphasis">Nothing here yet.</span></div>
      </template>
    </v-data-table-server>
  </div>
</template>

<style scoped>
/* The toolbar: a view's filters, then the search (and on a phone the table's "⋮"). */
.dm-table__toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; padding: 12px 16px; border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.dm-table__tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; flex: 1 1 auto; min-width: 0; }
.dm-table__tools:empty { display: none; }
.dm-table__search { flex: 0 1 280px; min-width: 200px; margin-inline-start: auto; }
/* The table's "⋮" at the toolbar's end, also without a search or filters. */
.dm-table__menu { display: flex; }
.dm-table__tools:empty + .dm-table__menu { margin-inline-start: auto; }
.dm-table__calm { display: flex; align-items: center; justify-content: center; gap: 14px; padding: 28px 16px; }
/* The loading and empty rows as tall as their content; the footer under a line. */
.dm-table :deep(.v-data-table-rows-loading > td), .dm-table :deep(.v-data-table-rows-no-data > td) { height: auto !important; }
.dm-table :deep(.v-data-table-footer) { padding-inline: 12px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
/* A table that scrolls sideways: its Actions column stays at the end, over the columns passing under it. */
.dm-table--scrolls :deep(.v-table__wrapper > table > * > tr:not(.v-data-table__tr--mobile) > .dm-table__actions) {
  position: sticky; inset-inline-end: 0; z-index: 2; background: rgb(var(--v-theme-surface)); box-shadow: -10px 0 12px -12px rgba(0, 0, 0, 0.45); }
.v-theme--dark .dm-table--scrolls :deep(.v-table__wrapper > table > * > tr:not(.v-data-table__tr--mobile) > .dm-table__actions) {
  background: color-mix(in srgb, rgb(var(--v-theme-background)) 95%, white); box-shadow: -10px 0 12px -12px rgba(0, 0, 0, 0.9); }
/* One column on a phone: the labels narrow, the values wide. */
.dm-table :deep(.v-data-table__tr--mobile > td) { grid-template-columns: auto minmax(0, 1fr); column-gap: 16px; }
.dm-table :deep(.v-data-table__tr--mobile .v-data-table__td-value) { min-width: 0; }
/* A phone's row without actions: no empty Actions line, and the line under the row (Vuetify's, on its last cell) under the
   cell before it. */
.dm-table :deep(.v-data-table__tr--mobile > td.dm-table__actions:has(> .v-data-table__td-value:empty)) { display: none; }
.dm-table :deep(.v-data-table__tr--mobile:not(:last-child):has(> td.dm-table__actions > .v-data-table__td-value:empty) > td:nth-last-child(2)) { border-bottom: thin solid rgba(var(--v-border-color), var(--v-border-opacity)); }
@media (max-width: 600px) {
  .dm-table__toolbar { padding: 10px 12px; gap: 8px; }
  /* A view's filters on their line, the search and the table's "⋮" on the next (the search not squeezed to its icon). */
  .dm-table__tools { flex: 1 1 100%; }
  .dm-table__search { flex: 1 1 0; min-width: 0; }
}
</style>
