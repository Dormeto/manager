<script setup lang="ts">
// Edit a workload's schedule (R12): what applies to the whole schedule first (the time zone, the browser's by default, the
// exceptions, the maximum nap and how far apart windows join), then a tab per window, named by its kind's icon and its window in a
// few words, with how it repeats (WindowRecurrence). A window keeps its kind: the buttons after the tabs add a nap or an awake one.
// The router's refusals are shown as it words them.
import { computed, ref, watch } from 'vue';
import { mdiAlertCircleOutline, mdiCalendarClock, mdiDeleteOutline, mdiPlus, mdiWeatherNight, mdiWeatherSunny } from '@mdi/js';
import { editProblems, nextOccurrences } from '../occurrences';
import {
  JOIN_MINUTES_MAX, browserZone, canonicalZone, formProblem, isJoinMinutes, joinText, newWindow, recurrenceError, scheduleBody, windowBody, windowTitle,
  type JoinAnswer, type Schedule, type ScheduleWindow,
} from '../schedule';
import JoinField from './JoinField.vue';
import ScheduleHelp from './ScheduleHelp.vue';
import WindowRecurrence from './WindowRecurrence.vue';

// join: the status answer's value and what is inherited; a router that answers none does not join, and is not asked.
const props = defineProps<{ modelValue: boolean; schedule: Schedule | null | undefined; name: string; error?: string; saving?: boolean; join?: JoinAnswer | null }>();
const emit = defineEmits<{ 'update:modelValue': [boolean]; submit: [Schedule]; clear: [] }>();
const windows = ref<ScheduleWindow[]>([]);
// A stable key for each window, beside it: a window is replaced as it is edited, and a tab keeps its helper's memory when
// another one is removed. The selected tab is a key.
const keys = ref<number[]>([]);
let lastKey = 0;
const tab = ref<number | null>(null);
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
  tab.value = keys.value[0] ?? null;
  timeZone.value = s?.timeZone || browserZone();
  exceptions.value = [...(s?.exceptions ?? [])];
  maxNap.value = s?.maxNapDays ? String(s.maxNapDays) : '';
  joinMinutes.value = s?.joinMinutes ?? null;
  typed.value = '';
}, { immediate: true });
// A router that answers no inherited value does not know a stored one (rolled back), and would refuse every save with it.
const form = computed<Schedule>(() => ({ timeZone: timeZone.value, windows: windows.value, exceptions: exceptions.value, joinMinutes: inherited.value ? joinMinutes.value : null }));
const problem = computed(() => formProblem(form.value, maxNap.value));
// A window's own problems are shown under its fields, and keep Save off; its tab is marked, the window may not be the one shown.
const invalid = computed(() => windows.value.map((w) => Object.keys(editProblems(w)).length > 0));
const windowsInvalid = computed(() => invalid.value.some(Boolean));
const titles = computed(() => windows.value.map((w) => windowTitle(windowBody(w))));
const kindName = (w: ScheduleWindow) => (w.kind === 'nap' ? 'Nap' : 'Awake');

// Joining is offered where it can matter (the user, 2026-11-02: from two windows), and where one window comes back within the
// largest gap and so joins itself, such as a daily nap to 23:45. A value of the schedule's own stays in sight: it is never hidden.
const joinsItself = computed(() => {
  const [w] = windows.value;
  if (windows.value.length !== 1 || !w || invalid.value[0]) return false;
  const next = nextOccurrences({ timeZone: canonicalZone(timeZone.value) ?? browserZone(), windows: [windowBody(w)], exceptions: exceptions.value }, Date.now(), 8);
  return next.some((o, i) => i > 0 && o.start - next[i - 1]!.end <= JOIN_MINUTES_MAX * 60_000);
});
const joinShown = computed(() => Boolean(inherited.value) && (windows.value.length > 1 || props.schedule?.joinMinutes != null || joinMinutes.value !== null || joinsItself.value));

const add = (kind: 'awake' | 'nap') => { windows.value.push(newWindow(kind)); keys.value.push(++lastKey); tab.value = lastKey; };
// The tab after the one removed is selected, or the one before the last.
const remove = (i: number) => {
  windows.value.splice(i, 1);
  keys.value.splice(i, 1);
  if (!keys.value.includes(tab.value!)) tab.value = keys.value[Math.min(i, keys.value.length - 1)] ?? null;
};
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
  <v-dialog :model-value="modelValue" max-width="1100" scrollable @update:model-value="emit('update:modelValue', $event)">
    <v-card :title="`Schedule of ${name}`">
      <template #prepend><v-avatar color="primary" variant="tonal" rounded="lg" size="36"><v-icon :icon="mdiCalendarClock" size="20" /></v-avatar></template>
      <v-card-text class="pt-3">
        <p class="mb-4 text-medium-emphasis"><span data-test="schedule-intro">Awake and nap windows override the idle rules, in local time.</span> <ScheduleHelp /></p>
        <div class="dm-settings">
          <v-combobox v-model="timeZone" :items="zones" label="Time zone" density="compact" hide-details data-test="time-zone" class="dm-settings__zone" />
          <v-combobox
            v-model="exceptions" v-model:search="typed" data-test="exceptions" label="Dates without a window (YYYY-MM-DD)" multiple chips closable-chips density="compact" :items="[]" class="dm-settings__dates"
            :hint="badDate ? `${badDate} is not a date as YYYY-MM-DD` : 'A window that starts on one of these dates does not apply.'" persistent-hint :error="Boolean(badDate)" @blur="commitTyped"
          />
          <v-text-field v-model="maxNap" data-test="max-nap" label="Maximum nap (days, 1 to 60)" density="compact" type="number" min="1" max="60" class="dm-settings__nap" hint="Past it, the workload wakes for maintenance, then naps again. Blank for none." persistent-hint />
        </div>
        <JoinField v-if="joinShown" v-model="joinMinutes" :inherited="inherited!.joinMinutes" :inherit-label="`Inherit (${joinText(inherited!)})`" class="mt-2" />
        <div data-test="windows" class="dm-windows mt-4">
          <div class="dm-windows__bar">
            <v-tabs v-model="tab" data-test="window-tabs" density="compact" show-arrows color="primary" class="dm-windows__tabs">
              <v-tab v-for="(w, i) in windows" :key="keys[i]" :value="keys[i]" data-test="window-tab" class="text-none" :aria-label="`${kindName(w)} window: ${titles[i]}`">
                <v-icon :icon="w.kind === 'nap' ? mdiWeatherNight : mdiWeatherSunny" size="18" class="me-2" />
                <span class="dm-tab__title">{{ titles[i] }}</span>
                <v-icon v-if="invalid[i]" data-test="window-tab-problem" :icon="mdiAlertCircleOutline" color="error" size="16" class="ms-1" />
              </v-tab>
            </v-tabs>
            <v-tooltip location="top" open-on-focus>
              <template #activator="{ props: activator }">
                <v-btn v-bind="activator" data-test="add-nap" variant="text" size="small" class="dm-add" aria-label="Add a nap window" @click="add('nap')"><v-icon :icon="mdiPlus" size="16" /><v-icon :icon="mdiWeatherNight" size="18" /></v-btn>
              </template>
              <span data-test="add-nap-tip">Add a nap window</span>
            </v-tooltip>
            <v-tooltip location="top" open-on-focus>
              <template #activator="{ props: activator }">
                <v-btn v-bind="activator" data-test="add-awake" variant="text" size="small" class="dm-add" aria-label="Add an awake window" @click="add('awake')"><v-icon :icon="mdiPlus" size="16" /><v-icon :icon="mdiWeatherSunny" size="18" /></v-btn>
              </template>
              <span data-test="add-awake-tip">Add an awake window</span>
            </v-tooltip>
          </div>
          <div v-for="(w, i) in windows" v-show="keys[i] === tab" :key="keys[i]" data-test="window" class="dm-window">
            <WindowRecurrence v-model="windows[i]!" :time-zone="timeZone" :exceptions="exceptions" :others="windows.filter((_, j) => j !== i)" :join-minutes="inForce">
              <v-select v-if="w.kind === 'nap'" :model-value="w.wake ?? 'never'" :items="[{ value: 'never', title: 'Requests never wake it' }, { value: 'header', title: 'Wake with the x-dormeto-wake header' }]" label="Wake" density="compact" hide-details class="dm-wake" @update:model-value="w.wake = $event" />
              <template #actions>
                <v-tooltip location="top">
                  <template #activator="{ props: activator }">
                    <v-btn v-bind="activator" data-test="remove-window" :icon="mdiDeleteOutline" variant="text" size="small" :aria-label="`Remove the ${kindName(w).toLowerCase()} window ${titles[i]}`" @click="remove(i)" />
                  </template>
                  <span data-test="remove-window-tip">Remove this window</span>
                </v-tooltip>
              </template>
            </WindowRecurrence>
          </div>
          <p v-if="!windows.length" data-test="no-window" class="dm-window text-medium-emphasis">No window yet: add a nap or an awake window with the + buttons.</p>
        </div>
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
.dm-settings { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 12px; }
.dm-settings__zone { flex: 0 1 260px; min-width: 200px; }
.dm-settings__dates { flex: 1 1 280px; }
.dm-settings__nap { flex: 0 1 250px; min-width: 200px; }
.dm-windows { border: 1px solid rgb(var(--v-theme-outline-variant, 128 128 128) / 0.4); border-radius: 12px; }
.dm-windows__bar { display: flex; align-items: center; gap: 2px; padding-right: 8px; border-bottom: 1px solid rgb(var(--v-theme-outline-variant, 128 128 128) / 0.4); }
.dm-windows__tabs { flex: 1 1 auto; min-width: 0; }
.dm-tab__title { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dm-add { min-width: 0; padding: 0 8px; }
.dm-window { padding: 0 16px 16px; margin: 0; }
p.dm-window { padding-top: 16px; }
.dm-wake { max-width: 290px; min-width: 240px; }
</style>
