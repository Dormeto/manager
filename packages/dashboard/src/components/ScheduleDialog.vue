<script setup lang="ts">
// Edit a workload's schedule (R12): a row per window with how it repeats (WindowRecurrence), the time zone (the browser's by
// default), exceptions, the maximum nap and how far apart windows join. The router's refusals are shown as it words them.
import { computed, ref, watch } from 'vue';
import { mdiCalendarClock, mdiDeleteOutline, mdiWeatherNight, mdiWeatherSunny } from '@mdi/js';
import { editProblems } from '../occurrences';
import { browserZone, formProblem, isJoinMinutes, joinText, newWindow, recurrenceError, scheduleBody, type JoinAnswer, type Schedule, type ScheduleWindow } from '../schedule';
import JoinField from './JoinField.vue';
import ScheduleHelp from './ScheduleHelp.vue';
import WindowRecurrence from './WindowRecurrence.vue';

// join: the status answer's value and what is inherited; a router that answers none does not join, and is not asked.
const props = defineProps<{ modelValue: boolean; schedule: Schedule | null | undefined; name: string; error?: string; saving?: boolean; join?: JoinAnswer | null }>();
const emit = defineEmits<{ 'update:modelValue': [boolean]; submit: [Schedule]; clear: [] }>();
const windows = ref<ScheduleWindow[]>([]);
// A stable key for each row, beside its window: a window is replaced as it is edited, and a row keeps its helper's memory when
// another one is removed.
const keys = ref<number[]>([]);
let lastKey = 0;
const timeZone = ref('');
const exceptions = ref<string[]>([]);
// What is typed in the exceptions field and not yet committed with Enter: kept on blur when it is a date.
const typed = ref<string | null>('');
const maxNap = ref('');
// The workload's own value: null inherits, NaN is a field left blank.
const joinMinutes = ref<number | null>(null);
const inherited = computed(() => props.join?.joinInherited ?? null);
const joinInvalid = computed(() => joinMinutes.value !== null && !isJoinMinutes(joinMinutes.value));
// What the helpers compute with: an own value being typed counts once it reads.
const inForce = computed(() => (!inherited.value ? 0 : isJoinMinutes(joinMinutes.value) ? joinMinutes.value : inherited.value.joinMinutes));
const zones = (() => {
  try { return Intl.supportedValuesOf('timeZone'); } catch { return []; }
})();
watch(() => props.modelValue, (open) => {
  if (!open) return;
  const s = props.schedule;
  windows.value = (s?.windows ?? []).map((w) => JSON.parse(JSON.stringify(w)) as ScheduleWindow);
  keys.value = windows.value.map(() => ++lastKey);
  timeZone.value = s?.timeZone || browserZone();
  exceptions.value = [...(s?.exceptions ?? [])];
  maxNap.value = s?.maxNapDays ? String(s.maxNapDays) : '';
  joinMinutes.value = s?.joinMinutes ?? null;
  typed.value = '';
}, { immediate: true });
// A router that answers no inherited value does not know a stored one (rolled back), and would refuse every save with it.
const form = computed<Schedule>(() => ({ timeZone: timeZone.value, windows: windows.value, exceptions: exceptions.value, joinMinutes: inherited.value ? joinMinutes.value : null }));
const problem = computed(() => formProblem(form.value, maxNap.value));
// A window's own problems are shown under its fields, and keep Save off.
const windowsInvalid = computed(() => windows.value.some((w) => Object.keys(editProblems(w)).length));
const add = (kind: 'awake' | 'nap') => { windows.value.push(newWindow(kind)); keys.value.push(++lastKey); };
const remove = (i: number) => { windows.value.splice(i, 1); keys.value.splice(i, 1); };
const setKind = (w: ScheduleWindow, kind: 'awake' | 'nap') => { w.kind = kind; if (kind === 'nap') w.wake ??= 'never'; };
// With no window and no maximum nap left, saving would be refused: what the user means is to clear the schedule.
const clearing = computed(() => Boolean(props.schedule) && !windows.value.length && !maxNap.value.trim());
const confirmClear = ref(false);
const submit = () => emit('submit', scheduleBody(form.value, maxNap.value));
const DATE = /^\d{4}-\d{2}-\d{2}$/;
function commitTyped() {
  const t = (typed.value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t) && !exceptions.value.includes(t)) exceptions.value = [...exceptions.value, t];
  typed.value = '';
}
const badDate = computed(() => exceptions.value.find((e) => !DATE.test(e)));
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="760" scrollable @update:model-value="emit('update:modelValue', $event)">
    <v-card :title="`Schedule of ${name}`">
      <template #prepend><v-avatar color="primary" variant="tonal" rounded="lg" size="36"><v-icon :icon="mdiCalendarClock" size="20" /></v-avatar></template>
      <v-card-text>
        <p class="mb-4 text-medium-emphasis"><span data-test="schedule-intro">Awake and nap windows override the idle rules, in local time.</span> <ScheduleHelp /></p>
        <v-combobox v-model="timeZone" :items="zones" label="Time zone" density="compact" data-test="time-zone" />
        <div v-for="(w, i) in windows" :key="keys[i]" data-test="window" class="dm-window">
          <div class="d-flex flex-wrap align-center ga-2">
            <v-btn-toggle :model-value="w.kind" mandatory density="compact" variant="outlined" divided @update:model-value="setKind(w, $event)">
              <v-btn value="awake" size="small" :prepend-icon="mdiWeatherSunny">Awake</v-btn>
              <v-btn value="nap" size="small" :prepend-icon="mdiWeatherNight">Nap</v-btn>
            </v-btn-toggle>
            <v-spacer />
            <v-tooltip location="top">
              <template #activator="{ props: activator }">
                <v-btn v-bind="activator" data-test="remove-window" :icon="mdiDeleteOutline" variant="text" size="small" :aria-label="`Remove window ${i + 1}`" @click="remove(i)" />
              </template>
              <span data-test="remove-window-tip">Remove this window</span>
            </v-tooltip>
          </div>
          <WindowRecurrence v-model="windows[i]!" :time-zone="timeZone" :exceptions="exceptions" :others="windows.filter((_, j) => j !== i)" :join-minutes="inForce">
            <v-select v-if="w.kind === 'nap'" :model-value="w.wake ?? 'never'" :items="[{ value: 'never', title: 'Requests never wake it' }, { value: 'header', title: 'Wake with the x-dormeto-wake header' }]" label="Wake" density="compact" hide-details class="dm-wake" @update:model-value="w.wake = $event" />
          </WindowRecurrence>
        </div>
        <div class="d-flex ga-2 my-3">
          <v-btn variant="tonal" size="small" @click="add('awake')">Add awake window</v-btn>
          <v-btn variant="tonal" size="small" @click="add('nap')">Add nap window</v-btn>
        </div>
        <v-combobox v-model="exceptions" v-model:search="typed" @blur="commitTyped" label="Dates without a window (YYYY-MM-DD)" multiple chips closable-chips density="compact" :items="[]" :hint="badDate ? `${badDate} is not a date as YYYY-MM-DD` : 'A window that starts on one of these dates does not apply.'" persistent-hint :error="Boolean(badDate)" />
        <v-text-field v-model="maxNap" label="Maximum nap (days, 1 to 60)" density="compact" type="number" min="1" max="60" class="mt-3" hint="Past it, the workload wakes for maintenance, then naps again. Blank for none." persistent-hint />
        <JoinField v-if="inherited" v-model="joinMinutes" :inherited="inherited.joinMinutes" :inherit-label="`Inherit (${joinText(inherited)})`" class="mt-3" />
        <v-alert v-if="problem && windows.length + Number(Boolean(maxNap)) > 0" type="warning" variant="tonal" density="compact" class="mt-3" :text="problem" />
        <v-alert v-if="error" data-test="schedule-error" type="error" variant="tonal" density="compact" class="mt-3" :text="recurrenceError(error)" />
      </v-card-text>
      <v-card-actions class="px-4 pb-4">
        <v-btn v-if="schedule && !clearing" data-test="dialog-clear" variant="text" color="error" :disabled="saving" @click="confirmClear = true">Clear schedule</v-btn>
        <v-spacer />
        <v-btn variant="text" @click="emit('update:modelValue', false)">Cancel</v-btn>
        <v-btn v-if="clearing" data-test="dialog-clear" color="error" variant="flat" :disabled="saving" @click="confirmClear = true">Clear schedule</v-btn>
        <v-btn v-else color="primary" variant="flat" :disabled="Boolean(problem) || windowsInvalid || Boolean(badDate) || joinInvalid || saving" @click="submit">Save</v-btn>
      </v-card-actions>
    </v-card>
    <v-dialog v-model="confirmClear" max-width="440">
      <v-card title="Clear the schedule?">
        <v-card-text class="text-medium-emphasis">The workload follows its idle window alone again: no awake or nap window, no maximum nap. The changes made here are dropped.</v-card-text>
        <v-card-actions class="px-4 pb-4">
          <v-spacer />
          <v-btn variant="text" @click="confirmClear = false">Cancel</v-btn>
          <v-btn color="error" variant="flat" @click="confirmClear = false; emit('clear')">Clear</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-dialog>
</template>

<style scoped>
.dm-window { border: 1px solid rgb(var(--v-theme-outline-variant, 128 128 128) / 0.4); border-radius: 12px; padding: 12px; margin-bottom: 12px; }
.dm-wake { max-width: 300px; }
</style>
