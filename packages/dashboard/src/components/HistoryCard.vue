<script setup lang="ts">
// A workload's state history (R8): the time in each state over a period, a row per local day of its phases, and its
// transitions with what started them. Read from the manager's store, polled with the page.
import { computed, ref, watch } from 'vue';
import { api } from '../api';
import { usePoll } from '../poll';
import { duration, stateColor, usd } from '../format';
import { STATE_ORDER, causeText, collapseRows, dayRows, stateLabel, type Phase } from '../history';
import type { WorkloadHistory } from '../types';

const props = defineProps<{ router: string; id: string; now: number }>();
const days = ref(7);
const history = ref<WorkloadHistory | null>(null);
const path = computed(() => `/workloads/${encodeURIComponent(props.router)}/${encodeURIComponent(props.id)}/history?days=${days.value}`);
const { error, run } = usePoll(async () => { history.value = await api<WorkloadHistory>(path.value); });
watch(days, () => void run());

const rows = computed(() => (history.value?.phases ? collapseRows(dayRows(history.value.phases, history.value.from, history.value.to)) : []));
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const dayLabel = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const seconds = (p: Phase) => Math.round((Date.parse(p.to) - Date.parse(p.from)) / 1000);
const segmentLabel = (p: Phase, merged: number) => {
  const cause = causeText(p);
  return `${stateLabel(p.state)} ${when(p.from)} to ${when(p.to)}, ${duration(seconds(p))}${cause ? `: ${cause}` : ''}${merged ? ` (and ${merged} more change${merged === 1 ? '' : 's'}, too short to draw)` : ''}`;
};
const summary = computed(() => {
  const h = history.value;
  if (!h?.totals) return [];
  // The share of the time the history knows (before it starts, or past its retention, the state is unknown).
  const known = Object.entries(h.totals).filter(([state]) => state !== 'UNKNOWN').reduce((a, [, b]) => a + b, 0);
  if (!known) return ['No history in this period yet: it starts when the manager first sees the workload'];
  const w = h.wakes;
  const ms = (v: number | null) => duration(Math.round((v ?? 0) / 1000));
  return [
    `Asleep ${Math.round(((h.totals.ASLEEP ?? 0) / known) * 100)}%${h.totals.UNKNOWN ? ' of the time with history' : ''}`,
    `awake ${duration(h.totals.AWAKE ?? 0)}`,
    w.count ? `${w.count} wake${w.count === 1 ? '' : 's'}${w.medianMs !== null ? `, median ${ms(w.medianMs)}, longest ${ms(w.maxMs)}` : ''}` : 'no wake',
    ...(w.failed ? [`${w.failed} failed`] : []),
    // R9: what the naps of the period saved, at AWS's list prices.
    // Nothing priced is not $0 saved (review I6): a router before 0.27.0, or what AWS's list prices do not name.
    ...(!h.savings ? [] : h.savings.items.length ? [`saved about ${usd(h.savings.usd)} (estimate)${h.savings.unpriced.length ? ', part not priced' : ''}`]
      : h.savings.unpriced.length ? ['savings not priced yet'] : []),
  ];
});
const transitions = computed(() => [...(history.value?.entries ?? [])].reverse().slice(0, 50));
const LEGEND = STATE_ORDER;
</script>

<template>
  <v-card title="History">
    <template #append>
      <v-btn-toggle v-model="days" mandatory density="compact" variant="outlined" divided>
        <v-btn :value="1" size="small">24 hours</v-btn>
        <v-btn :value="7" size="small">7 days</v-btn>
        <v-btn :value="30" size="small">30 days</v-btn>
      </v-btn-toggle>
    </template>
    <v-card-text v-if="error" class="text-error">{{ error }}</v-card-text>
    <v-card-text v-else-if="history?.phases">
      <div class="text-body-medium mb-3">{{ summary.join(' · ') }}</div>
      <v-alert v-if="history.truncated" type="info" variant="tonal" density="compact" class="mb-2" text="More than 5,000 changes in this period: only the latest are drawn, the time before them is unknown." />
      <div class="d-flex ga-2 text-body-small text-medium-emphasis">
        <span class="day-label" />
        <div class="ticks"><span v-for="(h, i) in ['00:00', '06:00', '12:00', '18:00']" :key="h" :style="{ left: `${i * 25}%` }">{{ h }}</span></div>
      </div>
      <template v-for="item in rows" :key="item.kind === 'day' ? item.row.day.getTime() : `gap-${item.first.getTime()}`">
        <div v-if="item.kind === 'gap'" data-test="gap" class="d-flex align-center ga-2 mb-1 text-body-small text-medium-emphasis">
          <span class="day-label">{{ item.days === 1 ? dayLabel(item.first) : `${dayLabel(item.first)} to ${dayLabel(item.last)}` }}</span>
          <span>No history: it starts when the manager first sees the workload, and is kept for the manager's history_days.</span>
        </div>
        <div v-else data-test="day" class="d-flex align-center ga-2 mb-1">
          <span class="text-body-small text-medium-emphasis day-label">{{ dayLabel(item.row.day) }}</span>
          <div class="bar">
            <v-tooltip v-for="(s, i) in item.row.segments" :key="i" location="top" :text="segmentLabel(s.phase, s.merged)">
              <template #activator="{ props: tip }">
                <div v-bind="tip" data-test="segment" :aria-label="segmentLabel(s.phase, s.merged)" tabindex="0"
                  :class="['segment', `bg-${stateColor(s.state)}`]" :style="{ left: `${s.left}%`, width: `${s.width}%` }" />
              </template>
            </v-tooltip>
          </div>
        </div>
      </template>
      <div class="d-flex flex-wrap ga-3 mt-2 text-body-small text-medium-emphasis">
        <span v-for="state in LEGEND" :key="state" class="d-inline-flex align-center ga-1"><span :class="['swatch', `bg-${stateColor(state)}`]" />{{ stateLabel(state) }}</span>
      </div>
      <v-table v-if="transitions.length" density="compact" class="mt-3">
        <thead><tr><th>When</th><th>Change</th><th>Why</th><th>Wake</th></tr></thead>
        <tbody>
          <tr v-for="t in transitions" :key="`${t.at}#${t.to}`" data-test="transition">
            <td class="text-no-wrap">{{ when(t.at) }}</td>
            <td class="text-no-wrap">{{ t.from ?? 'first seen' }} → {{ t.to }}</td>
            <td>{{ causeText({ state: t.to, cause: t.cause, by: t.by, inferred: t.inferred, first: t.from === null }) }}<template v-if="t.failure">: {{ t.failure.message }}</template></td>
            <td class="text-no-wrap">{{ t.durationMs ? duration(Math.round(t.durationMs / 1000)) : '' }}</td>
          </tr>
        </tbody>
      </v-table>
    </v-card-text>
    <v-progress-linear v-else indeterminate color="primary" />
  </v-card>
</template>

<style scoped>
.day-label { width: 92px; flex: none; }
.ticks { position: relative; flex: 1; height: 18px; }
.ticks span { position: absolute; top: 0; }
/* Napping shares waking's color (the state chips), lighter here to tell them apart. */
.bar { position: relative; flex: 1; height: 14px; border-radius: 3px; background: rgba(var(--v-theme-on-surface), 0.06); overflow: hidden; }
.segment { position: absolute; top: 0; bottom: 0; }
.swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; }
</style>
