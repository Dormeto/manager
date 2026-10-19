<script setup lang="ts">
// The Schedules view's calendars: the workloads the user may read, searched by name, id or router, with "Scheduled only"
// on by default; a checkbox enables a calendar (the view enforces the limit), and an enabled one shows its color.
import { computed, ref } from 'vue';
import { mdiAlertCircleOutline, mdiLockOutline, mdiMagnify } from '@mdi/js';
import { MAX_CALENDARS, NEEDS_ROUTER, colorFor, type CalendarStatus, type PanelRow } from '../calendars';

const props = defineProps<{ rows: PanelRow[]; enabled: Record<string, number>; status: Record<string, CalendarStatus>; message?: string; loading?: boolean; error?: string }>();
const emit = defineEmits<{ toggle: [key: string] }>();
const search = ref('');
// A refused checkbox is already ticked on screen (its value is the view's): the list is drawn again.
const redraw = ref(0);
const scheduledOnly = ref(true);
// Workloads of a router before 0.31.0 stay listed (disabled): whether they have a schedule is not known.
const shown = computed(() => {
  const q = search.value.trim().toLowerCase();
  return props.rows.filter((r) => (!q || `${r.name} ${r.id} ${r.router} ${r.router}/${r.id}`.toLowerCase().includes(q)) && (!scheduledOnly.value || r.scheduled || !r.supported || r.key in props.enabled));
});
const count = computed(() => Object.keys(props.enabled).length);
function toggle(r: PanelRow) {
  if (!(r.key in props.enabled) && count.value >= MAX_CALENDARS) redraw.value++;
  emit('toggle', r.key);
}
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
    <div v-else-if="!shown.length" class="text-medium-emphasis py-4">{{ scheduledOnly && !search.trim() ? 'No workload has a schedule yet: turn off "Scheduled only" to choose one.' : 'No workload matches.' }}</div>
    <ul :key="redraw" class="dm-panel__list">
      <li v-for="r in shown" :key="r.key" :data-test="`calendar-${r.key}`" class="dm-panel__row">
        <v-checkbox :model-value="r.key in enabled" :disabled="!r.supported && !(r.key in enabled)" density="compact" hide-details :aria-label="`Show ${r.name}`" @update:model-value="toggle(r)">
          <template #label>
            <span class="dm-panel__label">
              <span data-test="swatch" class="dm-panel__swatch" :style="{ background: swatch(r.key), borderColor: r.key in enabled ? swatch(r.key) : 'currentColor' }" />
              <span class="dm-panel__name">
                <span class="dm-panel__title">{{ r.name }}</span>
                <span class="dm-panel__sub mono">{{ r.router }}<template v-if="r.name !== r.id"> · {{ r.id }}</template></span>
                <span v-if="!r.supported || status[r.key] === 'unsupported'" data-test="needs-router" class="dm-panel__sub">{{ NEEDS_ROUTER }}</span>
              </span>
            </span>
          </template>
        </v-checkbox>
        <v-icon v-if="r.locked" data-test="locked" :icon="mdiLockOutline" size="16" class="text-medium-emphasis" title="Read only: you may not wake or nap this workload" aria-label="Read only" />
        <v-progress-circular v-if="status[r.key] === 'loading'" indeterminate size="14" width="2" aria-label="Reading its schedule" />
        <v-icon v-else-if="status[r.key] === 'failed'" data-test="failed" :icon="mdiAlertCircleOutline" size="16" color="error" title="Its schedule could not be read: refresh to try again" aria-label="Could not be read" />
      </li>
    </ul>
  </div>
</template>

<style scoped>
.dm-panel__list { list-style: none; padding: 0; margin: 8px 0 0; }
.dm-panel__row { display: flex; align-items: center; gap: 6px; }
.dm-panel__row > :first-child { flex: 1 1 auto; min-width: 0; }
.dm-panel__label { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dm-panel__swatch { flex: none; width: 12px; height: 12px; border-radius: 4px; border: 2px solid; }
.dm-panel__name { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
.dm-panel__title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
.dm-panel__sub { font-size: 0.7rem; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); overflow: hidden; text-overflow: ellipsis; }
</style>
