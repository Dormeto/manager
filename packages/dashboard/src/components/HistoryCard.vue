<script setup lang="ts">
// A workload's state history (R8): the time in each state over a period, a row per local day of its phases, and its
// transitions with what started them. Read from the manager's store, polled with the page.
import { computed, ref, watch } from 'vue';
import { api } from '../api';
import { usePoll } from '../poll';
import { duration, stateColor, usd } from '../format';
import DmLoader from './DmLoader.vue';
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
    ...(!h.savings ? [] : h.savings.items.length ? [`saved about ${usd(h.savings.usd)} (estimate${h.savings.discounts ? ', after discounts' : ''})${h.savings.unpriced.length ? ', part not priced' : ''}`]
      : h.savings.unpriced.length ? ['savings not priced yet'] : []),
  ];
});
const transitions = computed(() => [...(history.value?.entries ?? [])].reverse().slice(0, 50));
const LEGEND = STATE_ORDER;
</script>

<template>
  <v-card title="History" class="dm-history">
    <template #append>
      <v-btn-toggle v-model="days" mandatory density="compact" variant="outlined" divided rounded="lg" class="dm-period" aria-label="Period">
        <v-btn :value="1" size="small">24 hours</v-btn>
        <v-btn :value="7" size="small">7 days</v-btn>
        <v-btn :value="30" size="small">30 days</v-btn>
      </v-btn-toggle>
    </template>
    <v-card-text v-if="error" class="text-error">{{ error }}</v-card-text>
    <v-card-text v-else-if="history?.phases">
      <div class="dm-history__summary mb-4">
        <span class="dm-history__lead">{{ summary[0] }}</span>
        <span v-if="summary.length > 1" class="text-medium-emphasis">{{ summary.slice(1).join(' · ') }}</span>
      </div>
      <v-alert v-if="history.truncated" type="info" variant="tonal" density="compact" class="mb-2" text="More than 5,000 changes in this period: only the latest are drawn, the time before them is unknown." />
      <div class="d-flex ga-3 dm-history__axis">
        <span class="day-label" />
        <div class="ticks"><span v-for="(h, i) in ['00:00', '06:00', '12:00', '18:00']" :key="h" :style="{ left: `${i * 25}%` }">{{ h }}</span></div>
      </div>
      <div class="dm-history__days">
        <template v-for="(item, index) in rows" :key="item.kind === 'day' ? item.row.day.getTime() : `gap-${item.first.getTime()}`">
          <div v-if="item.kind === 'gap'" data-test="gap" class="d-flex align-center ga-3 dm-history__row text-body-small text-medium-emphasis">
            <span class="day-label">{{ item.days === 1 ? dayLabel(item.first) : `${dayLabel(item.first)} to ${dayLabel(item.last)}` }}</span>
            <span class="dm-history__gap">No history: it starts when the manager first sees the workload, and is kept for the manager's history_days.</span>
          </div>
          <div v-else data-test="day" class="d-flex align-center ga-3 dm-history__row">
            <span class="text-body-small text-medium-emphasis day-label">{{ dayLabel(item.row.day) }}</span>
            <div class="bar" :style="{ '--row': index }">
              <v-tooltip v-for="(s, i) in item.row.segments" :key="i" location="top" :text="segmentLabel(s.phase, s.merged)">
                <template #activator="{ props: tip }">
                  <div v-bind="tip" data-test="segment" :aria-label="segmentLabel(s.phase, s.merged)" tabindex="0"
                    :class="['segment', `bg-${stateColor(s.state)}`]" :style="{ left: `${s.left}%`, width: `${s.width}%` }" />
                </template>
              </v-tooltip>
            </div>
          </div>
        </template>
      </div>
      <div class="dm-history__legend">
        <span v-for="state in LEGEND" :key="state" class="d-inline-flex align-center ga-2"><span :class="['swatch', `bg-${stateColor(state)}`]" />{{ stateLabel(state) }}</span>
      </div>
      <div v-if="transitions.length" class="dm-history__changes">
        <v-table density="compact" fixed-header>
          <thead><tr><th>When</th><th>Change</th><th>Why</th><th class="text-end">Wake</th></tr></thead>
          <tbody>
            <tr v-for="t in transitions" :key="`${t.at}#${t.to}`" data-test="transition">
              <td class="text-no-wrap text-medium-emphasis dm-num">{{ when(t.at) }}</td>
              <td class="text-no-wrap"><span class="dm-change">{{ t.from ?? 'first seen' }} <span class="dm-change__arrow">→</span> <span :class="['swatch', 'mr-1', `bg-${stateColor(t.to)}`]" />{{ t.to }}</span></td>
              <td>{{ causeText({ state: t.to, cause: t.cause, by: t.by, inferred: t.inferred, first: t.from === null, hibernated: t.hibernated }) }}<template v-if="t.failure">: {{ t.failure.message }}</template></td>
              <td class="text-no-wrap text-end dm-num">{{ t.durationMs ? duration(Math.round(t.durationMs / 1000)) : '' }}</td>
            </tr>
          </tbody>
        </v-table>
      </div>
    </v-card-text>
    <DmLoader v-else label="Reading the history…" :size="48" />
  </v-card>
</template>

<style scoped>
.dm-history__summary { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; font-size: 0.92rem; }
.dm-history__lead { font-size: 1.2rem; font-weight: 600; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.dm-history__axis { font: 500 0.66rem/1 var(--dm-mono); letter-spacing: 0.06em; color: rgba(var(--v-theme-on-surface), 0.55); margin-bottom: 6px; }
.dm-history__days { display: grid; gap: 5px; }
.dm-history__row { min-height: 14px; }
.dm-history__gap { font-style: italic; opacity: 0.85; }
.day-label { width: 92px; flex: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.ticks { position: relative; flex: 1; height: 14px; }
.ticks span { position: absolute; top: 0; }
.ticks span::before { content: ""; position: absolute; left: 0; top: 12px; width: 1px; height: 4px; background: rgba(var(--v-theme-on-surface), 0.25); }
/* A day's phases on a rounded track; napping shares waking's hue, lighter, to tell them apart. Each row is revealed from
   the left, one after the other. */
.bar { position: relative; flex: 1; height: 12px; border-radius: 999px; background: rgba(var(--v-theme-on-surface), 0.06); overflow: hidden;
  animation: dm-reveal 0.9s var(--dm-ease) both; animation-delay: calc(var(--row, 0) * 45ms); }
.segment { position: absolute; top: 0; bottom: 0; border-radius: 3px; outline: none; transition: filter 0.2s, box-shadow 0.2s; }
.segment:hover { filter: brightness(1.18); }
.segment:focus-visible { box-shadow: inset 0 0 0 2px rgb(var(--v-theme-on-surface)); }
@keyframes dm-reveal { from { clip-path: inset(0 100% 0 0 round 999px); } to { clip-path: inset(0 0 0 0 round 999px); } }
.dm-history__legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 14px; font-size: 0.8rem; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.swatch { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
.dm-history__changes { margin-top: 18px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 14px; overflow: hidden; }
.dm-history__changes :deep(.v-table__wrapper) { max-height: 340px; }
.dm-history__changes :deep(thead th) { background: rgb(var(--v-theme-surface)) !important; }
.dm-num { font-variant-numeric: tabular-nums; }
.dm-change { font: 500 0.74rem/1 var(--dm-mono); letter-spacing: 0.02em; }
.dm-change__arrow { opacity: 0.5; }
.dm-period :deep(.v-btn) { font-weight: 500; }
@media (prefers-reduced-motion: reduce) { .bar { animation: none; } }
@media (max-width: 600px) { .day-label { width: 74px; } }
</style>
