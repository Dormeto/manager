<script setup lang="ts">
// The fleet's estimated savings (R9), from the daily job's summary: the last 30 days with a bar a day, this month, since
// the start, net of Dormeto's own cost, the workloads that save the most, and what the estimate does not count.
import { computed, ref } from 'vue';
import { api } from '../api';
import { usePoll } from '../poll';
import { usd } from '../format';
import type { SavingsSummary } from '../types';

const summary = ref<SavingsSummary | null>(null);
const loaded = ref(false);
usePoll(async () => {
  summary.value = (await api<{ summary?: SavingsSummary | null }>('/savings'))?.summary ?? null;
  loaded.value = true;
});
const day = (date: string) => new Date(`${date}T00:00:00.000Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const peak = computed(() => Math.max(...(summary.value?.last30.days ?? []).map((d) => d.usd), 0.01));
const baseline = computed(() => (summary.value?.baseline.kind === 'business-hours' ? `business hours (weekdays 08:00 to 20:00, ${summary.value.baseline.timeZone})` : '24/7'));
const unpriced = computed(() => {
  const n = summary.value?.unpriced.workloads ?? 0;
  return n ? ` ${n} workload${n === 1 ? '' : 's'} not priced yet (a router before 0.27.0, or what AWS's list prices do not name).` : '';
});
</script>

<template>
  <v-card title="Savings (estimated)">
    <v-card-text v-if="loaded && !summary" class="text-medium-emphasis">No estimate yet: the first one is computed tonight at 00:30 UTC, from the
      history of the naps.</v-card-text>
    <v-card-text v-else-if="summary">
      <div class="d-flex flex-wrap align-end ga-6">
        <div>
          <div class="text-headline-large">{{ usd(summary.last30.usd) }}</div>
          <div class="text-body-small text-medium-emphasis">last 30 days, {{ Math.round(summary.last30.asleepHours).toLocaleString('en-US') }} hours asleep</div>
        </div>
        <div class="text-body-medium">this month {{ usd(summary.month.usd) }} · {{ usd(summary.cumulative.usd) }} since {{ day(summary.cumulative.since) }}</div>
      </div>
      <div class="bars my-3" role="img" :aria-label="`Savings by day, the last 30 days to ${day(summary.day)}`">
        <v-tooltip v-for="d in summary.last30.days" :key="d.date" location="top" :text="`${day(d.date)}: ${usd(d.usd)}`">
          <template #activator="{ props }"><span v-bind="props" data-test="bar" class="bar bg-success" :style="{ height: `${Math.max(2, (d.usd / peak) * 100)}%` }" /></template>
        </v-tooltip>
      </div>
      <div class="text-body-medium mb-2">Dormeto costs about {{ usd(summary.dormeto.usdMonth) }} a month: net about
        {{ usd(summary.last30.usd - summary.dormeto.usdMonth) }} over the last 30 days.</div>
      <v-list v-if="summary.top.length" density="compact" class="py-0">
        <v-list-item v-for="w in summary.top.slice(0, 5)" :key="`${w.router}/${w.workloadId}`" :to="`/workloads/${encodeURIComponent(w.router)}/${encodeURIComponent(w.workloadId)}`"
          :title="w.name ?? w.workloadId" :subtitle="w.router">
          <template #append><span class="text-body-medium">{{ usd(w.usd) }}</span></template>
        </v-list-item>
      </v-list>
      <div class="text-body-small text-medium-emphasis mt-2">AWS list prices of what the naps stopped, against {{ baseline }}. Storage, load balancers and
        data transfer keep running and are not counted; Savings Plans, Reserved Instances and Spot lower the real figure.{{ unpriced }}</div>
    </v-card-text>
    <v-progress-linear v-else indeterminate color="primary" />
  </v-card>
</template>

<style scoped>
.bars { display: flex; align-items: flex-end; gap: 2px; height: 48px; }
.bar { flex: 1; min-width: 2px; border-radius: 2px 2px 0 0; }
</style>
