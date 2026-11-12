<script setup lang="ts" generic="T extends object">
// The dashboard's tables (tables design §5): a toolbar (a view's filters, then the search), sort, pages of 25, 50, 100 or
// all rows, and an Actions column: each row's "⋮" opens its actions, the header's the table's (Export CSV, Export PDF, a
// view's own). An export takes the rows matching the search and filters, in the order shown, every page (a server table
// reads them through `server.all`, 5,000 at most), each column as its text, the Actions column left out.
//
// A client table is filtered, sorted and cut into pages here (then shown by Vuetify's server table, which does neither):
// the screen and the exports read the same rows in the same order. A server table (`server`) shows the page it is given
// and sends its options (page, size, sort) to the view, which also sends the search to its API.
import { computed, ref, useAttrs, watch } from 'vue';
import { useDisplay } from 'vuetify';
import { mdiFileDelimitedOutline, mdiFilePdfBox, mdiMagnify } from '@mdi/js';
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
  // The header's menu, after the exports.
  tableActions?: DmAction[];
  exported: DmExport;
  // The page's size at first: 25, 50, 100 or -1 (all).
  perPage?: number;
  noSearch?: boolean;
  server?: DmServer<T>;
  expandable?: boolean;
  selectable?: boolean;
}>(), { loading: false, actions: undefined, tableActions: () => [], perPage: 50, noSearch: false, server: undefined, expandable: false, selectable: false });

const emit = defineEmits<{ 'update:options': [options: DmOptions] }>();
const search = defineModel<string>('search', { default: '' });
const sortBy = defineModel<DmSort[]>('sortBy', { default: () => [] });
const page = defineModel<number>('page', { default: 1 });
const selected = defineModel<unknown[]>('selected', { default: () => [] });
const expanded = defineModel<string[]>('expanded', { default: () => [] });

// Vuetify's slots, a row's typed as the view's rows; and the toolbar (a view's filters, left of the search).
interface RowScope { item: T; index: number; internalItem: unknown; value: unknown; column: unknown; isSelected: (items: unknown) => boolean; toggleSelect: (item: unknown) => void; isExpanded: (item: unknown) => boolean; toggleExpand: (item: unknown) => void }
const slots = defineSlots<{
  toolbar?: () => unknown;
  loading?: () => unknown;
  'no-data'?: () => unknown;
  'expanded-row'?: (scope: RowScope & { columns: unknown[] }) => unknown;
  [slot: `item.${string}`]: ((scope: RowScope) => unknown) | undefined;
  // Vuetify's other slots (header.<key>, top, bottom…), passed through as they are.
  [slot: string]: ((scope: any) => unknown) | undefined;
}>();
const attrs = useAttrs();
const { smAndDown } = useDisplay();
const ACTIONS = 'dm-actions';
const OPTIONS = [{ value: 25, title: '25' }, { value: 50, title: '50' }, { value: 100, title: '100' }];

// The view's class and style on the root (its scoped styles reach the table through it); its other attributes (density,
// row-props, click:row…) on Vuetify's table.
const rootAttrs = computed(() => ({ class: attrs.class, style: attrs.style }));
const tableAttrs = computed(() => Object.fromEntries(Object.entries(attrs).filter(([k]) => k !== 'class' && k !== 'style')));

const itemsPerPage = ref(props.perPage);
const rows = computed(() => (props.server ? props.items : sortRows(searchRows(props.items, props.headers, search.value), props.headers, sortBy.value)));
const total = computed(() => (props.server ? props.server.total : rows.value.length));
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
const pageSizes = computed(() => (props.server ? OPTIONS : [...OPTIONS, { value: -1, title: 'All' }]));

// Vuetify's headers: the view's (without what is DmTable's), then the Actions column.
const columns = computed(() => [
  ...props.headers.map(({ text: _text, export: _export, ...header }) => header),
  { title: 'Actions', key: ACTIONS, sortable: false, align: 'end' as const, width: 56, cellProps: { class: 'dm-table__actions' } },
]);
// The view's slots go to Vuetify's table but the toolbar and the empty state (DmTable says when the search matches nothing).
// Read at each render, not cached: the slots object is not reactive, and a view's slot comes and goes (a loading slot given
// only before the first rows would otherwise stay, and Vuetify show it instead of the rows at each reload).
const forwarded = () => Object.keys(slots).filter((name) => name !== 'toolbar' && name !== 'no-data');
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
const noMatch = computed(() => !props.server && Boolean(searching.value) && props.items.length > 0 && rows.value.length === 0);
const mobile = computed(() => smAndDown.value);

// A row's name, for its "⋮" button: its first column's text.
const rowName = (item: T) => (props.headers[0] ? cellText(props.headers[0], item) : '');
const rowActions = (item: T) => props.actions?.(item) ?? [];

// The exports.
const busy = ref(false);
const failure = ref('');
const count = (n: number) => n.toLocaleString('en-US');
const exportable = computed(() => props.headers.filter((h) => h.export !== false));
async function exportRows(): Promise<{ list: T[]; note: string | null }> {
  if (!props.server) return { list: rows.value, note: null };
  const { total: matching, all: read } = props.server;
  const all = await read(EXPORT_LIMIT);
  const of = Math.max(matching, all.length);
  const note = of > EXPORT_LIMIT ? `The first ${count(EXPORT_LIMIT)} rows of ${count(of)}: narrow the search or the filters to export the others.` : null;
  return { list: all.slice(0, EXPORT_LIMIT), note };
}
async function exportAs(kind: 'csv' | 'pdf') {
  busy.value = true;
  failure.value = '';
  // What the export says is what was in force when it was asked, though a server table's rows take a while to read.
  const query = searching.value;
  const { name, title, filters = [] } = props.exported;
  const kept = exportable.value;
  try {
    const { list, note } = await exportRows();
    const titles = kept.map((h) => h.title);
    const cells = list.map((item) => kept.map((h) => cellText(h, item)));
    if (kind === 'csv') {
      // The cut said on a last line, the other cells empty (each line has every column).
      const lines = note ? [...cells, [note, ...titles.slice(1).map(() => '')]] : cells;
      download(fileName(name, 'csv'), 'text/csv;charset=utf-8', csv(titles, lines));
      return;
    }
    const when = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
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
  <div class="dm-table" v-bind="rootAttrs">
    <div v-if="!noSearch || slots.toolbar || mobile" class="dm-table__toolbar">
      <div class="dm-table__tools"><slot name="toolbar" /></div>
      <!-- Cleared, the search is empty text, never null (a server table's view sends it to its API). -->
      <v-text-field v-if="!noSearch" :model-value="search" data-test="dm-table-search" :prepend-inner-icon="mdiMagnify" label="Search" density="compact" hide-details single-line clearable
        class="dm-table__search" @update:model-value="search = $event ?? ''" />
      <!-- A phone's table has no header row: its menu is here. -->
      <DmActionsMenu v-if="mobile" :lead="exports" :actions="tableActions" :busy="busy" label="Table actions" test="dm-table-menu" />
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
        <DmActionsMenu v-if="!mobile" :lead="exports" :actions="tableActions" :busy="busy" label="Table actions" test="dm-table-menu" />
      </template>
      <template #[`item.${ACTIONS}`]="{ item }">
        <DmActionsMenu v-if="rowActions(item as T).length" :actions="rowActions(item as T)" :label="`Actions for ${rowName(item as T)}`" test="dm-row-menu" />
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
.dm-table__calm { display: flex; align-items: center; justify-content: center; gap: 14px; padding: 28px 16px; }
/* The loading and empty rows as tall as their content; the footer under a line. */
.dm-table :deep(.v-data-table-rows-loading > td), .dm-table :deep(.v-data-table-rows-no-data > td) { height: auto !important; }
.dm-table :deep(.v-data-table-footer) { padding-inline: 12px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
/* One column on a phone: the labels narrow, the values wide. */
.dm-table :deep(.v-data-table__tr--mobile > td) { grid-template-columns: auto minmax(0, 1fr); column-gap: 16px; }
.dm-table :deep(.v-data-table__tr--mobile .v-data-table__td-value) { min-width: 0; }
/* A phone's row without actions: no empty Actions line. */
.dm-table :deep(.v-data-table__tr--mobile > td.dm-table__actions:has(> .v-data-table__td-value:empty)) { display: none; }
@media (max-width: 600px) {
  .dm-table__toolbar { padding: 10px 12px; gap: 8px; }
  .dm-table__search { flex: 1 1 0; min-width: 0; }
}
</style>
