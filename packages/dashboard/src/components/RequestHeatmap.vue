<script setup lang="ts">
// A workload's requests per hour, GitHub style (heatmap.ts): a row per local day, a column per hour, the greener the more
// requests. Read from its idle window advice (R10: the load balancer's RequestCount over the last 14 days, computed at most
// once a day), so it costs no other AWS call; the History card's states are another view of the same days.
import { computed, onMounted, ref } from 'vue';
import { readIdleWindow } from '../idle-window';
import { heatmap } from '../heatmap';
import DmLoader from './DmLoader.vue';
import type { IdleWindowAdvice } from '../types';

const props = defineProps<{ router: string; id: string }>();
const days = ref(7);
const advice = ref<IdleWindowAdvice | null>(null);
const error = ref('');
const loading = ref(true);
onMounted(async () => {
  try {
    advice.value = await readIdleWindow(props.router, props.id);
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
});

const map = computed(() => (advice.value?.hours?.counts.length ? heatmap(advice.value.hours, days.value) : null));
const count = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, word: string) => `${count(n)} ${word}${n === 1 ? '' : 's'}`;
const hourText = (h: number) => `${String(h).padStart(2, '0')}:00`;
const dayLabel = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
const cellLabel = (d: Date, hour: number, n: number | null) =>
  `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}, ${hourText(hour)} to ${hourText((hour + 1) % 24)}: ${n === null ? 'no data' : plural(n, 'request')}`;
const summary = computed(() => {
  const m = map.value;
  if (!m) return null;
  return {
    lead: plural(m.total, 'request'),
    rest: [
      `over ${days.value} days`,
      m.known ? `no request in ${m.quiet} of ${m.known} hours` : '',
      m.busiest ? `busiest ${dayLabel(m.busiest.day)} ${hourText(m.busiest.hour)} (${count(m.busiest.count)})` : '',
    ].filter(Boolean),
  };
});
const unknown = computed(() => Boolean(map.value?.rows.some((r) => r.cells.some((c) => c.count === null))));

// The hovered (or tapped) cell's day, hour and requests in a tooltip of the dashboard's style, kept inside the card: one
// for the whole grid rather than one per cell.
const wrap = ref<HTMLElement | null>(null);
const tip = ref<{ key: string; text: string; x: number; y: number } | null>(null);
function point(e: Event) {
  const cell = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-test="heat-cell"]');
  if (!cell || !wrap.value) { tip.value = null; return; }
  const box = wrap.value.getBoundingClientRect();
  const r = cell.getBoundingClientRect();
  const half = 120;
  const x = Math.min(Math.max(r.left + r.width / 2 - box.left, half), Math.max(half, box.width - half));
  tip.value = { key: cell.dataset.key ?? '', text: cell.dataset.tip ?? '', x, y: r.top - box.top };
}
</script>

<template>
  <v-card title="Requests" class="dm-heat">
    <template #append>
      <v-btn-toggle v-model="days" mandatory density="compact" variant="outlined" divided rounded="lg" class="dm-period" aria-label="Period">
        <v-btn :value="7" size="small">7 days</v-btn>
        <v-btn :value="14" size="small">14 days</v-btn>
      </v-btn-toggle>
    </template>
    <DmLoader v-if="loading" label="Reading the requests…" :size="48" />
    <v-card-text v-else-if="error">
      <v-alert type="warning" variant="tonal" density="compact">The requests cannot be read: {{ error }}</v-alert>
    </v-card-text>
    <v-card-text v-else-if="!map" data-test="heat-later" class="text-medium-emphasis">
      Requests per hour come with the next idle window advice, computed at most once a day.
    </v-card-text>
    <v-card-text v-else>
      <div v-if="summary" class="dm-heat__summary mb-4">
        <span class="dm-heat__lead">{{ summary.lead }}</span>
        <span class="text-medium-emphasis">{{ summary.rest.join(' · ') }}</span>
      </div>
      <div ref="wrap" class="dm-heat__wrap" @mouseover="point" @click="point" @mouseleave="tip = null">
      <div class="dm-heat__scroll">
        <div class="dm-heat__grid" role="img" :aria-label="`Requests per hour, last ${days} days: ${summary?.lead}, ${summary?.rest.join(', ')}`">
          <template v-for="(row, r) in map.rows" :key="row.day.getTime()">
            <span class="dm-heat__day text-body-small text-medium-emphasis" aria-hidden="true">{{ dayLabel(row.day) }}</span>
            <span v-for="c in row.cells" :key="c.hour" data-test="heat-cell" :data-level="c.count === null ? 'none' : c.level" aria-hidden="true"
              :data-key="`${r}-${c.hour}`" :data-tip="cellLabel(row.day, c.hour, c.count)"
              :class="['dm-heat__cell', c.count === null ? 'is-none' : `is-${c.level}`, { 'is-active': tip?.key === `${r}-${c.hour}` }]"
              :style="{ '--r': r, '--c': c.hour }" />
          </template>
          <span />
          <span v-for="h in [0, 6, 12, 18]" :key="h" class="dm-heat__tick" :style="{ gridColumn: `${h + 2} / span 6` }" aria-hidden="true">{{ hourText(h) }}</span>
        </div>
      </div>
      <div v-if="tip" data-test="heat-tip" class="dm-heat__tip" :style="{ left: `${tip.x}px`, top: `${tip.y}px` }" aria-hidden="true">{{ tip.text }}</div>
      </div>
      <div class="dm-heat__legend">
        <span>Less</span>
        <span v-for="l in [0, 1, 2, 3, 4]" :key="l" :class="['dm-heat__cell', 'dm-heat__swatch', `is-${l}`]" />
        <span>More</span>
        <template v-if="unknown"><span :class="['dm-heat__cell', 'dm-heat__swatch', 'is-none']" class="ml-3" /><span>No data</span></template>
      </div>
      <div class="text-body-small text-medium-emphasis mt-2">The load balancer's requests (application and waker target groups) per hour, in your time zone:
        visitors and scanners alike, as the idle window advice replays them.</div>
    </v-card-text>
  </v-card>
</template>

<style scoped>
.dm-heat__summary { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; font-size: 0.92rem; }
.dm-heat__lead { font-size: 1.2rem; font-weight: 600; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.dm-heat__wrap { position: relative; }
.dm-heat__scroll { overflow-x: auto; }
.dm-heat__grid { display: grid; grid-template-columns: 64px repeat(24, minmax(12px, 1fr)); gap: 3px; align-items: center; min-width: 440px; }
.dm-heat__day { white-space: nowrap; font-variant-numeric: tabular-nums; }
.dm-heat__cell { display: block; aspect-ratio: 1.25; border-radius: 3px; background: rgba(var(--v-theme-on-surface), 0.07); transition: filter 0.2s, box-shadow 0.2s;
  animation: dm-heat-in 0.45s var(--dm-ease) backwards; animation-delay: calc(var(--r, 0) * 40ms + var(--c, 0) * 8ms); }
/* The pointed cell: a ring drawn inside it, so nothing around it (the next cells, the scrolling box) cuts it. */
.dm-heat__grid .dm-heat__cell:hover, .dm-heat__cell.is-active { filter: brightness(1.2); box-shadow: inset 0 0 0 2px rgba(var(--v-theme-on-surface), 0.85); }
.dm-heat__tip { position: absolute; z-index: 2; transform: translate(-50%, calc(-100% - 8px)); pointer-events: none; white-space: nowrap; padding: 6px 10px; border-radius: 10px;
  background: rgba(13, 20, 34, 0.96); color: #edf1f8; border: 1px solid rgba(255, 255, 255, 0.1); font-size: 0.82rem; box-shadow: 0 12px 28px -14px rgba(0, 0, 0, 0.7); }
.dm-heat__cell.is-1 { background: rgba(var(--v-theme-success), 0.28); }
.dm-heat__cell.is-2 { background: rgba(var(--v-theme-success), 0.5); }
.dm-heat__cell.is-3 { background: rgba(var(--v-theme-success), 0.74); }
.dm-heat__cell.is-4 { background: rgb(var(--v-theme-success)); }
.dm-heat__cell.is-none { background: transparent; box-shadow: inset 0 0 0 1px rgba(var(--v-theme-on-surface), 0.12); }
.dm-heat__tick { font: 500 0.66rem/1 var(--dm-mono); letter-spacing: 0.06em; color: rgba(var(--v-theme-on-surface), 0.55); padding-top: 4px; }
.dm-heat__legend { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 14px; font-size: 0.8rem; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.dm-heat__legend > span:first-child { margin-right: 4px; }
.dm-heat__swatch { width: 12px; animation: none; }
.dm-heat__swatch + span:not(.dm-heat__swatch) { margin-left: 4px; }
.dm-period :deep(.v-btn) { font-weight: 500; }
@keyframes dm-heat-in { from { opacity: 0; transform: scale(0.6); } }
@media (prefers-reduced-motion: reduce) { .dm-heat__cell { animation: none; transition: none; } }
</style>
