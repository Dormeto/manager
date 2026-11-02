<script setup lang="ts">
// A workload of the calendars panel: its checkbox and color, its name and router, and its state (read only, being read, not
// read, a router too old).
import { mdiAlertCircleOutline, mdiLockOutline } from '@mdi/js';
import { NEEDS_ROUTER, type CalendarStatus, type PanelRow } from '../calendars';

defineProps<{ row: PanelRow; on: boolean; color: string; status?: CalendarStatus }>();
const emit = defineEmits<{ toggle: [] }>();
</script>

<template>
  <div :data-test="`calendar-${row.key}`" class="dm-row" role="listitem">
    <v-checkbox :model-value="on" :disabled="!row.supported && !on" density="compact" hide-details :aria-label="`Show ${row.name}`" @update:model-value="emit('toggle')">
      <template #label>
        <span class="dm-row__label">
          <span data-test="swatch" class="dm-row__swatch" :style="{ background: color, borderColor: on ? color : 'currentColor' }" />
          <span class="dm-row__name">
            <span class="dm-row__title">{{ row.name }}</span>
            <span class="dm-row__sub mono">{{ row.router }}<template v-if="row.name !== row.id"> · {{ row.id }}</template></span>
            <span v-if="!row.supported || status === 'unsupported'" data-test="needs-router" class="dm-row__sub">{{ NEEDS_ROUTER }}</span>
          </span>
        </span>
      </template>
    </v-checkbox>
    <v-icon v-if="row.locked" data-test="locked" :icon="mdiLockOutline" size="16" class="text-medium-emphasis" title="Read only: you may not wake or nap this workload" aria-label="Read only" />
    <v-progress-circular v-if="status === 'loading'" indeterminate size="14" width="2" aria-label="Reading its schedule" />
    <v-icon v-else-if="status === 'failed'" data-test="failed" :icon="mdiAlertCircleOutline" size="16" color="error" title="Its schedule could not be read: refresh to try again" aria-label="Could not be read" />
  </div>
</template>

<style scoped>
.dm-row { display: flex; align-items: center; gap: 6px; min-height: 48px; }
.dm-row > :first-child { flex: 1 1 auto; min-width: 0; }
.dm-row__label { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dm-row__swatch { flex: none; width: 12px; height: 12px; border-radius: 4px; border: 2px solid; }
.dm-row__name { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
.dm-row__title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dm-row__sub { font-size: 0.7rem; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
