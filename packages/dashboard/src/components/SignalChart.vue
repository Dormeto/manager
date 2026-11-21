<script setup lang="ts">
// One idle signal of a standalone workload over its last days (vision standalone workloads design §6): its 5-minute values as a
// line (broken where a point is missing), its threshold as a dashed rule, the hours it was asleep shaded. In SVG, no library.
import { computed } from 'vue';
import type { IdleSignal } from '../types';
import { signalValue, thresholdText } from '../idle-settings';

const props = defineProps<{ signal: IdleSignal['signal']; name: string; values: (number | null)[]; below: number | null; from: string; to: string; asleep: { from: string; to: string }[] }>();
const W = 700;
const H = 84;
const PAD = 4;
const start = computed(() => Date.parse(props.from));
const span = computed(() => Math.max(1, Date.parse(props.to) - start.value));
const peak = computed(() => Math.max(...props.values.filter((v): v is number => v !== null), (props.below ?? 0) * 1.5, 1e-9));
const x = (i: number) => (i / Math.max(1, props.values.length - 1)) * W;
const y = (v: number) => H - PAD - (v / peak.value) * (H - 2 * PAD);
// The line in pieces: a missing point ends one.
const paths = computed(() => {
  const out: string[] = [];
  let d = '';
  props.values.forEach((v, i) => {
    if (v === null) {
      if (d) out.push(d);
      d = '';
      return;
    }
    d += `${d ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
  });
  if (d) out.push(d);
  return out;
});
const rule = computed(() => (props.below === null ? null : y(props.below)));
const bands = computed(() => props.asleep.map((p) => {
  const a = Math.max(0, (Date.parse(p.from) - start.value) / span.value) * W;
  const b = Math.min(1, (Date.parse(p.to) - start.value) / span.value) * W;
  return { x: a, width: Math.max(0, b - a) };
}).filter((b) => b.width > 0));
const label = computed(() => `${props.name} over 7 days: ${thresholdText(props.signal, props.below)} is idle`);
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
</script>

<template>
  <figure class="dm-signal">
    <figcaption class="dm-signal__head"><span class="dm-signal__name">{{ name }}</span><span class="text-medium-emphasis">{{ thresholdText(signal, below) }} · peak {{ signalValue(signal, peak) }}</span></figcaption>
    <svg data-test="signal-chart" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" role="img" :aria-label="label" class="dm-signal__svg">
      <rect v-for="(b, i) in bands" :key="i" data-test="asleep" :x="b.x" y="0" :width="b.width" :height="H" class="dm-signal__asleep" />
      <path v-for="(d, i) in paths" :key="i" data-test="line" :d="d" class="dm-signal__line" vector-effect="non-scaling-stroke" />
      <line v-if="rule !== null" data-test="threshold" x1="0" :x2="W" :y1="rule" :y2="rule" class="dm-signal__rule" vector-effect="non-scaling-stroke" />
    </svg>
    <div class="dm-signal__axis text-medium-emphasis"><span>{{ day(from) }}</span><span>{{ day(to) }}</span></div>
  </figure>
</template>

<style scoped>
.dm-signal { margin: 0 0 12px; }
.dm-signal__head { display: flex; justify-content: space-between; gap: 8px; font-size: 0.8rem; margin-bottom: 4px; }
.dm-signal__name { font-weight: 600; }
.dm-signal__svg { display: block; width: 100%; height: 84px; border-radius: 10px; background: rgba(var(--v-theme-on-surface), 0.03); }
.dm-signal__asleep { fill: rgba(var(--v-theme-moon), 0.18); }
.dm-signal__line { fill: none; stroke: rgb(var(--v-theme-primary)); stroke-width: 1.5; stroke-linejoin: round; }
.dm-signal__rule { stroke: rgb(var(--v-theme-warning)); stroke-width: 1.5; stroke-dasharray: 5 4; }
.dm-signal__axis { display: flex; justify-content: space-between; font: 500 0.66rem/1.4 var(--dm-mono); margin-top: 2px; }
</style>
