<script setup lang="ts">
// A workload's state history (R8): the time in each state over a period, a row per local day drawn as a wave of its
// activity (the share of each quarter hour awake, over the line of sleep, the wakes as dots; each phase explained when
// pointed at), and its transitions with what started them. Read from the manager's store, polled with the page.
import { computed, ref, useId, watch } from 'vue';
import { api } from '../api';
import { usePoll } from '../poll';
import { duration, stateColor, usd } from '../format';
import DmLoader from './DmLoader.vue';
import { causeText, collapseRows, dayRows, dayWave, stateLabel, wavePaths, type Phase } from '../history';
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
// Each day's wave, by the day's time.
const waves = computed(() => {
  const h = history.value;
  const out = new Map<number, ReturnType<typeof wavePaths> & { wakes: number[]; failures: number[] }>();
  if (!h?.phases) return out;
  for (const item of rows.value) {
    if (item.kind !== 'day') continue;
    const w = dayWave(h.phases, item.row.day, h.from, h.to);
    out.set(item.row.day.getTime(), { ...wavePaths(w.shares), wakes: w.wakes, failures: w.failures });
  }
  return out;
});
const fill = `dm-wave-${useId()}`;
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
      <svg width="0" height="0" class="dm-history__defs" aria-hidden="true">
        <defs><linearGradient :id="fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" class="wave__stop wave__stop--top" /><stop offset="1" class="wave__stop" /></linearGradient></defs>
      </svg>
      <div class="dm-history__days">
        <template v-for="(item, index) in rows" :key="item.kind === 'day' ? item.row.day.getTime() : `gap-${item.first.getTime()}`">
          <div v-if="item.kind === 'gap'" data-test="gap" class="d-flex align-center ga-3 dm-history__row text-body-small text-medium-emphasis">
            <span class="day-label">{{ item.days === 1 ? dayLabel(item.first) : `${dayLabel(item.first)} to ${dayLabel(item.last)}` }}</span>
            <span class="dm-history__gap">No history: it starts when the manager first sees the workload, and is kept for the manager's history_days.</span>
          </div>
          <div v-else data-test="day" class="d-flex align-center ga-3 dm-history__row">
            <span class="text-body-small text-medium-emphasis day-label">{{ dayLabel(item.row.day) }}</span>
            <div class="wave" :style="{ '--row': index }">
              <svg v-if="waves.get(item.row.day.getTime())" class="wave__svg" viewBox="0 0 1440 30" preserveAspectRatio="none" aria-hidden="true">
                <path :d="waves.get(item.row.day.getTime())!.area" :fill="`url(#${fill})`" />
                <path :d="waves.get(item.row.day.getTime())!.line" class="wave__line" />
                <path :d="waves.get(item.row.day.getTime())!.sleep" class="wave__sleep" />
              </svg>
              <span v-for="x in waves.get(item.row.day.getTime())?.wakes" :key="`w${x}`" class="wave__dot bg-warning" :style="{ left: `${x * 100}%` }" />
              <span v-for="x in waves.get(item.row.day.getTime())?.failures" :key="`f${x}`" class="wave__dot wave__dot--failed bg-error" :style="{ left: `${x * 100}%` }" />
              <v-tooltip v-for="(s, i) in item.row.segments" :key="i" location="top" :text="segmentLabel(s.phase, s.merged)">
                <template #activator="{ props: tip }">
                  <div v-bind="tip" data-test="segment" :data-state="s.state" :aria-label="segmentLabel(s.phase, s.merged)" tabindex="0"
                    class="wave__hit" :style="{ left: `${s.left}%`, width: `${s.width}%` }" />
                </template>
              </v-tooltip>
            </div>
          </div>
        </template>
      </div>
      <div class="dm-history__legend">
        <span class="d-inline-flex align-center ga-2"><span class="swatch swatch--area" />Share of each quarter hour awake</span>
        <span class="d-inline-flex align-center ga-2"><span class="swatch swatch--line bg-info" />{{ stateLabel('ASLEEP') }}</span>
        <span class="d-inline-flex align-center ga-2"><span class="swatch bg-warning" />Wake</span>
        <span class="d-inline-flex align-center ga-2"><span class="swatch bg-error" />Failed</span>
        <span class="text-medium-emphasis">Point at a day for each change</span>
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
/* A day's wave: the share of each quarter hour awake as a green curve and the area under it, the line of sleep in blue
   where it slept, the wakes (and failures) as dots on it. Over it, a zone per phase explains it when pointed at. Each
   row is revealed from the left, one after the other. */
.wave { position: relative; flex: 1; height: 30px; animation: dm-reveal 0.9s var(--dm-ease) both; animation-delay: calc(var(--row, 0) * 45ms); }
.wave__svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
.wave__line { fill: none; stroke: rgb(var(--v-theme-success)); stroke-width: 1.8; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
.wave__sleep { fill: none; stroke: rgb(var(--v-theme-info)); stroke-opacity: 0.8; stroke-width: 2; stroke-linecap: round; vector-effect: non-scaling-stroke; }
.wave__stop { stop-color: rgb(var(--v-theme-success)); stop-opacity: 0.04; }
.wave__stop--top { stop-opacity: 0.5; }
.wave__dot { position: absolute; bottom: 0; width: 6px; height: 6px; margin-left: -3px; border-radius: 50%; pointer-events: none; box-shadow: 0 0 0 2px rgb(var(--v-theme-surface)); }
.wave__dot--failed { width: 8px; height: 8px; margin-left: -4px; bottom: -1px; }
.wave__hit { position: absolute; top: -2px; bottom: -2px; border-radius: 4px; outline: none; transition: background-color 0.15s; }
.wave__hit:hover { background: rgba(var(--v-theme-on-surface), 0.07); }
.wave__hit:focus-visible { box-shadow: inset 0 0 0 2px rgb(var(--v-theme-on-surface)); }
.dm-history__defs { position: absolute; }
@keyframes dm-reveal { from { clip-path: inset(0 100% 0 0 round 999px); } to { clip-path: inset(0 0 0 0 round 999px); } }
.dm-history__legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 14px; font-size: 0.8rem; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.swatch { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
.swatch--line { width: 14px; height: 2px; border-radius: 2px; }
.swatch--area { width: 14px; height: 10px; border-radius: 2px 2px 0 0; border-top: 2px solid rgb(var(--v-theme-success));
  background: linear-gradient(180deg, rgba(var(--v-theme-success), 0.6), rgba(var(--v-theme-success), 0.08)); }
.dm-history__changes { margin-top: 18px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 14px; overflow: hidden; }
.dm-history__changes :deep(.v-table__wrapper) { max-height: 340px; }
.dm-history__changes :deep(thead th) { background: rgb(var(--v-theme-surface)) !important; }
.dm-num { font-variant-numeric: tabular-nums; }
.dm-change { font: 500 0.74rem/1 var(--dm-mono); letter-spacing: 0.02em; }
.dm-change__arrow { opacity: 0.5; }
.dm-period :deep(.v-btn) { font-weight: 500; }
@media (prefers-reduced-motion: reduce) { .wave { animation: none; } }
@media (max-width: 600px) { .day-label { width: 74px; } }
</style>
