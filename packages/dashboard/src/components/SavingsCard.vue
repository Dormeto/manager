<script setup lang="ts">
// The fleet's estimated savings (R9), from the daily job's summary: the last 30 days with a bar a day, this month, since
// the start, net of Dormeto's own cost, the workloads that save the most, and what the estimate does not count; the
// discounts for commitments, edited by administrators (R9.5).
import { computed, ref } from 'vue';
import { mdiPencil } from '@mdi/js';
import { api } from '../api';
import { usePoll } from '../poll';
import { usd } from '../format';
import { discountText } from '../costs';
import { useSession } from '../stores/session';
import DiscountsDialog from './DiscountsDialog.vue';
import type { Discounts, SavingsSettings, SavingsSummary } from '../types';

const session = useSession();
const summary = ref<SavingsSummary | null>(null);
const settings = ref<SavingsSettings | null>(null);
const loaded = ref(false);
const editing = ref(false);
const saveError = ref('');
async function load() {
  const answer = await api<{ summary?: SavingsSummary | null; settings?: SavingsSettings | null }>('/savings');
  summary.value = answer?.summary ?? null;
  settings.value = answer?.settings ?? null;
  loaded.value = true;
}
usePoll(load);
const NONE: Discounts = { compute: 0, databases: 0 };
const current = computed<Discounts>(() => (settings.value ? { compute: settings.value.compute, databases: settings.value.databases } : NONE));
const SPOT = 'Spot at Spot prices (Fargate Spot at 30% of on-demand).';
const discountsLine = computed(() => (current.value.compute || current.value.databases
  ? `Discounts: ${discountText(current.value)} off the list prices; ${SPOT}` : `No discount set; ${SPOT}`));
// The summary's days keep the discounts they were computed with (none before 0.8.0).
const pending = computed(() => {
  const used = summary.value?.discounts ?? NONE;
  return Boolean(summary.value) && (used.compute !== current.value.compute || used.databases !== current.value.databases);
});
async function save(discounts: Discounts) {
  saveError.value = '';
  try {
    await api('/savings/settings', { method: 'PUT', body: JSON.stringify(discounts) });
    editing.value = false;
    await load();
  } catch (err) {
    saveError.value = (err as Error).message;
  }
}
const day = (date: string) => new Date(`${date}T00:00:00.000Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
// The days the last 30 cover since the first one computed (review I7: Dormeto's cost for those days only).
const covered = computed(() => {
  const s = summary.value;
  if (!s) return 30;
  const days = Math.round((Date.parse(`${s.day}T00:00:00.000Z`) - Date.parse(`${s.cumulative.since}T00:00:00.000Z`)) / 86_400_000) + 1;
  return Math.max(1, Math.min(30, days));
});
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
        {{ usd(summary.last30.usd - (summary.dormeto.usdMonth * covered) / 30) }} over {{ covered === 30 ? 'the last 30 days' : `the ${covered} day${covered === 1 ? '' : 's'} computed` }}.</div>
      <v-list v-if="summary.top.length" density="compact" class="py-0">
        <v-list-item v-for="w in summary.top.slice(0, 5)" :key="`${w.router}/${w.workloadId}`" :to="`/workloads/${encodeURIComponent(w.router)}/${encodeURIComponent(w.workloadId)}`"
          :title="w.name ?? w.workloadId" :subtitle="w.router">
          <template #append><span class="text-body-medium">{{ usd(w.usd) }}</span></template>
        </v-list-item>
      </v-list>
      <div class="text-body-small text-medium-emphasis mt-2">AWS list prices of what the naps stopped, against {{ baseline }}. Storage, load balancers and
        data transfer keep running and are not counted; the discounts are an average rate.{{ unpriced }}</div>
    </v-card-text>
    <v-progress-linear v-else indeterminate color="primary" />
    <v-card-text v-if="loaded" class="d-flex align-center ga-2 pt-0 text-body-medium">
      <span data-test="discounts">{{ discountsLine }}<template v-if="pending"> Applies from the next day computed.</template></span>
      <v-btn v-if="session.isAdmin" data-test="edit-discounts" class="ml-auto" size="small" variant="text" :prepend-icon="mdiPencil" @click="editing = true">Edit</v-btn>
    </v-card-text>
    <v-alert v-if="saveError" type="error" density="compact" class="mx-4 mb-4" :text="saveError" />
    <DiscountsDialog v-model="editing" :discounts="current" @submit="save" />
  </v-card>
</template>

<style scoped>
.bars { display: flex; align-items: flex-end; gap: 2px; height: 48px; }
.bar { flex: 1; min-width: 2px; border-radius: 2px 2px 0 0; }
</style>
