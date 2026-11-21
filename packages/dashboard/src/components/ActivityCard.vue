<script setup lang="ts">
// A standalone workload's activity (vision standalone workloads design §4, §6): each idle signal of its status, its threshold,
// the level it comes from, its last value and since when it is under it (a signal that does not apply, why); when it may
// nap on idle; its resource missing. Its history (GET …/activity): each applying signal over 7 days against its threshold, the
// hours asleep shaded, and the idle window advice replayed on them (5 minutes to 24 hours); a read that failed says so.
import { computed, onMounted, provide, ref } from 'vue';
import { GIVEN_ADVICE } from '../idle-window';
import { api } from '../api';
import { STANDALONE_ROUTER } from '@dormeto/fleet/idle-signals';
import DmLoader from './DmLoader.vue';
import IdleWindowCard from './IdleWindowCard.vue';
import SignalChart from './SignalChart.vue';
import type { IdleSignal, IdleWindowAdvice } from '../types';
import { mdiChartTimelineVariant } from '@mdi/js';
import { duration, relative } from '../format';
import { signalName, signalValue, thresholdText } from '../idle-settings';
import { sourceText } from '../settings';
import type { WorkloadStatus } from '../types';
import type { Cloud } from '@dormeto/fleet/clouds';
import { cloudWords } from '../cloud-words';
import { rowCloud } from '../format';

// `cloud`: the workload's, its row's when not given: its words (cloud-words.ts) for its signals' delay and a missing resource.
const props = defineProps<{ status: WorkloadStatus; now: number; router?: string; id?: string; canApply?: boolean; source?: 'terraform' | 'manager' | 'cli'; cloud?: Cloud }>();
const words = computed(() => cloudWords(props.cloud ?? rowCloud(props.status)).standalone);
const emit = defineEmits<{ apply: [minutes: number] }>();
interface History {
  from: string; to: string; asleep: { from: string; to: string }[]; advice: IdleWindowAdvice | null; reason?: string;
  signals: { signal: IdleSignal['signal']; below: number | null; applies: boolean; reason?: string; values: (number | null)[] }[];
}
const history = ref<History | null>(null);
const historyError = ref('');
const reading = ref(false);
onMounted(async () => {
  if (!props.router || !props.id) return;
  reading.value = true;
  try {
    history.value = await api<History>(`/workloads/${encodeURIComponent(props.router)}/${encodeURIComponent(props.id)}/activity`);
  } catch (err) {
    historyError.value = (err as Error).message;
  } finally {
    reading.value = false;
  }
});
provide(GIVEN_ADVICE, () => history.value?.advice ?? null);
const charts = computed(() => (history.value?.signals ?? []).filter((s) => s.applies && s.values.length));
const sentence = (text: string) => `${text[0]!.toUpperCase()}${text.slice(1)}${text.endsWith('.') ? '' : '.'}`;
const metric = computed(() => props.status.settings.idleMetric);
// A signal that does not apply: off, or why not (the router's reason, said under the table).
const rows = computed(() => (props.status.idle ?? []).map((s) => ({
  key: s.signal,
  name: signalName(s.signal, metric.value),
  threshold: s.applies ? thresholdText(s.signal, s.below) : !s.reason || s.reason === 'off' ? 'off' : 'does not apply',
  from: sourceText(s.from, props.status.type),
  value: signalValue(s.signal, s.value),
  since: !s.applies ? '—' : s.underSince ? relative(s.underSince, props.now) : 'not under',
  reason: s.reason && s.reason !== 'off' ? s.reason : null,
})));
// As the HTTP page's Nap row says it.
const nap = computed(() => {
  const s = props.status;
  if (s.pauses?.length) return 'never while paused';
  if (!s.nap) return (s.idle ?? []).some((x) => x.applies) ? 'not while a signal is over its threshold' : 'never on idle: no idle signal applies (schedules and people only)';
  // The router's latest time: the signals read 10 minutes behind, at a check every 5 minutes (the review's M12).
  const latest = s.nap.latestAt ? `, at the latest ${new Date(s.nap.latestAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : '';
  return `${s.nap.inSeconds > 0 ? `eligible in ${duration(s.nap.inSeconds)}` : 'due at the next idle check (every 5 min)'}${latest}`;
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
      title="Its resource is missing">{{ words.missing }} {{ words.missingFix }}</v-alert>
    <v-table density="compact" class="dm-activity">
      <thead><tr><th>Signal</th><th>Threshold</th><th>From</th><th>Last value</th><th>Under since</th></tr></thead>
      <tbody>
        <tr v-for="r in rows" :key="r.key" data-test="signal" :class="{ 'text-medium-emphasis': r.threshold === 'off' }">
          <td>{{ r.name }}</td><td>{{ r.threshold }}</td><td>{{ r.from }}</td><td class="dm-num">{{ r.value }}</td><td>{{ r.since }}</td>
        </tr>
        <tr v-if="!rows.length"><td colspan="5" class="text-medium-emphasis">The router says no signal (a router before {{ STANDALONE_ROUTER }}).</td></tr>
      </tbody>
    </v-table>
    <p v-for="r in rows.filter((x) => x.reason)" :key="`${r.key}-reason`" class="text-body-small text-medium-emphasis px-4 mb-1">{{ r.name }}: {{ r.reason }}</p>
    <v-card-text class="text-body-medium" data-test="nap-estimate">Nap: {{ nap }}</v-card-text>
    <p class="text-body-small text-medium-emphasis px-4 mb-2">{{ words.signalsLate }}</p>
    <DmLoader v-if="reading" label="Reading its signals over 7 days…" :size="40" />
    <v-card-text v-else-if="historyError" class="pt-0">
      <v-alert data-test="activity-error" type="warning" variant="tonal" density="compact">No history: {{ historyError }}</v-alert>
    </v-card-text>
    <template v-else-if="history">
      <v-card-text v-if="!charts.length" data-test="activity-none" class="pt-0 text-body-medium text-medium-emphasis">{{ sentence(history.reason ?? 'no point to draw') }}</v-card-text>
      <v-card-text v-else class="pt-0">
        <div class="dm-eyebrow mb-2">Last 7 days</div>
        <SignalChart v-for="s in charts" :key="s.signal" :signal="s.signal" :name="signalName(s.signal, metric)" :values="s.values" :below="s.below" :from="history.from" :to="history.to" :asleep="history.asleep" />
        <p class="text-body-small text-medium-emphasis mb-0">The dashed rule is the threshold; the shaded hours, asleep.</p>
      </v-card-text>
      <IdleWindowCard v-if="history.advice" class="mx-4 mb-4" :router="router!" :id="id!" :source="source" :can-apply="canApply" :levels="true" @apply="emit('apply', $event)" />
    </template>
  </v-card>
</template>

<style scoped>
.dm-num { font-variant-numeric: tabular-nums; }
.dm-activity :deep(td), .dm-activity :deep(th) { white-space: nowrap; }
.dm-activity :deep(th) { font: 500 0.68rem/1.3 var(--dm-mono) !important; letter-spacing: 0.08em; text-transform: uppercase; }
</style>
