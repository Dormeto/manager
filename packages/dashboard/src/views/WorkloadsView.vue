<script setup lang="ts">
import { useNow } from '../now';
import { useDisplay } from 'vuetify';
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { mdiMagnify, mdiOpenInNew } from '@mdi/js';
import { api } from '../api';
import { usePoll } from '../poll';
import { checkHealth, relative } from '../format';
import BackendKinds from '../components/BackendKinds.vue';
import StateBar from '../components/StateBar.vue';
import { barSavings } from '../costs';
import { stateSince } from '../state';
import PauseChip from '../components/PauseChip.vue';
import StateChip from '../components/StateChip.vue';
import RefreshIndicator from '../components/RefreshIndicator.vue';
import type { FleetStates, RouterInfo, WorkloadSummary } from '../types';

const now = useNow();
const { smAndDown } = useDisplay();
// The bar of all workloads (user request): the API keeps each workload's figures an hour by default; asked again every
// 10 minutes.
const FLEET_MS = 600_000;
const fleet = ref<FleetStates | null>(null);
async function loadFleet() {
  fleet.value = await api<FleetStates>('/workloads/states').catch(() => fleet.value);
}
let fleetTimer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void loadFleet();
  fleetTimer = setInterval(() => void loadFleet(), FLEET_MS);
});
onUnmounted(() => clearInterval(fleetTimer));
const workloads = ref<WorkloadSummary[]>([]);
const total = ref(0);
const errors = ref<{ router: string; message: string }[]>([]);
const search = ref('');
// Only the workloads that need attention (the Overview's link): failed, waking or paused.
const route = useRoute();
const router = useRouter();
const attentionOnly = ref(route.query.attention === '1');
// The workloads of one router in one state (a chip of the Routers view).
const routerFilter = ref(typeof route.query.router === 'string' ? route.query.router : '');
const stateFilter = ref(typeof route.query.state === 'string' ? route.query.state : '');
// Pages from the API (scale design §4): the page, its size and the search are the server's.
const page = ref(1);
const perPage = ref(25);
const late = ref<RouterInfo[]>([]);
let routersCheckedAt = 0;
const { error, loading, nextAt, run } = usePoll(async () => {
  // Router health every minute is enough (the warning is about checks late by 15 minutes), in the same request.
  const withRouters = Date.now() - routersCheckedAt > 60_000;
  const query = new URLSearchParams({
    limit: String(perPage.value), offset: String((page.value - 1) * perPage.value), idle: '1', states: '1', ...(search.value.trim() ? { q: search.value.trim() } : {}),
    ...(attentionOnly.value ? { attention: '1' } : {}), ...(withRouters ? { routers: '1' } : {}),
    ...(routerFilter.value ? { router: routerFilter.value } : {}), ...(stateFilter.value ? { state: stateFilter.value } : {}),
  });
  const result = await api<{ workloads: WorkloadSummary[]; total: number; errors: { router: string; message: string }[]; routers?: RouterInfo[] }>(`/workloads?${query}`);
  workloads.value = result.workloads;
  total.value = result.total ?? result.workloads.length;
  errors.value = result.errors;
  if (withRouters && result.routers) {
    routersCheckedAt = Date.now();
    late.value = result.routers.filter((r) => !r.error && checkHealth(r, now.value).late);
  }
});
function allWorkloads() {
  attentionOnly.value = false;
  routerFilter.value = '';
  stateFilter.value = '';
  page.value = 1;
  void router.replace({ query: {} });
  void run();
}

const headers = [
  { title: 'AWS account', key: 'account', sortable: false },
  { title: 'Workload', key: 'name', value: (w: WorkloadSummary) => w.name ?? w.workloadId, sortable: false },
  { title: 'Backend', key: 'backends', sortable: false },
  { title: 'Router', key: 'router', sortable: false },
  { title: 'State', key: 'state', sortable: false },
  { title: 'Since', key: 'since', sortable: false },
  { title: 'Last 7 days', key: 'states7d', align: 'end' as const, sortable: false },
  { title: 'URL', key: 'url', sortable: false },
  { title: 'Wake mode', key: 'wakeMode', sortable: false },
  { title: 'Wakes (7 days)', key: 'wakes7d', align: 'end' as const, value: (w: WorkloadSummary) => w.stats7d?.wakes ?? null, sortable: false },
  { title: 'Wakes (total)', key: 'wakeCount', align: 'end' as const, sortable: false },
];
function options(o: { page: number; itemsPerPage: number }) {
  if (o.page === page.value && o.itemsPerPage === perPage.value) return;
  page.value = o.page;
  perPage.value = o.itemsPerPage;
  void run();
}
let typing: ReturnType<typeof setTimeout> | undefined;
watch(search, () => {
  clearTimeout(typing);
  typing = setTimeout(() => { page.value = 1; void run(); }, 300);
});
// Since when it is in its state (the run's last write moves without a state change too).
const since = (w: WorkloadSummary) => relative(stateSince(w).at ?? w.updatedAt, now.value);
</script>

<template>
  <div data-test="workloads-header" class="d-flex flex-wrap align-center ga-4 mb-4">
    <h1 class="text-headline-small">Workloads</h1>
    <StateBar v-if="fleet" :states="fleet.states7d" :title="`All ${fleet.workloads} workloads, last 7 days`" :width="200"
      :savings="fleet.costs ? { saved: fleet.costs.saved, hourly: fleet.costs.hourly, monthly: fleet.costs.monthly } : null"
      :note="`Computed ${relative(fleet.computedAt, now)}; each workload's figures are kept ${fleet.cacheMinutes} minutes.`" />
    <v-spacer />
    <RefreshIndicator :next-at="nextAt" :loading="loading" @refresh="run" />
    <v-chip v-if="attentionOnly" closable label @click:close="allWorkloads">Needing attention</v-chip>
    <v-chip v-if="routerFilter || stateFilter" closable label @click:close="allWorkloads">{{ [routerFilter, stateFilter.toLowerCase()].filter(Boolean).join(' · ') }}</v-chip>
    <v-text-field v-model="search" :prepend-inner-icon="mdiMagnify" label="Search" density="compact" hide-details single-line style="min-width: 200px; max-width: 280px" />
  </div>
  <v-alert v-if="error" type="error" class="mb-4" :text="error" />
  <v-alert v-for="e in errors" :key="e.router" type="warning" class="mb-4" :title="`Router ${e.router} unreachable`" :text="e.message" />
  <v-alert v-for="r in late" :key="r.name" type="warning" class="mb-4" :title="`Workloads of ${r.name} do not nap on their own`" :text="`${checkHealth(r, now).text}.`" />
  <v-card>
    <v-data-table-server :mobile="smAndDown" :headers="headers" :items="workloads" :items-length="total" :loading="loading && !workloads.length"
      :item-value="(w: WorkloadSummary) => `${w.router}/${w.workloadId}`" :page="page" :items-per-page="perPage" :sort-by="[]" :must-sort="false" @update:options="options">
      <template #[`item.account`]="{ item }"><span class="mono">{{ item.account }}</span></template>
      <template #[`item.name`]="{ item }">
        <router-link :to="`/workloads/${item.router}/${item.workloadId}`" class="font-weight-medium">{{ item.name ?? item.workloadId }}</router-link>
      </template>
      <template #[`item.backends`]="{ item }"><BackendKinds :kinds="item.backends ?? []" /></template>
      <template #[`item.router`]="{ item }"><router-link :to="`/routers/${encodeURIComponent(item.router)}`">{{ item.router }}</router-link></template>
      <template #[`item.state`]="{ item }"><span class="d-inline-flex align-center ga-1"><StateChip :state="item.state" :failure="item.failure" /><PauseChip :pauses="item.pauses" /></span></template>
      <template #[`item.states7d`]="{ item }">
        <StateBar class="ml-auto" :states="item.states7d" :idle-hours7d="item.idleHours7d" :requests7d="item.requests7d" :savings="barSavings(item.costs)" />
      </template>
      <template #[`item.since`]="{ item }"><span class="nowrap">{{ since(item) }}</span></template>
      <template #[`item.url`]="{ item }">
        <a v-if="item.url" :href="item.url" target="_blank" rel="noopener" class="nowrap">{{ item.url.replace('https://', '').replace(/\/$/, '') }}<v-icon :icon="mdiOpenInNew" size="x-small" class="ml-1" /></a>
      </template>
    </v-data-table-server>
  </v-card>
</template>
