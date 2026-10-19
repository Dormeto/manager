<script setup lang="ts">
// Edit a workload's schedule (R12): a row per window, weekday chips, times in 5-minute steps, the time zone (the
// browser's by default), exceptions and the maximum nap. The router's refusals are shown as it words them.
import { computed, ref, watch } from 'vue';
import { mdiCalendarClock, mdiDeleteOutline } from '@mdi/js';
import { DAYS, TIMES, browserZone, dayLabel, formProblem, newWindow, scheduleBody, type Schedule, type ScheduleWindow } from '../schedule';

const props = defineProps<{ modelValue: boolean; schedule: Schedule | null | undefined; name: string; error?: string; saving?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [boolean]; submit: [Schedule] }>();
const windows = ref<ScheduleWindow[]>([]);
const timeZone = ref('');
const exceptions = ref<string[]>([]);
const maxNap = ref('');
const zones = (() => {
  try { return Intl.supportedValuesOf('timeZone'); } catch { return []; }
})();
watch(() => props.modelValue, (open) => {
  if (!open) return;
  const s = props.schedule;
  windows.value = (s?.windows ?? []).map((w) => ({ ...w, days: [...w.days] }));
  timeZone.value = s?.timeZone || browserZone();
  exceptions.value = [...(s?.exceptions ?? [])];
  maxNap.value = s?.maxNapDays ? String(s.maxNapDays) : '';
});
const form = computed<Schedule>(() => ({ timeZone: timeZone.value, windows: windows.value, exceptions: exceptions.value }));
const problem = computed(() => formProblem(form.value, maxNap.value));
const add = (kind: 'awake' | 'nap') => windows.value.push(newWindow(kind));
const setKind = (w: ScheduleWindow, kind: 'awake' | 'nap') => { w.kind = kind; if (kind === 'nap') w.wake ??= 'never'; };
const submit = () => emit('submit', scheduleBody(form.value, maxNap.value));
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const badDate = computed(() => exceptions.value.find((e) => !DATE.test(e)));
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="760" scrollable @update:model-value="emit('update:modelValue', $event)">
    <v-card :title="`Schedule of ${name}`">
      <template #prepend><v-avatar color="primary" variant="tonal" rounded="lg" size="36"><v-icon :icon="mdiCalendarClock" size="20" /></v-avatar></template>
      <v-card-text>
        <p class="mb-4 text-medium-emphasis">Weekly windows in local time. An awake window keeps the workload awake; a nap window keeps it asleep, and requests wake it only with the header if you allow it. Windows of different kinds may not overlap.</p>
        <v-combobox v-model="timeZone" :items="zones" label="Time zone" density="compact" data-test="time-zone" />
        <div v-for="(w, i) in windows" :key="i" data-test="window" class="dm-window">
          <div class="d-flex flex-wrap align-center ga-2">
            <v-btn-toggle :model-value="w.kind" mandatory density="compact" variant="outlined" divided @update:model-value="setKind(w, $event)">
              <v-btn value="awake" size="small">Awake</v-btn>
              <v-btn value="nap" size="small">Nap</v-btn>
            </v-btn-toggle>
            <v-chip-group v-model="w.days" multiple :aria-label="`Days of window ${i + 1}`">
              <v-chip v-for="d in DAYS" :key="d" :value="d" filter size="small" variant="outlined">{{ dayLabel(d) }}</v-chip>
            </v-chip-group>
            <v-spacer />
            <v-btn data-test="remove-window" :icon="mdiDeleteOutline" variant="text" size="small" :aria-label="`Remove window ${i + 1}`" @click="windows.splice(i, 1)" />
          </div>
          <div class="d-flex flex-wrap ga-3 mt-2">
            <v-select v-model="w.start" :items="TIMES" label="From" density="compact" hide-details class="dm-time" />
            <v-select v-model="w.end" :items="TIMES" label="To" density="compact" hide-details class="dm-time" />
            <v-select v-if="w.kind === 'nap'" v-model="w.wake" :items="[{ value: 'never', title: 'Requests never wake it' }, { value: 'header', title: 'Wake with the x-dormeto-wake header' }]" label="Wake" density="compact" hide-details class="dm-wake" />
          </div>
          <div class="text-body-small text-medium-emphasis mt-1">{{ w.start === w.end ? 'Lasts 24 hours.' : w.end < w.start ? 'Ends the next day.' : '' }}</div>
        </div>
        <div class="d-flex ga-2 my-3">
          <v-btn variant="tonal" size="small" @click="add('awake')">Add awake window</v-btn>
          <v-btn variant="tonal" size="small" @click="add('nap')">Add nap window</v-btn>
        </div>
        <v-combobox v-model="exceptions" label="Dates without a window (YYYY-MM-DD)" multiple chips closable-chips density="compact" :items="[]" :hint="badDate ? `${badDate} is not a date as YYYY-MM-DD` : 'A window that starts on one of these dates does not apply.'" persistent-hint :error="Boolean(badDate)" />
        <v-text-field v-model="maxNap" label="Maximum nap (days, 1 to 60)" density="compact" type="number" min="1" max="60" class="mt-3" hint="Past it, the workload wakes for maintenance, then naps again. Blank for none." persistent-hint />
        <v-alert v-if="problem && windows.length + Number(Boolean(maxNap)) > 0" type="warning" variant="tonal" density="compact" class="mt-3" :text="problem" />
        <v-alert v-if="error" data-test="schedule-error" type="error" variant="tonal" density="compact" class="mt-3" :text="error" />
      </v-card-text>
      <v-card-actions class="px-4 pb-4">
        <v-spacer />
        <v-btn variant="text" @click="emit('update:modelValue', false)">Cancel</v-btn>
        <v-btn color="primary" variant="flat" :disabled="Boolean(problem) || Boolean(badDate) || saving" @click="submit">Save</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.dm-window { border: 1px solid rgb(var(--v-theme-outline-variant, 128 128 128) / 0.4); border-radius: 12px; padding: 12px; margin-bottom: 12px; }
.dm-time { max-width: 130px; }
.dm-wake { max-width: 300px; }
</style>
