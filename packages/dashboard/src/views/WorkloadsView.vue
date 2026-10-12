<script setup lang="ts">
import { useNow } from '../now';
import { useDisplay } from 'vuetify';
import { ref } from 'vue';
import { mdiMagnify, mdiOpenInNew } from '@mdi/js';
import { api } from '../api';
import { usePoll } from '../poll';
import { checkHealth, relative } from '../format';
import PauseChip from '../components/PauseChip.vue';
import StateChip from '../components/StateChip.vue';
import RefreshIndicator from '../components/RefreshIndicator.vue';
import type { RouterInfo, WorkloadSummary } from '../types';

const now = useNow();
const { smAndDown } = useDisplay();
const workloads = ref<WorkloadSummary[]>([]);
const errors = ref<{ router: string; message: string }[]>([]);
const search = ref('');
const late = ref<RouterInfo[]>([]);
let routersCheckedAt = 0;
const { error, loading, nextAt, run } = usePoll(async () => {
  const result = await api<{ workloads: WorkloadSummary[]; errors: { router: string; message: string }[] }>('/workloads');
  workloads.value = result.workloads;
  errors.value = result.errors;
  // Router health every minute is enough: the warning is about checks late by 15 minutes.
  if (Date.now() - routersCheckedAt > 60_000) {
    routersCheckedAt = Date.now();
    late.value = (await api<{ routers: RouterInfo[] }>('/routers')).routers.filter((r) => !r.error && checkHealth(r, now.value).late);
  }
});

const headers = [
  { title: 'Workload', key: 'workloadId' },
  { title: 'Router', key: 'router' },
  { title: 'State', key: 'state' },
  { title: 'Since', key: 'since', sortable: false },
  { title: 'URL', key: 'url', sortable: false },
  { title: 'Wake mode', key: 'wakeMode' },
  { title: 'Wakes (7 days)', key: 'wakes7d', align: 'end' as const, value: (w: WorkloadSummary) => w.stats7d?.wakes ?? null },
  { title: 'Wakes (total)', key: 'wakeCount', align: 'end' as const },
];
const since = (w: WorkloadSummary) => relative(w.state === 'AWAKE' ? w.awakeSince ?? w.updatedAt : w.updatedAt, now.value);
</script>

<template>
  <div class="d-flex flex-wrap align-center ga-4 mb-4">
    <h1 class="text-headline-small">Workloads</h1>
    <v-spacer />
    <RefreshIndicator :next-at="nextAt" :loading="loading" @refresh="run" />
    <v-text-field v-model="search" :prepend-inner-icon="mdiMagnify" label="Search" density="compact" hide-details single-line style="min-width: 200px; max-width: 280px" />
  </div>
  <v-alert v-if="error" type="error" class="mb-4" :text="error" />
  <v-alert v-for="e in errors" :key="e.router" type="warning" class="mb-4" :title="`Router ${e.router} unreachable`" :text="e.message" />
  <v-alert v-for="r in late" :key="r.name" type="warning" class="mb-4" :title="`Workloads of ${r.name} do not nap on their own`" :text="`${checkHealth(r, now).text}.`" />
  <v-card>
    <v-data-table :mobile="smAndDown" :headers="headers" :items="workloads" :search="search" :loading="loading && !workloads.length" item-value="workloadId" :items-per-page="25">
      <template #[`item.workloadId`]="{ item }">
        <router-link :to="`/workloads/${item.router}/${item.workloadId}`" class="font-weight-medium">{{ item.workloadId }}</router-link>
      </template>
      <template #[`item.state`]="{ item }"><span class="d-inline-flex align-center ga-1"><StateChip :state="item.state" /><PauseChip :pauses="item.pauses" /></span></template>
      <template #[`item.since`]="{ item }"><span class="nowrap">{{ since(item) }}</span></template>
      <template #[`item.url`]="{ item }">
        <a v-if="item.url" :href="item.url" target="_blank" rel="noopener" class="nowrap">{{ item.url.replace('https://', '').replace(/\/$/, '') }}<v-icon :icon="mdiOpenInNew" size="x-small" class="ml-1" /></a>
      </template>
    </v-data-table>
  </v-card>
</template>
