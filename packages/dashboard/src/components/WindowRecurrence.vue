<script setup lang="ts">
// How a window repeats (schedule recurrence design), in the Schedule and New window dialogs: the Repeats select and what that
// pattern needs, the times (a cron's duration), the range of dates or a date, the window said back in a sentence and its next
// occurrence in the schedule's zone at the end of that row (the next 5 in a tooltip), or why it cannot be saved under the field
// concerned. Rows hold as many fields as they fit, to save height. The window is the dialog's: a change comes back as a new one, and
// what is not changed stays as it was stored. The default slot follows the times; `actions` ends the first row.
import { computed } from 'vue';
import { mdiAlertOutline, mdiInformationOutline } from '@mdi/js';
import { cronShortestGap, editProblems, localDate, nextOccurrences } from '../occurrences';
import {
  DAYS, TIMES, browserZone, canonicalZone, dayLabel, newMemory, occurrenceText, recurrenceText, repeatChoice, repeatText, windowBody, withChoice, withFrom, withInterval, withOnceDate,
  type Day, type Repeat, type RepeatChoice, type ScheduleWindow,
} from '../schedule';

// date: the day of a calendar selection, where a Do not repeat starts. others and joinMinutes: the schedule's other windows and the
// value in force, what its next occurrences may join (none, a window as written).
const props = withDefaults(defineProps<{ modelValue: ScheduleWindow; timeZone?: string | null; exceptions?: string[]; test?: string; date?: string | null; others?: ScheduleWindow[]; joinMinutes?: number }>(), { timeZone: null, exceptions: () => [], test: 'w', date: null, others: () => [], joinMinutes: 0 });
const emit = defineEmits<{ 'update:modelValue': [ScheduleWindow] }>();

const CHOICES: { value: RepeatChoice; title: string }[] = [
  { value: 'once', title: 'Do not repeat' }, { value: 'weekly', title: 'Weekly' }, { value: 'daily', title: 'Daily' }, { value: 'monthly', title: 'Monthly' }, { value: 'yearly', title: 'Yearly' }, { value: 'cron', title: 'Cron expression' },
];
const UNITS: Partial<Record<RepeatChoice, string>> = { daily: 'day', weekly: 'week', monthly: 'month' };
const NTHS = [{ value: 1, title: 'first' }, { value: 2, title: 'second' }, { value: 3, title: 'third' }, { value: 4, title: 'fourth' }, { value: -1, title: 'last' }];
const WEEKDAYS = DAYS.map((d) => ({ value: d, title: dayLabel(d) }));
const MINUTES = Array.from({ length: 12 }, (_, i) => ({ value: i * 5, title: String(i * 5).padStart(2, '0') }));
const ENDS = [{ value: 'none', title: 'No end date' }, { value: 'date', title: 'On a date' }];
// How often a start is frequent enough to say what it does to a manual Nap or Wake.
const FREQUENT = 15;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const w = computed(() => props.modelValue);
const repeat = computed(() => w.value.repeat as (Repeat & { interval?: number; day?: number; nth?: number; weekday?: Day; days?: Day[]; cron?: string; minutes?: number }) | undefined);
const choice = computed(() => repeatChoice(w.value));
const zone = computed(() => canonicalZone(props.timeZone) ?? browserZone());
const today = () => localDate(Date.now(), zone.value);
const update = (next: ScheduleWindow) => emit('update:modelValue', next);
const setRepeat = (fields: Record<string, unknown>) => update({ ...w.value, repeat: { ...w.value.repeat, ...fields } as Repeat });
// A number being typed: NaN when blank, which the checks refuse, and the field stays blank.
const typed = (value: unknown): number => (value === '' || value === null || value === undefined ? NaN : Number(value));
const shown = (value: number | undefined): number | string => (value === undefined || Number.isNaN(value) ? '' : value);

// This row's own, kept as long as the row is (a dialog gives each a stable key).
const memory = newMemory();
const choose = (next: RepeatChoice) => {
  memory.onceDate = props.date ?? undefined;
  update(withChoice(w.value, next, today(), memory));
};
const oncePast = computed(() => choice.value === 'once' && Boolean(w.value.from) && w.value.from! < today());

const body = computed(() => windowBody(w.value));
const problems = computed(() => editProblems(w.value));
const valid = computed(() => !Object.keys(problems.value).length);
const days = computed(() => (w.value.repeat ? repeat.value?.days : w.value.days) ?? []);
const setDays = (chosen: Day[]) => {
  const inOrder = DAYS.filter((d) => chosen.includes(d));
  update(w.value.repeat ? { ...w.value, repeat: { ...w.value.repeat, days: inOrder } as Repeat } : { ...w.value, days: inOrder });
};
const daysProblem = computed(() => (choice.value === 'weekly' && (problems.value.days || problems.value['repeat.days']) ? 'Choose at least one day.' : ''));

const monthly = computed(() => (repeat.value?.nth === undefined || repeat.value?.nth === null ? 'day' : 'nth'));
const setMonthly = (mode: 'day' | 'nth') => {
  const { pattern, interval } = w.value.repeat as Repeat & { interval?: number };
  if (mode === 'day' && choice.value) memory.filledDay[choice.value] = true;
  const fields = mode === 'day' ? { day: Number((w.value.from ?? today()).slice(8, 10)) } : { nth: 1, weekday: DAYS[(new Date(`${w.value.from ?? today()}T00:00:00Z`).getUTCDay() + 6) % 7] };
  update({ ...w.value, repeat: { pattern, ...(interval === undefined ? {} : { interval }), ...fields } as Repeat });
};
const setDay = (value: unknown) => {
  if (choice.value) memory.filledDay[choice.value] = false;
  setRepeat({ day: typed(value) });
};
const yearMonth = computed(() => MONTH_NAMES[Number(w.value.from?.slice(5, 7)) - 1] ?? '');

const hours = computed(() => (Number.isNaN(repeat.value?.minutes) ? '' : Math.floor((repeat.value?.minutes ?? 0) / 60)));
const minutePart = computed(() => (repeat.value?.minutes ?? 0) % 60 || 0);
const frequent = computed(() => {
  const gap = choice.value === 'cron' ? cronShortestGap(repeat.value?.cron) : null;
  return gap !== null && gap <= FREQUENT ? gap : null;
});

const unit = computed(() => `${UNITS[choice.value!]}${repeat.value?.interval === undefined || repeat.value.interval === 1 ? '' : 's'}`);
const needsFrom = computed(() => (repeat.value?.interval ?? 1) > 1);
// An end date kept blank stays "On a date": a problem until there is one, not an end date silently gone.
const ended = computed(() => w.value.until !== undefined && w.value.until !== null);
const setEnd = (kind: string) => {
  const { until: _, ...rest } = w.value;
  if (kind === 'none') return update(rest);
  // A month after the start, or from today: a date to correct, valid meanwhile.
  const base = Date.parse(`${w.value.from ?? today()}T00:00:00Z`);
  return update({ ...rest, until: new Date(base + 30 * 86_400_000).toISOString().slice(0, 10) });
};

const sentence = computed(() => (daysProblem.value || w.value.until === '' ? '' : recurrenceText(body.value)));
const head = computed(() => repeatText(body.value));
const tail = computed(() => sentence.value.slice(head.value.length));
const next = computed(() => (valid.value ? nextOccurrences({ timeZone: zone.value, windows: [body.value, ...props.others], exceptions: props.exceptions }, Date.now(), 5, { joinMinutes: props.joinMinutes, window: 0 }) : []));
// A problem that has no field of its own here: a stored window nothing else shows it for.
const SHOWN = ['days', 'repeat.days', 'repeat.interval', 'repeat.day', 'repeat.nth', 'repeat.weekday', 'repeat', 'repeat.cron', 'repeat.minutes', 'from', 'until'];
const other = computed(() => Object.entries(problems.value).filter(([field]) => !SHOWN.includes(field)).map(([field, why]) => `${field}: ${why}`));
</script>

<template>
  <div class="dm-recurrence">
    <div class="d-flex flex-wrap align-start ga-3 mt-3">
      <v-select :data-test="`${test}-pattern`" :model-value="choice" :items="CHOICES" label="Repeats" density="compact" hide-details class="dm-repeats" @update:model-value="choose($event)" />
      <v-text-field
        v-if="choice && UNITS[choice]" :data-test="`${test}-interval`" :model-value="shown(repeat?.interval ?? 1)" label="Every" type="number" min="1" max="99" :suffix="unit" density="compact" class="dm-interval"
        :error-messages="problems['repeat.interval'] ?? ''" :hide-details="!problems['repeat.interval']" @update:model-value="update(withInterval(w, typed($event), today(), memory))"
      />
      <v-chip-group v-if="choice === 'weekly'" :data-test="`${test}-days`" :model-value="days" multiple column aria-label="Days" class="dm-days" @update:model-value="setDays">
        <v-chip v-for="d in DAYS" :key="d" :value="d" :data-test="`${test}-day-${d}`" filter size="small" variant="outlined">{{ dayLabel(d) }}</v-chip>
      </v-chip-group>
      <v-text-field
        v-if="choice === 'cron'" :data-test="`${test}-cron`" :model-value="repeat?.cron" label="Cron expression" density="compact" class="dm-cron" spellcheck="false" autocomplete="off" persistent-hint
        hint="minute hour day-of-month month day-of-week, minutes multiples of 5" :error-messages="problems['repeat.cron'] ?? ''" @update:model-value="setRepeat({ cron: $event ?? '' })"
      />
      <div v-if="$slots.actions" class="ms-auto"><slot name="actions" /></div>
    </div>
    <div v-if="daysProblem" :data-test="`${test}-days-hint`" class="text-body-small text-error">{{ daysProblem }}</div>

    <template v-if="choice === 'monthly' || choice === 'yearly'">
      <v-radio-group :data-test="`${test}-monthly`" :model-value="monthly" inline hide-details class="mt-2" @update:model-value="setMonthly($event as 'day' | 'nth')">
        <div class="dm-on">
          <v-radio value="day" label="On day" class="dm-on__radio" />
          <v-text-field
            :data-test="`${test}-month-day`" :model-value="shown(repeat?.day)" :disabled="monthly !== 'day'" aria-label="Day of the month" type="number" min="1" max="31" density="compact" class="dm-interval"
            :error-messages="problems['repeat.day'] ?? ''" :hide-details="!problems['repeat.day']" @update:model-value="setDay($event)"
          />
        </div>
        <div class="dm-on">
          <v-radio value="nth" label="On the" class="dm-on__radio" />
          <v-select :data-test="`${test}-nth`" :model-value="repeat?.nth" :disabled="monthly !== 'nth'" :items="NTHS" aria-label="Which one in the month" density="compact" hide-details class="dm-nth" @update:model-value="setRepeat({ nth: $event })" />
          <v-select :data-test="`${test}-weekday`" :model-value="repeat?.weekday" :disabled="monthly !== 'nth'" :items="WEEKDAYS" aria-label="Weekday" density="compact" hide-details class="dm-nth" @update:model-value="setRepeat({ weekday: $event })" />
        </div>
      </v-radio-group>
      <div v-if="problems['repeat'] || problems['repeat.nth'] || problems['repeat.weekday']" class="text-body-small text-error mt-1">{{ problems['repeat'] || problems['repeat.nth'] || problems['repeat.weekday'] }}</div>
      <div v-if="monthly === 'day' && Number(repeat?.day) > 28" class="text-body-small text-medium-emphasis mt-1">A month without this day has it on its last day.</div>
      <div v-if="choice === 'yearly'" :data-test="`${test}-year-hint`" class="text-body-small text-medium-emphasis mt-1">The month is the start date's{{ yearMonth ? `: ${yearMonth}` : '' }}.</div>
    </template>

    <v-alert v-if="frequent" :data-test="`${test}-cron-warning`" type="warning" variant="tonal" density="compact" :icon="mdiAlertOutline" class="mt-2 text-body-small">
      This starts as often as every {{ frequent }} minutes, and each start applies again: a manual Nap or Wake lasts until the next start, and an awake window blocks naps.
    </v-alert>

    <div class="d-flex flex-wrap align-start ga-3 mt-3">
      <template v-if="choice === 'cron'">
        <v-text-field
          :data-test="`${test}-hours`" :model-value="hours" label="Lasts" suffix="h" type="number" min="0" max="168" density="compact" class="dm-interval" :error-messages="problems['repeat.minutes'] ?? ''" :hide-details="!problems['repeat.minutes']"
          @update:model-value="setRepeat({ minutes: typed($event) * 60 + minutePart })"
        />
        <v-select :data-test="`${test}-minutes`" :model-value="minutePart" :items="MINUTES" label="Minutes" suffix="min" density="compact" hide-details class="dm-time" @update:model-value="setRepeat({ minutes: (Number(hours) || 0) * 60 + $event })" />
      </template>
      <template v-else-if="choice">
        <v-select :data-test="`${test}-start`" :model-value="w.start" :items="TIMES" label="From" density="compact" hide-details class="dm-time" @update:model-value="update({ ...w, start: $event })" />
        <v-select :data-test="`${test}-end`" :model-value="w.end" :items="TIMES" label="To" density="compact" hide-details class="dm-time" @update:model-value="update({ ...w, end: $event })" />
      </template>
      <slot />
      <v-text-field
        v-if="choice === 'once'" :data-test="`${test}-once-date`" :model-value="w.from ?? ''" label="Date" type="date" density="compact" class="dm-date"
        :error-messages="problems.until ?? problems.from ?? ''" :hide-details="!problems.until && !problems.from" @update:model-value="update(withOnceDate(w, $event ?? ''))"
      />
      <template v-else>
        <v-text-field
          :data-test="`${test}-from`" :model-value="w.from ?? ''" :label="needsFrom ? 'Start date' : 'Start date (optional)'" type="date" density="compact" class="dm-date"
          :error-messages="problems.from ?? ''" :hide-details="!problems.from" @update:model-value="update(withFrom(w, $event ?? '', memory))"
        />
        <v-select :data-test="`${test}-end-kind`" :model-value="ended ? 'date' : 'none'" :items="ENDS" label="End" density="compact" hide-details class="dm-date" @update:model-value="setEnd($event)" />
        <v-text-field
          v-if="ended" :data-test="`${test}-until`" :model-value="w.until" label="End date" type="date" density="compact" class="dm-date"
          :error-messages="problems.until ?? ''" :hide-details="!problems.until" @update:model-value="update({ ...w, until: $event ?? '' })"
        />
      </template>
    </div>
    <div v-if="oncePast" :data-test="`${test}-once-past`" class="text-body-small text-warning mt-1">This date is past: the window will never run.</div>

    <div v-if="other.length" class="text-body-small text-error mt-2">{{ other.join('; ') }}</div>
    <div v-if="sentence || valid" :data-test="`${test}-recap`" class="dm-recap mt-3">
      <div v-if="sentence" :data-test="`${test}-sentence`" class="text-body-medium"><strong :data-test="`${test}-repeats`">{{ head.charAt(0).toUpperCase() + head.slice(1) }}</strong>{{ tail }}</div>
      <div v-if="valid" :data-test="`${test}-next`" class="dm-recap__next text-body-small">
        <v-tooltip v-if="next.length" location="top" max-width="340" open-on-focus>
          <template #activator="{ props: activator }">
            <span v-bind="activator" :data-test="`${test}-next-line`" class="dm-next-line" tabindex="0"><span class="text-medium-emphasis">Next:</span> {{ occurrenceText(next[0]!, zone) }} <v-icon :icon="mdiInformationOutline" size="14" /></span>
          </template>
          <div :data-test="`${test}-next-list`">
            <div class="font-weight-medium mb-1">Next occurrences</div>
            <ul class="dm-next"><li v-for="(o, i) in next" :key="i">{{ occurrenceText(o, zone) }}</li></ul>
          </div>
        </v-tooltip>
        <span v-else class="text-medium-emphasis">No occurrence in the next 10 years.</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dm-repeats { max-width: 200px; min-width: 160px; }
.dm-interval { max-width: 130px; min-width: 110px; }
.dm-time { max-width: 130px; min-width: 110px; }
.dm-nth { max-width: 130px; min-width: 100px; }
.dm-date { max-width: 190px; min-width: 150px; }
.dm-cron :deep(input) { font-family: var(--dm-mono); }
.dm-days { flex: 0 1 auto; padding: 4px 0 0; }
.dm-cron { flex: 1 1 260px; max-width: 420px; }
.dm-on { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-right: 24px; }
.dm-on__radio { flex: 0 0 auto; }
.dm-recap { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 16px; }
.dm-recap__next { margin-left: auto; }
.dm-next-line { cursor: help; }
.dm-next { margin: 0; padding-left: 18px; font-variant-numeric: tabular-nums; }
</style>
