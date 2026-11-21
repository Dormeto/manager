<script setup lang="ts">
// A standalone workload's activity (vision standalone workloads design §4, §6): each idle signal of its status, its threshold,
// the level it comes from, its last value and since when it is under it (a signal that does not apply, why); when it may
// nap on idle; its resource missing. The 7 days' history comes with the Activity history (plan 2, M47).
import { computed } from 'vue';
import { mdiChartTimelineVariant } from '@mdi/js';
import { duration, relative } from '../format';
import { signalName, signalValue, thresholdText } from '../idle-settings';
import { sourceText } from '../settings';
import type { WorkloadStatus } from '../types';

const props = defineProps<{ status: WorkloadStatus; now: number }>();
const metric = computed(() => props.status.settings.idleMetric);
const REASONS: Record<string, string> = { off: 'off' };
const rows = computed(() => (props.status.idle ?? []).map((s) => ({
  key: s.signal,
  name: signalName(s.signal, metric.value),
  threshold: s.applies ? thresholdText(s.signal, s.below) : REASONS[s.reason ?? ''] ?? 'off',
  from: sourceText(s.from, props.status.type),
  value: signalValue(s.signal, s.value),
  since: !s.applies ? '—' : s.underSince ? relative(s.underSince, props.now) : 'not under',
  reason: s.applies ? null : s.reason && s.reason !== 'off' ? s.reason : null,
})));
// As the HTTP page's Nap row says it.
const nap = computed(() => {
  const s = props.status;
  if (s.pauses?.length) return 'never while paused';
  if (!s.nap) return (s.idle ?? []).some((x) => x.applies) ? 'not while a signal is over its threshold' : 'never on idle: no idle signal applies (schedules and people only)';
  return s.nap.inSeconds > 0 ? `eligible in ${duration(s.nap.inSeconds)}` : 'due at the next idle check (every 5 min)';
});
</script>

<template>
  <v-card data-test="activity">
    <v-card-item>
      <template #prepend><v-avatar color="secondary" variant="tonal" rounded="lg" size="36"><v-icon :icon="mdiChartTimelineVariant" size="20" /></v-avatar></template>
      <v-card-title>Activity</v-card-title>
      <v-card-subtitle class="text-wrap">Idle when every signal that applies stays under its threshold for the idle window</v-card-subtitle>
    </v-card-item>
    <v-alert v-if="status.resourceMissing" data-test="resource-missing" type="warning" variant="tonal" density="compact" class="mx-4 mb-2"
      title="Its resource is missing">It was deleted, or lost its <code>dormeto:workload</code> tag: nothing of it is stopped or started. Offboard the workload, or tag
      the resource again (its value is the workload's id): the router finds it at its next check.</v-alert>
    <v-table density="compact" class="dm-activity">
      <thead><tr><th>Signal</th><th>Threshold</th><th>From</th><th>Last value</th><th>Under since</th></tr></thead>
      <tbody>
        <tr v-for="r in rows" :key="r.key" data-test="signal" :class="{ 'text-medium-emphasis': r.threshold === 'off' }">
          <td>{{ r.name }}</td><td>{{ r.threshold }}</td><td>{{ r.from }}</td><td class="dm-num">{{ r.value }}</td><td>{{ r.since }}</td>
        </tr>
        <tr v-if="!rows.length"><td colspan="5" class="text-medium-emphasis">The router says no signal (a router before 0.42.0).</td></tr>
      </tbody>
    </v-table>
    <p v-for="r in rows.filter((x) => x.reason)" :key="`${r.key}-reason`" class="text-body-small text-medium-emphasis px-4 mb-1">{{ r.name }}: {{ r.reason }}</p>
    <v-card-text class="text-body-medium" data-test="nap-estimate">Nap: {{ nap }}</v-card-text>
  </v-card>
</template>

<style scoped>
.dm-num { font-variant-numeric: tabular-nums; }
.dm-activity :deep(th) { font: 500 0.68rem/1.3 var(--dm-mono) !important; letter-spacing: 0.08em; text-transform: uppercase; }
</style>
