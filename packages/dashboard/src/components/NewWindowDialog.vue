<script setup lang="ts">
// "New window": a weekly window drawn on the Schedules calendar (or from its button) for one workload the user may edit.
// The times come from the selection on the zone's clock (windowFromSelection; allDayWindow for a month selection), so
// they are computed again when the workload, and so the zone, changes. Saving replaces the workload's schedule with the
// one read when the dialog opened plus this window: the router has no merge.
import { computed, ref, watch } from 'vue';
import { mdiCalendarPlus } from '@mdi/js';
import { useDisplay } from 'vuetify';
import { allDayWindow, occurrencesIn, windowFromSelection } from '../occurrences';
import { browserZone, dayLabel, daysText, scheduleBody, type Day, type Schedule, type ScheduleWindow } from '../schedule';

export interface Candidate { key: string; name: string; schedule: Schedule | null }
export interface Selection { start: Date; end: Date; month: boolean; days?: Day[] }

const props = defineProps<{ modelValue: boolean; candidates: Candidate[]; selection: Selection | null; last?: string; error?: string; saving?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [boolean]; submit: [{ key: string; schedule: Schedule }] }>();
const { smAndDown } = useDisplay();

// What the dialog opened with: later reads of the workloads do not change it.
const options = ref<Candidate[]>([]);
const key = ref<string | null>(null);
const kind = ref<'awake' | 'nap'>('awake');
const wake = ref<'never' | 'header'>('never');
watch(() => props.modelValue, (open) => {
  if (!open) return;
  options.value = props.candidates.map((c) => ({ ...c, schedule: c.schedule ? JSON.parse(JSON.stringify(c.schedule)) as Schedule : null }));
  key.value = options.value.some((c) => c.key === props.last) ? props.last! : options.value.length === 1 ? options.value[0]!.key : null;
  kind.value = props.selection?.month ? 'nap' : 'awake';
  wake.value = 'never';
}, { immediate: true });

const chosen = computed(() => options.value.find((c) => c.key === key.value) ?? null);
const zone = computed(() => chosen.value?.schedule?.timeZone || browserZone());
const placed = computed(() => {
  const s = props.selection;
  if (!s) return { problem: 'Select a range on the calendar.' };
  if (s.month) return allDayWindow(s.days ?? []);
  return windowFromSelection(s.start, s.end, zone.value);
});
const problem = computed(() => ('problem' in placed.value ? placed.value.problem : ''));
const window_ = computed<ScheduleWindow | null>(() => {
  const p = placed.value;
  if ('problem' in p) return null;
  return { kind: kind.value, days: p.days, start: p.start, end: p.end, ...(kind.value === 'nap' ? { wake: wake.value } : {}) };
});

// A repeated or skipped hour on the selected day: the weekly window, read on that day, is not the instants selected.
const here = browserZone();
const hhmm = (t: number) => new Intl.DateTimeFormat('en-GB', { timeZone: here, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).format(new Date(t));
const clockChange = computed(() => {
  const s = props.selection;
  const w = window_.value;
  if (!s || s.month || !w) return '';
  const [from, to] = [s.start.getTime(), s.end.getTime()];
  const found = occurrencesIn({ timeZone: zone.value, windows: [w] }, from, to);
  if (found.some((o) => o.start === from && o.end === to)) return '';
  const o = found[0];
  if (!o) return '';
  const date = new Intl.DateTimeFormat('en-GB', { timeZone: here, weekday: 'short', day: 'numeric', month: 'short' }).format(s.start);
  return `On ${date} the clock change moves it to ${hhmm(o.start)}–${hhmm(o.end)} (${here}).`;
});

const repeats = computed(() => {
  const p = placed.value;
  return 'problem' in p ? '' : p.days.length === 1 ? dayLabel(p.days[0]!) : daysText(p.days);
});
const times = computed(() => {
  const p = placed.value;
  if ('problem' in p) return '';
  return p.start === p.end ? 'all day (24 hours)' : `${p.start}–${p.end}${p.end < p.start ? ' (ends the next day)' : ''}`;
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
  }, current?.maxNapDays ? String(current.maxNapDays) : '');
  emit('submit', { key: c.key, schedule });
}
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="560" :fullscreen="smAndDown" scrollable @update:model-value="emit('update:modelValue', $event)">
    <v-card title="New window">
      <template #prepend><v-avatar color="primary" variant="tonal" rounded="lg" size="36"><v-icon :icon="mdiCalendarPlus" size="20" /></v-avatar></template>
      <v-card-text>
        <v-alert v-if="!options.length" data-test="nw-none" type="info" variant="tonal" density="compact" text="No enabled calendar may be edited: enable the calendar of a workload you may wake and nap, then try again." />
        <template v-else>
          <v-select v-model="key" data-test="nw-workload" :items="options" item-title="name" item-value="key" label="Workload" density="compact" />
          <v-btn-toggle v-model="kind" data-test="nw-kind" mandatory density="compact" variant="outlined" divided class="mb-3">
            <v-btn value="awake" size="small">Awake</v-btn>
            <v-btn value="nap" size="small">Nap</v-btn>
          </v-btn-toggle>
          <v-select v-if="kind === 'nap'" v-model="wake" data-test="nw-wake" :items="[{ value: 'never', title: 'Requests never wake it' }, { value: 'header', title: 'Wake with the x-dormeto-wake header' }]" label="Wake" density="compact" />
          <v-alert v-if="problem" data-test="nw-problem" type="warning" variant="tonal" density="compact" class="mb-3" :text="problem" />
          <div v-else data-test="nw-summary" class="mb-3">
            <div><span class="text-medium-emphasis">Repeats every</span> <strong data-test="nw-repeats">{{ repeats }}</strong></div>
            <div><span class="text-medium-emphasis">Hours</span> <strong data-test="nw-times">{{ times }}</strong></div>
            <div><span class="text-medium-emphasis">Time zone</span> <strong data-test="nw-zone">{{ zone }}</strong><span v-if="chosen && !chosen.schedule?.timeZone" class="text-medium-emphasis"> (a first schedule: your browser's zone)</span></div>
          </div>
          <v-alert v-if="clockChange" data-test="nw-clock" type="info" variant="tonal" density="compact" class="mb-3" :text="clockChange" />
          <p data-test="nw-replace-note" class="text-body-small text-medium-emphasis">Saving replaces the workload's schedule with the one read when this dialog opened plus this window: a change made by someone else since then is lost.</p>
        </template>
        <v-alert v-if="error" data-test="nw-error" type="error" variant="tonal" density="compact" class="mt-3" :text="error" />
      </v-card-text>
      <v-card-actions class="px-4 pb-4">
        <v-spacer />
        <v-btn variant="text" @click="emit('update:modelValue', false)">Cancel</v-btn>
        <v-btn data-test="nw-save" color="primary" variant="flat" :disabled="!canSave" :loading="saving" @click="save">Save</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
