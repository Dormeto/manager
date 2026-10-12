<script setup lang="ts">
// A workload's idle window advice (R10): its last 14 days of requests replayed against idle windows from 5 to 120
// minutes, each window's savings a month (or hours asleep), wakes and wait a day, and the window at the knee recommended.
// The API computes it at most once a day: read once with the page.
import { computed, onMounted, ref } from 'vue';
import { api } from '../api';
import { duration, usd } from '../format';
import { adviceSentence, hoursText, perDay } from '../idle';
import type { IdleWindowAdvice, IdleWindowRow } from '../types';

const props = defineProps<{ router: string; id: string }>();
const advice = ref<IdleWindowAdvice | null>(null);
const error = ref('');
const loading = ref(true);
onMounted(async () => {
  try {
    const answer = await api<IdleWindowAdvice>(`/workloads/${encodeURIComponent(props.router)}/${encodeURIComponent(props.id)}/idle-window`);
    // An answer without windows is not drawn (it would fail the whole card).
    if (!Array.isArray(answer?.windows)) throw new Error('the manager answered something else');
    advice.value = answer;
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
});

// Each measure against its own column's largest value: two scales, never one axis.
const measure = (w: IdleWindowRow) => (advice.value?.priced ? w.usdMonth ?? 0 : w.asleepHours);
const peaks = computed(() => {
  const rows = advice.value?.windows ?? [];
  return { measure: Math.max(...rows.map(measure), 0.01), wakes: Math.max(...rows.map((w) => w.wakesPerDay), 0.01) };
});
const width = (v: number, peak: number) => (v > 0 ? `max(2px, ${(v / peak) * 100}%)` : '0');
// No request in 14 days: no wake for any window, and asleep about all the time.
const quiet = computed(() => Boolean(advice.value?.windows.every((w) => w.wakesPerDay === 0 && w.asleepHours >= 23.5)));
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
</script>

<template>
  <v-card title="Idle window">
    <v-card-text>
      <v-progress-linear v-if="loading" indeterminate />
      <v-alert v-else-if="error" type="warning" variant="tonal" density="compact">The advice cannot be computed: {{ error }}</v-alert>
      <template v-else-if="advice">
        <div class="text-body-1 mb-2">{{ adviceSentence(advice) }}.</div>
        <v-table density="compact">
          <thead>
            <tr>
              <th>Window</th>
              <th>{{ advice.priced ? 'Savings a month' : 'Asleep a day' }}</th>
              <th>Wakes a day</th>
              <th>Wait a day</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="w in advice.windows" :key="w.minutes" data-test="idle-row" :class="{ 'font-weight-bold': w.minutes === advice.recommended }">
              <td class="text-no-wrap">
                {{ w.minutes }} min
                <v-chip v-if="w.minutes === advice.current" size="x-small" class="ml-1">current</v-chip>
                <v-chip v-if="w.minutes === advice.recommended" size="x-small" color="primary" class="ml-1">recommended</v-chip>
              </td>
              <td>
                <div class="cell">
                  <span class="value">{{ advice.priced ? usd(w.usdMonth ?? 0) : hoursText(w.asleepHours) }}</span>
                  <span class="track"><span data-test="idle-bar" class="bar bg-success" :style="{ width: width(measure(w), peaks.measure) }" /></span>
                </div>
              </td>
              <td>
                <div class="cell">
                  <span class="value">{{ perDay(w.wakesPerDay) }}</span>
                  <span class="track"><span data-test="idle-bar" class="bar bg-warning" :style="{ width: width(w.wakesPerDay, peaks.wakes) }" /></span>
                </div>
              </td>
              <td class="text-no-wrap">{{ w.waitSecondsPerDay === null ? '—' : duration(Math.round(w.waitSecondsPerDay)) }}</td>
            </tr>
          </tbody>
        </v-table>
        <div class="text-body-small text-medium-emphasis mt-2 d-flex flex-column ga-1">
          <span v-if="quiet">No request in 14 days: the workload sleeps whatever the window.</span>
          <span v-if="advice.actual.noisy">The replay counts {{ advice.actual.replayedWakes }} wakes over the 14 days for {{ advice.actual.wakes }} that happened: requests the waker ignores (scanners, no-wake rules, IP lists) count here as wakes, so real wakes are fewer.</span>
          <span v-if="advice.wakeSeconds === null">No wake measured yet: the visitors' wait is unknown.</span>
          <span v-if="!advice.wakerTargetGroup">The waker target group was not found: only the requests while awake are replayed.</span>
          <span v-if="!advice.priced">Nothing priced yet (no nap described, or an item without a price): hours asleep instead of dollars.</span>
          <span>To change it: <code>idle_minutes</code> in the workload's Terraform module, or offboard the workload and onboard it again with the new window.</span>
          <span>Every request counts as activity and as a wake. Computed {{ when(advice.computedAt) }}, from the 14 days to {{ date(advice.to) }}.</span>
        </div>
      </template>
    </v-card-text>
  </v-card>
</template>

<style scoped>
.cell { display: flex; align-items: center; gap: 8px; }
.value { min-width: 4.5em; text-align: right; font-variant-numeric: tabular-nums; }
.track { flex: 1; min-width: 48px; display: flex; }
.bar { display: block; height: 8px; border-radius: 0 4px 4px 0; }
</style>
