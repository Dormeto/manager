<script setup lang="ts">
// A workload's idle window advice (R10): its last 14 days of requests replayed against idle windows from 5 to 120
// minutes, each window's savings a month (or hours asleep), wakes and wait a day, and the window at the knee recommended.
// The API computes it at most once a day: read once with the page.
import { computed, onMounted, ref } from 'vue';
import { duration, usd } from '../format';
import { adviceSentence, hoursText, perDay } from '../idle';
import { readIdleWindow } from '../idle-window';
import { mdiLightbulbOnOutline } from '@mdi/js';
import DmLoader from './DmLoader.vue';
import type { IdleWindowAdvice, IdleWindowRow } from '../types';

const props = defineProps<{ router: string; id: string }>();
const advice = ref<IdleWindowAdvice | null>(null);
const error = ref('');
const loading = ref(true);
onMounted(async () => {
  try {
    const answer = await readIdleWindow(props.router, props.id);
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
  <v-card title="Idle window" class="dm-idle">
    <DmLoader v-if="loading" label="Replaying the requests…" :size="48" />
    <v-card-text v-else>
      <v-alert v-if="error" type="warning" variant="tonal" density="compact">The advice cannot be computed: {{ error }}</v-alert>
      <template v-else-if="advice">
        <div class="dm-idle__advice mb-4">
          <v-avatar color="primary" variant="tonal" rounded="lg" size="34"><v-icon :icon="mdiLightbulbOnOutline" size="18" /></v-avatar>
          <div class="text-body-1">{{ adviceSentence(advice) }}.</div>
        </div>
        <div class="dm-idle__table">
          <v-table density="compact">
            <thead>
              <tr>
                <th>Window</th>
                <th>{{ advice.priced ? 'Savings a month' : 'Asleep a day' }}</th>
                <th>Wakes a day</th>
                <th class="text-end">Wait a day</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(w, i) in advice.windows" :key="w.minutes" data-test="idle-row" :style="{ '--row': i }"
                :class="{ 'font-weight-bold': w.minutes === advice.recommended, 'dm-idle__row--recommended': w.minutes === advice.recommended, 'dm-idle__row--current': w.minutes === advice.current }">
                <td class="text-no-wrap">
                  <span class="dm-num">{{ w.minutes }} min</span>
                  <v-chip v-if="w.minutes === advice.current" size="x-small" variant="outlined" label class="ml-2">current</v-chip>
                  <v-chip v-if="w.minutes === advice.recommended" size="x-small" color="primary" variant="flat" label class="ml-2">recommended</v-chip>
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
                <td class="text-no-wrap text-end dm-num">{{ w.waitSecondsPerDay === null ? '—' : duration(Math.round(w.waitSecondsPerDay)) }}</td>
              </tr>
            </tbody>
          </v-table>
        </div>
        <div class="dm-idle__notes text-body-small text-medium-emphasis mt-3">
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
.dm-idle__advice { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 14px;
  background: rgba(var(--v-theme-primary), 0.07); border: 1px solid rgba(var(--v-theme-primary), 0.18); }
.dm-idle__table { border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 14px; overflow: hidden; }
.dm-idle__table :deep(.v-table__wrapper) { overflow-x: auto; }
.dm-idle__row--current td { background: rgba(var(--v-theme-on-surface), 0.03); }
.dm-idle__row--recommended td { background: rgba(var(--v-theme-primary), 0.08); }
.dm-idle__row--recommended td:first-child { box-shadow: inset 3px 0 0 rgb(var(--v-theme-primary)); }
.cell { display: flex; align-items: center; gap: 10px; }
.value { min-width: 4.5em; text-align: right; font-variant-numeric: tabular-nums; }
.dm-num { font-variant-numeric: tabular-nums; }
/* Each measure on its own rounded track, growing in row after row. */
.track { flex: 1; min-width: 48px; display: flex; height: 8px; border-radius: 999px; background: rgba(var(--v-theme-on-surface), 0.07); overflow: hidden; }
.bar { display: block; height: 100%; border-radius: 999px; transform-origin: left center;
  animation: dm-grow 0.8s var(--dm-ease) both; animation-delay: calc(var(--row, 0) * 40ms); }
@keyframes dm-grow { from { transform: scaleX(0); } }
.dm-idle__notes { display: flex; flex-direction: column; gap: 4px; }
@media (prefers-reduced-motion: reduce) { .bar { animation: none; } }
</style>
