<script setup lang="ts">
// A workload's time in each state over the last 7 days, from its history (user request): the bar of its Workloads row and
// of its view's header, in the history's colors and order. Its tooltip gives each state's share of the time with history,
// its time and what it means, the time without history, the hours without requests (discovery), what its naps saved in the
// last 30 days and a month's saving at that rate (user request).
import { computed } from 'vue';
import { idleText } from '../discovery';
import { monthlySaving } from '../costs';
import { longDuration, stateColor, usd } from '../format';
import type { Costs } from '../types';
import { STATE_ORDER, stateLabel } from '../history';
import { stateBrief } from '../state';

const props = withDefaults(defineProps<{
  states?: { from: string; to: string; totals: Record<string, number> } | null;
  idleHours7d?: number | null;
  requests7d?: number | null;
  costs?: Costs | null;
  width?: number;
}>(), { states: null, idleHours7d: null, requests7d: null, costs: null, width: 100 });

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
  ? `Last 7 days${unknown.value ? ', of the time with history' : ''}`
  : 'No history yet: it starts when the manager first sees the workload.'));
const label = computed(() => `Last 7 days: ${rows.value.length ? rows.value.map((r) => `${stateLabel(r.state).toLowerCase()} ${r.share}`).join(', ') : 'no history yet'}`);
const saved = computed(() => {
  const s = props.costs?.saved;
  if (!s) return null;
  if (!s.usd && s.unpricedHours) return 'Saved in the last 30 days: not priced yet';
  return `Saved in the last 30 days: about ${usd(s.usd)}${s.unpricedHours ? ', part not priced' : ''}`;
});
const monthly = computed(() => {
  const m = monthlySaving(props.costs);
  return m === null ? null : `Estimated saving: about ${usd(m)} a month at that rate`;
});
const idle = computed(() => (typeof props.idleHours7d === 'number' ? `Requests: ${idleText({ idleHours7d: props.idleHours7d, requests7d: props.requests7d }).detail}` : null));
</script>

<template>
  <v-tooltip location="bottom" max-width="600">
    <template #activator="{ props: tip }">
      <div v-bind="tip" data-test="state-bar" class="state-bar" :style="{ width: `${width}px` }" tabindex="0" role="img" :aria-label="label">
        <div class="track">
          <div v-for="r in rows" :key="r.state" data-test="state-segment" :class="['segment', `bg-${stateColor(r.state)}`]" :style="{ width: `${r.width}%` }" />
        </div>
      </div>
    </template>
    <div class="font-weight-bold mb-1">{{ title }}</div>
    <table v-if="rows.length" class="rows">
      <tr v-for="r in rows" :key="r.state">
        <td class="text-no-wrap"><span :class="['swatch', `bg-${stateColor(r.state)}`]" />{{ stateLabel(r.state) }}</td>
        <td class="num text-no-wrap">{{ r.share }}</td>
        <td class="num text-no-wrap">{{ longDuration(r.seconds) }}</td>
        <td class="note">{{ stateBrief(r.state) }}</td>
      </tr>
    </table>
    <div v-if="rows.length && unknown" class="mt-1 note">No history for {{ longDuration(unknown) }} of the 7 days.</div>
    <div v-if="saved" class="mt-1">{{ saved }}</div>
    <div v-if="monthly">{{ monthly }}</div>
    <div v-if="saved || monthly" class="note">Estimates: AWS on-demand list prices of what the naps stopped, for the time asleep the baseline would have run.</div>
    <div v-if="idle" class="mt-1 note">{{ idle }}</div>
  </v-tooltip>
</template>

<style scoped>
.state-bar { padding: 6px 0; flex: none; }
.track { display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: rgba(var(--v-theme-on-surface), 0.12); }
.segment { flex: none; height: 100%; }
.rows td { padding: 1px 12px 1px 0; vertical-align: middle; }
.num { text-align: right; }
.swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
.note { opacity: 0.8; }
</style>
