<script setup lang="ts">
import { useNow } from '../now';
import { computed, ref } from 'vue';
import { mdiAlertCircleOutline, mdiFilterRemoveOutline, mdiPowerSleep, mdiServerNetwork, mdiWeatherSunny, mdiWeatherSunsetUp } from '@mdi/js';
import { api } from '../api';
import { usePoll } from '../poll';
import { attentionMore, relative } from '../format';
import { routerStatus } from '../pause';
import PauseChip from '../components/PauseChip.vue';
import StateChip from '../components/StateChip.vue';
import SavingsCard from '../components/SavingsCard.vue';
import RefreshIndicator from '../components/RefreshIndicator.vue';
import AlertsCard from '../components/AlertsCard.vue';
import type { AlertsInfo, RouterInfo, WorkloadSummary } from '../types';

const now = useNow();
// Counts, 7-day totals and the workloads that need attention, from the API (never every workload).
const attention = ref<WorkloadSummary[]>([]);
const byState = ref<Record<string, number>>({});
const stats7d = ref({ wakes: 0, ignored: 0, deferred: 0 });
const loaded = ref(false);
const attentionTotal = ref(0);
const routers = ref<RouterInfo[]>([]);
const alerts = ref<AlertsInfo | null>(null);
// The workloads with their routers (a router that does not report is called once per poll), and the open alarms.
const { error, loading, nextAt, run } = usePoll(async () => {
  const [w, a] = await Promise.all([
    api<{ workloads: WorkloadSummary[]; total: number; byState: Record<string, number>; stats7d: { wakes: number; ignored: number; deferred: number }; routers: RouterInfo[] }>('/workloads?attention=1&limit=20&routers=1'),
    // The alerts are a part of the view: unreadable, the rest still shows.
    api<AlertsInfo>('/alerts').catch(() => null),
  ]);
  alerts.value = a;
  attention.value = w.workloads;
  attentionTotal.value = w.total ?? w.workloads.length;
  byState.value = w.byState ?? {};
  stats7d.value = w.stats7d ?? { wakes: 0, ignored: 0, deferred: 0 };
  routers.value = w.routers ?? [];
  loaded.value = true;
});
const more = computed(() => attentionMore(attentionTotal.value, attention.value.length));

const count = (...states: string[]) => states.reduce((n, s) => n + (byState.value[s] ?? 0), 0);
const cards = computed(() => [
  { title: 'Awake', value: count('AWAKE'), icon: mdiWeatherSunny, color: 'success' },
  { title: 'Asleep', value: count('ASLEEP'), icon: mdiPowerSleep, color: 'info' },
  { title: 'Napping or waking', value: count('NAPPING', 'WAKING'), icon: mdiServerNetwork, color: 'warning' },
  { title: 'Failed', value: count('FAILED'), icon: mdiAlertCircleOutline, color: 'error' },
]);
const total = (key: 'ignored' | 'deferred' | 'wakes') => stats7d.value[key];
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
  <AlertsCard v-if="alerts?.notifications" :alerts="alerts" :now="now" class="mb-4" />
  <SavingsCard class="mb-4" />
  <v-row>
    <v-col v-for="card in cards" :key="card.title" cols="6" md="3">
      <v-card :loading="loading && !loaded">
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
            <template #append><span class="d-inline-flex align-center ga-1"><PauseChip :pauses="w.pauses" /><StateChip :state="w.state" :failure="w.failure" /></span></template>
          </v-list-item>
        </v-list>
        <v-card-text v-else class="text-medium-emphasis">Every workload is awake or asleep, none paused.</v-card-text>
        <v-card-actions v-if="more"><v-btn variant="text" to="/workloads?attention=1">{{ more }}</v-btn></v-card-actions>
      </v-card>
    </v-col>
    <v-col cols="12" md="5">
      <v-card title="Routers">
        <v-list lines="two">
          <v-list-item v-for="r in routers" :key="r.name" :title="r.name" :to="`/routers/${encodeURIComponent(r.name)}`"
            :subtitle="r.error ? r.error : `${r.region} · router ${r.version} · ${r.workloads} workloads · ${routerStatus(r, now).detail}`">
            <template #append>
              <span class="d-inline-flex align-center ga-1"><PauseChip :pauses="r.pauses" /><v-chip :color="routerStatus(r, now).color" variant="tonal" label>{{ routerStatus(r, now).text }}</v-chip></span>
            </template>
          </v-list-item>
        </v-list>
      </v-card>
    </v-col>
  </v-row>
</template>
