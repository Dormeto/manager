<script setup lang="ts">
// A workload's time in each state over the last 7 days, from its history (user request): the bar of its Workloads row and
// of its view's header, in the history's colors and order. Its tooltip gives each state's share of the time with history,
// its time and what it means, the time without history, the hours without requests (discovery), the base cost of what the
// naps stop, what they saved in the last 30 days and a month's saving at that rate (user request). With a title and a
// note, the bar of all workloads. block: as wide as its parent; legend: each state's share under the bar.
import { computed } from 'vue';
import { idleText } from '../discovery';
import { MONTH_HOURS, discountText, type BarSavings } from '../costs';
import { longDuration, stateColor, usd, usdHourly } from '../format';
import { STATE_ORDER, stateLabel } from '../history';
import { stateBrief } from '../state';

const props = withDefaults(defineProps<{
  states?: { from: string; to: string; totals: Record<string, number> } | null;
  idleHours7d?: number | null;
  requests7d?: number | null;
  savings?: BarSavings | null;
  title?: string;
  note?: string | null;
  width?: number;
  block?: boolean;
  legend?: boolean;
  height?: number;
}>(), { states: null, idleHours7d: null, requests7d: null, savings: null, title: 'Last 7 days', note: null, width: 100, block: false, legend: false, height: 8 });

// The narrowest a state is drawn, in percent of the bar: a few minutes of waking in a week stay visible.
const MIN_WIDTH = 1;
const share = (part: number, total: number) => {
  const p = Math.round((100 * part) / total);
  return part > 0 && p < 1 ? '<1 %' : `${p} %`;
};

const unknown = computed(() => props.states?.totals.UNKNOWN ?? 0);
const rows = computed(() => {
  const totals = props.states?.totals ?? {};
  const known = STATE_ORDER.filter((state) => state !== 'UNKNOWN' && (totals[state] ?? 0) > 0).map((state) => ({ state, seconds: totals[state]! }));
  const total = known.reduce((n, r) => n + r.seconds, 0);
  // The short ones drawn at the narrowest width, the others share the rest in proportion.
  const short = known.filter((r) => (100 * r.seconds) / total < MIN_WIDTH);
  const rest = total - short.reduce((n, r) => n + r.seconds, 0);
  return known.map((r) => ({
    ...r, share: share(r.seconds, total), width: short.includes(r) ? MIN_WIDTH : (r.seconds / rest) * (100 - MIN_WIDTH * short.length),
  }));
});
const title = computed(() => (rows.value.length
  ? `${props.title}${unknown.value ? ', of the time with history' : ''}`
  : 'No history yet: it starts when the manager first sees the workload.'));
const label = computed(() => `${props.title}: ${rows.value.length ? rows.value.map((r) => `${stateLabel(r.state).toLowerCase()} ${r.share}`).join(', ') : 'no history yet'}`);
const base = computed(() => {
  const h = props.savings?.hourly;
  return typeof h === 'number' ? `Base cost of what the naps stop: ${usdHourly(h)} an hour · ${usd(h * MONTH_HOURS)} a month` : null;
});
const saved = computed(() => {
  const s = props.savings?.saved;
  if (!s) return null;
  if (!s.usd && s.unpricedHours) return 'Saved in the last 30 days: not priced yet';
  return `Saved in the last 30 days: about ${usd(s.usd)}${s.unpricedHours ? ', part not priced' : ''}`;
});
const monthly = computed(() => {
  const m = props.savings?.monthly;
  return typeof m === 'number' ? `Estimated saving: about ${usd(m)} a month at that rate` : null;
});
// R9.5: Spot at Spot prices, the discounts when set.
const estimates = computed(() => `Estimates: AWS list prices of what the naps stopped, Spot at Spot prices${props.savings?.discounts ? `, after discounts (${discountText(props.savings.discounts)})` : ''}, for the time asleep the baseline would have run.`);
const idle = computed(() => (typeof props.idleHours7d === 'number' ? `Requests: ${idleText({ idleHours7d: props.idleHours7d, requests7d: props.requests7d }).detail}` : null));
</script>

<template>
  <div :class="['dm-sb', { 'dm-sb--block': block }]" :style="block ? undefined : { width: `${width}px` }">
    <v-tooltip location="bottom" max-width="600">
      <template #activator="{ props: tip }">
        <div v-bind="tip" data-test="state-bar" class="state-bar" tabindex="0" role="img" :aria-label="label">
          <div :class="['track', { 'track--empty': !rows.length }]" :style="{ height: `${height}px` }">
            <div v-for="(r, i) in rows" :key="r.state" data-test="state-segment" :class="['segment', `bg-${stateColor(r.state)}`]" :style="{ width: `${r.width}%`, '--i': i }" />
          </div>
        </div>
      </template>
      <div class="font-weight-bold mb-1">{{ title }}</div>
      <table v-if="rows.length" class="rows"><tbody>
        <tr v-for="r in rows" :key="r.state">
          <td class="text-no-wrap"><span :class="['swatch', `bg-${stateColor(r.state)}`]" />{{ stateLabel(r.state) }}</td>
          <td class="num text-no-wrap">{{ r.share }}</td>
          <td class="num text-no-wrap">{{ longDuration(r.seconds) }}</td>
          <td class="note">{{ stateBrief(r.state) }}</td>
        </tr>
      </tbody></table>
      <div v-if="rows.length && unknown" class="mt-1 note">No history for {{ longDuration(unknown) }} of the 7 days.</div>
      <div v-if="base" class="mt-1">{{ base }}</div>
      <div v-if="saved" :class="{ 'mt-1': !base }">{{ saved }}</div>
      <div v-if="monthly">{{ monthly }}</div>
      <div v-if="saved || monthly" class="note">{{ estimates }}</div>
      <div v-if="idle" class="mt-1 note">{{ idle }}</div>
      <div v-if="note" class="mt-1 note">{{ note }}</div>
    </v-tooltip>
    <div v-if="legend && rows.length" class="legend" aria-hidden="true">
      <span v-for="r in rows" :key="r.state" class="legend__item">
        <span :class="['legend__dot', `bg-${stateColor(r.state)}`]" />{{ stateLabel(r.state) }}<span class="legend__share">{{ r.share }}</span>
      </span>
    </div>
  </div>
</template>

<style scoped>
.dm-sb { flex: none; min-width: 0; }
.dm-sb--block { flex: 1 1 auto; width: 100%; }
.state-bar { padding: 6px 0; border-radius: 6px; outline: none; cursor: default; }
.state-bar:focus-visible { box-shadow: 0 0 0 2px rgb(var(--v-theme-secondary)); }
/* Rounded segments a hair apart; the short ones keep a few pixels, the long ones give them up. */
.track { display: flex; gap: 2px; border-radius: 999px; overflow: hidden; }
.track--empty { background: repeating-linear-gradient(90deg, rgba(var(--v-theme-on-surface), 0.12) 0 6px, transparent 6px 10px); }
.segment { flex: 0 1 auto; min-width: 3px; height: 100%; border-radius: 3px; transform-origin: left center;
  animation: dm-seg-in 0.8s var(--dm-ease) both; animation-delay: calc(var(--i) * 70ms); transition: filter 0.2s; }
.segment:first-child { border-top-left-radius: 999px; border-bottom-left-radius: 999px; }
.segment:last-child { border-top-right-radius: 999px; border-bottom-right-radius: 999px; }
.state-bar:hover .segment, .state-bar:focus-visible .segment { filter: brightness(1.12) saturate(1.1); }
@keyframes dm-seg-in { from { opacity: 0; transform: scaleX(0.2); } }
.legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 6px; font-size: 0.78rem; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.legend__item { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.legend__dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.legend__share { font-variant-numeric: tabular-nums; color: rgba(var(--v-theme-on-surface), var(--v-high-emphasis-opacity)); font-weight: 500; }
.rows td { padding: 1px 12px 1px 0; vertical-align: middle; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.swatch { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
.note { opacity: 0.8; }
@media (prefers-reduced-motion: reduce) { .segment { animation: none; } }
</style>
