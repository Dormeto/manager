<script setup lang="ts">
import { useNow } from '../now';
import { computed, ref } from 'vue';
import { mdiAlertCircleOutline, mdiFilterRemoveOutline, mdiPowerSleep, mdiServerNetwork, mdiWeatherSunny, mdiWeatherSunsetUp } from '@mdi/js';
import { api } from '../api';
import { usePoll } from '../poll';
import { checkHealth, relative } from '../format';
import { healthColor } from '../pause';
import PauseChip from '../components/PauseChip.vue';
import StateChip from '../components/StateChip.vue';
import RefreshIndicator from '../components/RefreshIndicator.vue';
import type { RouterInfo, WorkloadSummary } from '../types';

const now = useNow();
const workloads = ref<WorkloadSummary[]>([]);
const routers = ref<RouterInfo[]>([]);
const { error, loading, nextAt, run } = usePoll(async () => {
  const [w, r] = await Promise.all([
    api<{ workloads: WorkloadSummary[] }>('/workloads'),
    api<{ routers: RouterInfo[] }>('/routers'),
  ]);
  workloads.value = w.workloads;
  routers.value = r.routers;
});

const count = (...states: string[]) => workloads.value.filter((w) => states.includes(w.state)).length;
const cards = computed(() => [
  { title: 'Awake', value: count('AWAKE'), icon: mdiWeatherSunny, color: 'success' },
  { title: 'Asleep', value: count('ASLEEP'), icon: mdiPowerSleep, color: 'info' },
  { title: 'Napping or waking', value: count('NAPPING', 'WAKING'), icon: mdiServerNetwork, color: 'warning' },
  { title: 'Failed', value: count('FAILED'), icon: mdiAlertCircleOutline, color: 'error' },
]);
const late = computed(() => routers.value.filter((r) => !r.error && checkHealth(r, now.value).late));
// Failed or waking workloads, and paused ones (a pause is easy to forget).
const attention = computed(() => workloads.value.filter((w) => w.state === 'FAILED' || w.state === 'WAKING' || w.pauses?.length));
const routerChip = (r: RouterInfo) => (r.error
  ? { color: 'error', text: 'unreachable' }
  : r.health ? { color: healthColor(r.health.status), text: r.health.status }
    : checkHealth(r, now.value).late ? { color: 'warning', text: 'idle check late' } : { color: 'success', text: 'ok' });
const total = (key: 'ignored' | 'deferred' | 'wakes') => workloads.value.reduce((n, w) => n + (w.stats7d?.[key] ?? 0), 0);
const weekly = computed(() => [
  { title: 'Wakes (7 days)', value: total('wakes'), icon: mdiWeatherSunsetUp, color: 'primary' },
  { title: 'Requests that did not wake (7 days)', value: total('ignored') + total('deferred'), icon: mdiFilterRemoveOutline, color: 'secondary' },
]);
</script>

<template>
  <div class="d-flex flex-wrap align-center ga-4 mb-4">
    <h1 class="text-headline-small">Overview</h1>
    <v-spacer />
    <RefreshIndicator :next-at="nextAt" :loading="loading" @refresh="run" />
  </div>
  <v-alert v-if="error" type="error" class="mb-4" :text="error" />
  <v-alert v-for="r in late" :key="r.name" type="warning" class="mb-4" :title="`Workloads of ${r.name} do not nap on their own`"
    :text="`${checkHealth(r, now).text}. The scheduled idle check of the router is not running: check its schedule and the dmt-<env>-check-failures queue.`" />
  <v-row>
    <v-col v-for="card in cards" :key="card.title" cols="6" md="3">
      <v-card :loading="loading && !workloads.length">
        <v-card-text class="d-flex align-center ga-3">
          <v-avatar :color="card.color" variant="tonal" rounded="lg"><v-icon :icon="card.icon" /></v-avatar>
          <div>
            <div class="text-headline-large font-weight-bold">{{ card.value }}</div>
            <div class="text-medium-emphasis">{{ card.title }}</div>
          </div>
        </v-card-text>
      </v-card>
    </v-col>
  </v-row>
  <v-row>
    <v-col v-for="card in weekly" :key="card.title" cols="12" sm="6">
      <v-card>
        <v-card-text class="d-flex align-center ga-3">
          <v-avatar :color="card.color" variant="tonal" rounded="lg"><v-icon :icon="card.icon" /></v-avatar>
          <div>
            <div class="text-headline-large font-weight-bold">{{ card.value.toLocaleString() }}</div>
            <div class="text-medium-emphasis">{{ card.title }}</div>
          </div>
        </v-card-text>
      </v-card>
    </v-col>
  </v-row>
  <v-row>
    <v-col cols="12" md="7">
      <v-card title="Needs attention">
        <v-list v-if="attention.length" lines="two">
          <v-list-item v-for="w in attention" :key="`${w.router}/${w.workloadId}`" :to="`/workloads/${w.router}/${w.workloadId}`"
            :title="w.name ?? w.workloadId" :subtitle="`${w.router} · changed ${relative(w.updatedAt, now)}`">
            <template #append><span class="d-inline-flex align-center ga-1"><PauseChip :pauses="w.pauses" /><StateChip :state="w.state" /></span></template>
          </v-list-item>
        </v-list>
        <v-card-text v-else class="text-medium-emphasis">Every workload is awake or asleep, none paused.</v-card-text>
      </v-card>
    </v-col>
    <v-col cols="12" md="5">
      <v-card title="Routers">
        <v-list lines="two">
          <v-list-item v-for="r in routers" :key="r.name" :title="r.name" to="/routers"
            :subtitle="r.error ? r.error : `${r.region} · router ${r.version} · ${r.workloads} workloads · ${r.health?.problems[0]?.text ?? checkHealth(r, now).text}`">
            <template #append>
              <span class="d-inline-flex align-center ga-1"><PauseChip :pauses="r.pauses" /><v-chip :color="routerChip(r).color" variant="tonal" label>{{ routerChip(r).text }}</v-chip></span>
            </template>
          </v-list-item>
        </v-list>
      </v-card>
    </v-col>
  </v-row>
</template>
