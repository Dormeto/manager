<script setup lang="ts">
// The Schedules view's calendars: the workloads the user may read, searched by name, id or router, with "Scheduled only"
// on by default; a checkbox enables a calendar (the view enforces the limit), and an enabled one shows its color. An organization
// can have 1,000 workloads (the user, 2026-11-02): the list draws the rows in sight only, sorted once, and fills the panel.
import { computed, ref } from 'vue';
import { mdiMagnify } from '@mdi/js';
import { MAX_CALENDARS, colorFor, naturalCompare, type CalendarStatus, type PanelRow } from '../calendars';
import CalendarRow from './CalendarRow.vue';

const props = defineProps<{ rows: PanelRow[]; enabled: Record<string, number>; status: Record<string, CalendarStatus>; message?: string; loading?: boolean; error?: string }>();
const emit = defineEmits<{ toggle: [key: string] }>();
const search = ref('');
// A refused checkbox is already ticked on screen (its value is the view's): its row is drawn again, the list stays where it is.
const redraw = ref<{ key: string; n: number }>({ key: '', n: 0 });
const scheduledOnly = ref(true);
// In name order once per list, each with what a search reads.
const sorted = computed(() => [...props.rows].sort((a, b) => naturalCompare(a.name, b.name)).map((r) => ({ row: r, text: `${r.name} ${r.id} ${r.router} ${r.router}/${r.id}`.toLowerCase() })));
// Workloads of a router before 0.31.0 stay listed (disabled): whether they have a schedule is not known.
const shown = computed(() => {
  const q = search.value?.trim().toLowerCase() ?? '';
  return sorted.value.filter(({ row: r, text }) => (!q || text.includes(q)) && (!scheduledOnly.value || r.scheduled || !r.supported || r.key in props.enabled)).map(({ row }) => row);
});
const count = computed(() => Object.keys(props.enabled).length);
function toggle(r: PanelRow) {
  if (!(r.key in props.enabled) && count.value >= MAX_CALENDARS) redraw.value = { key: r.key, n: redraw.value.n + 1 };
  emit('toggle', r.key);
}
// A list this long draws the rows in sight only; a shorter one draws them all.
const VIRTUAL_FROM = 100;
const rowKey = (r: PanelRow) => (redraw.value.key === r.key ? `${r.key}#${redraw.value.n}` : r.key);
const swatch = (key: string) => (key in props.enabled ? colorFor(props.enabled[key]!) : 'transparent');
</script>

<template>
  <div class="dm-panel">
    <div class="dm-eyebrow mb-2">Calendars · <span data-test="enabled-count">{{ count }}</span> of {{ MAX_CALENDARS }}</div>
    <v-text-field v-model="search" data-test="panel-search" :prepend-inner-icon="mdiMagnify" label="Search" density="compact" hide-details single-line clearable class="mb-1" />
    <v-switch v-model="scheduledOnly" data-test="scheduled-only" label="Scheduled only" color="primary" density="compact" hide-details />
    <v-alert v-if="message" data-test="limit-message" type="warning" variant="tonal" density="compact" class="my-2" :text="message" />
    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="my-2" :text="error" />
    <div v-if="loading && !rows.length" class="text-medium-emphasis py-4">Reading the workloads…</div>
    <div v-else-if="!shown.length" class="text-medium-emphasis py-4">{{ scheduledOnly && !search?.trim() ? 'No workload has a schedule yet: turn off "Scheduled only" to choose one.' : 'No workload matches.' }}</div>
    <v-virtual-scroll v-if="shown.length > VIRTUAL_FROM" :items="shown" item-key="key" :item-height="48" height="100%" class="dm-panel__list" role="list">
      <template #default="{ item }">
        <CalendarRow :key="rowKey(item)" :row="item" :on="item.key in enabled" :color="swatch(item.key)" :status="status[item.key]" @toggle="toggle(item)" />
      </template>
    </v-virtual-scroll>
    <div v-else class="dm-panel__list dm-panel__list--plain" role="list">
      <CalendarRow v-for="r in shown" :key="rowKey(r)" :row="r" :on="r.key in enabled" :color="swatch(r.key)" :status="status[r.key]" @toggle="toggle(r)" />
    </div>
  </div>
</template>

<style scoped>
.dm-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; }
/* Only the list takes the panel's height: a field or a switch keeps its own. */
.dm-panel > :not(.dm-panel__list) { flex: 0 0 auto; }
.dm-panel__list { flex: 1 1 0; min-height: 120px; margin: 8px -4px 0 0; padding-right: 4px; }
.dm-panel__list--plain { overflow-y: auto; }
</style>
