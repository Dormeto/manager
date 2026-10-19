<script setup lang="ts">
// A workload's schedule (R12): weekly awake and nap windows in the schedule's time zone, the exceptions, the maximum nap
// and the next events. Edited with the wake and nap permissions (both).
import { computed, ref } from 'vue';
import { mdiCalendarClock, mdiPencilOutline } from '@mdi/js';
import { daysText, eventText, hoursText, type NextEvent, type Schedule } from '../schedule';
import { relative } from '../format';

// schedule: undefined when the router does not report schedules (before 0.31.0), null when it has none.
const props = defineProps<{ schedule: Schedule | null | undefined; next?: NextEvent[]; maintenanceDue?: string | null; canEdit: boolean }>();
const emit = defineEmits<{ edit: []; clear: [] }>();
const confirm = ref(false);
const zone = computed(() => props.schedule?.timeZone ?? '');
const wakeText = (w: Schedule['windows'][number]) => (w.kind === 'nap' ? (w.wake === 'header' ? 'wakes with the header' : 'no wake') : '');
</script>

<template>
  <v-card data-test="schedule-card" title="Schedule">
    <template #prepend><v-avatar color="primary" variant="tonal" rounded="lg" size="34"><v-icon :icon="mdiCalendarClock" size="18" /></v-avatar></template>
    <template v-if="schedule !== undefined && canEdit" #append>
      <v-btn data-test="edit-schedule" :prepend-icon="mdiPencilOutline" variant="text" size="small" @click="emit('edit')">{{ schedule ? 'Edit' : 'Add' }}</v-btn>
      <v-btn v-if="schedule" data-test="clear-schedule" variant="text" size="small" color="error" @click="confirm = true">Clear</v-btn>
    </template>
    <v-card-text v-if="schedule === undefined" class="text-medium-emphasis">Schedules need router 0.31.0 or later.</v-card-text>
    <v-card-text v-else-if="!schedule" class="text-medium-emphasis">No schedule: the workload naps when idle and wakes on requests, at any hour.</v-card-text>
    <template v-else>
      <v-card-text class="pb-0">
        <div v-if="schedule.windows.length" class="text-body-medium mb-2">Time zone <strong>{{ zone }}</strong></div>
        <div v-for="(w, i) in schedule.windows" :key="i" data-test="window" class="d-flex flex-wrap align-center ga-2 py-1 text-body-medium">
          <v-chip :color="w.kind === 'awake' ? 'success' : 'info'" variant="tonal" label size="small">{{ w.kind === 'awake' ? 'Awake' : 'Nap' }}</v-chip>
          <span>{{ daysText(w.days) }}</span>
          <span class="dm-num">{{ hoursText(w) }}</span>
          <span v-if="wakeText(w)" class="text-medium-emphasis">{{ wakeText(w) }}</span>
        </div>
        <div v-if="schedule.exceptions?.length" class="text-body-medium mt-2"><span class="text-medium-emphasis">No window on</span> {{ schedule.exceptions.join(', ') }}</div>
        <div v-if="schedule.maxNapDays" class="text-body-medium mt-2">
          <span class="text-medium-emphasis">Maximum nap</span> {{ schedule.maxNapDays }} days<template v-if="maintenanceDue">, <span class="text-medium-emphasis">maintenance wake due</span> {{ relative(maintenanceDue, Date.now()) }}</template>
        </div>
      </v-card-text>
      <v-card-text v-if="next?.length && zone">
        <div class="dm-subhead mb-1">Next events</div>
        <div v-for="e in next" :key="`${e.at}-${e.kind}`" data-test="next" class="text-body-medium py-1">{{ eventText(e, zone) }}</div>
      </v-card-text>
      <v-card-text v-if="schedule.by" class="pt-0 text-body-small text-medium-emphasis">Set by {{ schedule.by }}{{ schedule.at ? ` ${relative(schedule.at, Date.now())}` : '' }}</v-card-text>
    </template>
    <v-dialog v-model="confirm" max-width="440">
      <v-card title="Clear the schedule?">
        <v-card-text class="text-medium-emphasis">The workload follows its idle window alone again: no awake or nap window, no maximum nap.</v-card-text>
        <v-card-actions class="px-4 pb-4">
          <v-spacer />
          <v-btn variant="text" @click="confirm = false">Cancel</v-btn>
          <v-btn color="error" variant="flat" @click="confirm = false; emit('clear')">Clear</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-card>
</template>

<style scoped>
.dm-num { font-variant-numeric: tabular-nums; }
</style>
