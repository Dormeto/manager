<script setup lang="ts">
// "New window": a window drawn on the Schedules calendar (or from its button) for one workload the user may edit. A
// selection starts a weekly window, and the helper makes it any other (WindowRecurrence). The times come from the selection
// on the zone's clock (windowFromSelection; allDayWindow for a month selection), so they are computed again when the
// workload, and so the zone, changes. Saving replaces the workload's schedule with the
// one read when the dialog opened plus this window: the router has no merge.
import { computed, ref, watch } from 'vue';
import { mdiCalendarPlus, mdiInformationOutline, mdiWeatherNight, mdiWeatherSunny } from '@mdi/js';
import { useDisplay } from 'vuetify';
import { allDayWindow, editProblems, localDate, occurrencesIn, windowFromSelection } from '../occurrences';
import { naturalCompare } from '../calendars';
import { browserZone, recurrenceError, scheduleBody, windowBody, type Day, type Schedule, type ScheduleWindow } from '../schedule';
import ScheduleHelp from './ScheduleHelp.vue';
import WindowRecurrence from './WindowRecurrence.vue';

// joinMinutes: the value in force, from its status answer.
export interface Candidate { key: string; name: string; schedule: Schedule | null; joinMinutes?: number }
export interface Selection { start: Date; end: Date; month: boolean; days?: Day[] }

const props = defineProps<{ modelValue: boolean; candidates: Candidate[]; selection: Selection | null; last?: string; error?: string; saving?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [boolean]; submit: [{ key: string; schedule: Schedule }] }>();
const { smAndDown } = useDisplay();

// What the dialog opened with: later reads of the workloads do not change it.
const options = ref<Candidate[]>([]);
const key = ref<string | null>(null);
const kind = ref<'awake' | 'nap'>('awake');
const wake = ref<'never' | 'header'>('never');
// How it repeats, from the selection until the user edits it (then it is kept when the workload changes).
const draft = ref<ScheduleWindow>({ kind: 'awake', days: [], start: '08:00', end: '09:00' });
const edited = ref(false);
// A helper of its own at each opening: nothing to remember from the last window.
const opening = ref(0);
const fill = () => {
  const p = placed.value;
  draft.value = 'problem' in p ? { kind: 'awake', days: [], start: draft.value.start ?? '08:00', end: draft.value.end ?? '09:00' } : { kind: 'awake', days: [...p.days], start: p.start, end: p.end };
};
const chosen = computed(() => options.value.find((c) => c.key === key.value) ?? null);
// Where a Do not repeat starts: the day of the selection on the zone's clock; a month cell is a date, the one clicked, whatever the zone.
const selectedDate = computed(() => (props.selection ? localDate(props.selection.start.getTime(), props.selection.month ? browserZone() : zone.value) : null));
const zone = computed(() => chosen.value?.schedule?.timeZone || browserZone());
const placed = computed(() => {
  const s = props.selection;
  if (!s) return { problem: 'Select a range on the calendar.' };
  if (s.month) return allDayWindow(s.days ?? []);
  return windowFromSelection(s.start, s.end, zone.value);
});
const problem = computed(() => (!edited.value && 'problem' in placed.value ? placed.value.problem : ''));
const window_ = computed<ScheduleWindow | null>(() => {
  const w: ScheduleWindow = { ...draft.value, kind: kind.value, wake: wake.value };
  return problem.value || Object.keys(editProblems(w)).length ? null : windowBody(w);
});

const edit = (w: ScheduleWindow) => { draft.value = w; edited.value = true; };
// The helper's window is of the kind chosen above it, which decides what it joins.
const drafted = computed<ScheduleWindow>(() => ({ ...draft.value, kind: kind.value }));
watch(() => props.modelValue, (open) => {
  if (!open) return;
  options.value = props.candidates.map((c) => ({ ...c, schedule: c.schedule ? JSON.parse(JSON.stringify(c.schedule)) as Schedule : null })).sort((a, b) => naturalCompare(a.name, b.name));
  key.value = options.value.some((c) => c.key === props.last) ? props.last! : options.value.length === 1 ? options.value[0]!.key : null;
  kind.value = props.selection?.month ? 'nap' : 'awake';
  wake.value = 'never';
  edited.value = false;
  opening.value += 1;
  fill();
}, { immediate: true });
watch(key, () => { if (!edited.value) fill(); });


// A repeated or skipped hour on the selected day: the weekly window, read on that day, is not the instants selected.
const here = browserZone();
const hhmm = (t: number) => new Intl.DateTimeFormat('en-GB', { timeZone: here, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t));
const clockChange = computed(() => {
  const s = props.selection;
  const w = window_.value;
  if (!s || s.month || !w || edited.value) return '';
  const [from, to] = [s.start.getTime(), s.end.getTime()];
  const found = occurrencesIn({ timeZone: zone.value, windows: [w] }, from, to);
  if (found.some((o) => o.start === from && o.end === to)) return '';
  const o = found[0];
  if (!o) return '';
  const date = new Intl.DateTimeFormat('en-GB', { timeZone: here, weekday: 'short', day: 'numeric', month: 'short' }).format(s.start);
  return `On ${date} the clock change moves this window to ${hhmm(o.start)}–${hhmm(o.end)} (${here}).`;
});

const canSave = computed(() => Boolean(chosen.value && window_.value && !props.saving));
function save() {
  const c = chosen.value;
  const w = window_.value;
  if (!c || !w) return;
  const current = c.schedule;
  const schedule = scheduleBody({
    timeZone: zone.value,
    windows: [...(current?.windows ?? []), w],
    ...(current?.exceptions?.length ? { exceptions: current.exceptions } : {}),
    joinMinutes: current?.joinMinutes,
  }, current?.maxNapDays ? String(current.maxNapDays) : '');
  emit('submit', { key: c.key, schedule });
}
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="560" :fullscreen="smAndDown" scrollable @update:model-value="emit('update:modelValue', $event)">
    <v-card title="New window">
      <template #prepend><v-avatar color="primary" variant="tonal" rounded="lg" size="36"><v-icon :icon="mdiCalendarPlus" size="20" /></v-avatar></template>
      <!-- pt-3: the card text scrolls (overflow clips), and the first field's floating label sits above its box -->
      <v-card-text class="pt-3" data-test="nw-body">
        <v-alert v-if="!options.length" data-test="nw-none" type="info" variant="tonal" density="compact" text="No enabled calendar may be edited: enable the calendar of a workload you may wake and nap, then try again." />
        <template v-else>
          <v-autocomplete v-model="key" data-test="nw-workload" :items="options" item-title="name" item-value="key" label="Workload" density="compact" auto-select-first />
          <div class="d-flex flex-wrap align-center ga-2 mb-3">
            <v-btn-toggle v-model="kind" data-test="nw-kind" mandatory density="compact" variant="outlined" divided>
              <v-btn value="awake" size="small" :prepend-icon="mdiWeatherSunny">Awake</v-btn>
              <v-btn value="nap" size="small" :prepend-icon="mdiWeatherNight">Nap</v-btn>
            </v-btn-toggle>
            <ScheduleHelp />
          </div>
          <v-select v-if="kind === 'nap'" v-model="wake" data-test="nw-wake" :items="[{ value: 'never', title: 'Requests never wake it' }, { value: 'header', title: 'Wake with the x-dormeto-wake header' }]" label="Wake" density="compact" />
          <v-alert v-if="problem" data-test="nw-problem" type="warning" variant="tonal" density="compact" class="mb-3" :text="problem" />
          <WindowRecurrence :key="opening" :model-value="drafted" :time-zone="zone" :exceptions="chosen?.schedule?.exceptions" :date="selectedDate" :others="chosen?.schedule?.windows" :join-minutes="chosen?.joinMinutes" test="nw" class="mb-3" @update:model-value="edit" />
          <div data-test="nw-summary" class="mb-3">
            <div><span class="text-medium-emphasis">Time zone</span> <strong data-test="nw-zone">{{ zone }}</strong><span v-if="chosen && !chosen.schedule?.timeZone" class="text-medium-emphasis"> (a first schedule: your browser's zone)</span></div>
          </div>
          <v-alert v-if="clockChange" data-test="nw-clock" type="info" variant="tonal" density="compact" class="mb-3" :text="clockChange" />
          <p class="text-body-small text-medium-emphasis"><span data-test="nw-replace-note">Saving replaces the workload's schedule.</span>
            <v-tooltip location="top" max-width="340" open-on-focus>
              <template #activator="{ props: activator }">
                <v-icon v-bind="activator" data-test="nw-replace-more" :icon="mdiInformationOutline" size="14" tabindex="0" aria-label="More on what saving replaces" />
              </template>
              <span data-test="nw-replace-tip">It takes the one read when this dialog opened plus this window: a change made by someone else since then is lost.</span>
            </v-tooltip>
          </p>
        </template>
        <v-alert v-if="error" data-test="nw-error" type="error" variant="tonal" density="compact" class="mt-3" :text="recurrenceError(error ?? '')" />
      </v-card-text>
      <v-card-actions class="px-4 pb-4">
        <v-spacer />
        <v-btn variant="text" @click="emit('update:modelValue', false)">Cancel</v-btn>
        <v-btn data-test="nw-save" color="primary" variant="flat" :disabled="!canSave" :loading="saving" @click="save">Save</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
