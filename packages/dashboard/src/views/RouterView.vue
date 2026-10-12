<script setup lang="ts">
// A router's own view, reached from Routers as a workload's is from Workloads: its version, health and alert, its
// workloads by state, its pauses, its health figures and configuration (with where each setting is changed), its actions.
import { computed, ref } from 'vue';
import { mdiArrowLeft } from '@mdi/js';
import { api } from '../api';
import { usePoll } from '../poll';
import { relative, stateColor } from '../format';
import { healthColor, pauseLine } from '../pause';
import { useNow } from '../now';
import { terraformHelp, workloadsHelp } from '../router-actions';
import { useRouterOperations } from '../router-operations';
import type { Notice } from '../components/NoticeAlert.vue';
import NoticeToast from '../components/NoticeToast.vue';
import PauseChip from '../components/PauseChip.vue';
import RefreshIndicator from '../components/RefreshIndicator.vue';
import RegionLabel from '../components/RegionLabel.vue';
import RouterActions from '../components/RouterActions.vue';
import RouterDetails from '../components/RouterDetails.vue';
import RouterVersion from '../components/RouterVersion.vue';
import TerraformChip from '../components/TerraformChip.vue';
import type { AlarmInfo, AlertsInfo, RouterInfo } from '../types';

const props = defineProps<{ name: string }>();
const now = useNow();
const routers = ref<RouterInfo[]>([]);
const available = ref<string | null>(null);
const alarms = ref<AlarmInfo[]>([]);
const loaded = ref(false);
const notice = ref<Notice | null>(null);
const router = computed(() => routers.value.find((r) => r.name === props.name) ?? null);
const alarm = computed(() => alarms.value.find((a) => a.kind === 'router' && a.name === props.name) ?? null);

const { error, loading, nextAt, run } = usePoll(async () => {
  const [result, alerts] = await Promise.all([
    api<{ routers: RouterInfo[]; available?: { version: string } }>('/routers'),
    api<AlertsInfo>('/alerts').catch(() => null),
  ]);
  routers.value = result.routers;
  available.value = result.available?.version ?? null;
  alarms.value = alerts?.alarms ?? [];
  loaded.value = true;
  watch.refreshed(result.routers.filter((r) => r.name === props.name).flatMap((r) => (r.operation ? [{ ...r.operation, subject: r.name }] : [])));
});
const { watch, operation, pause, resume, openWorkloads } = useRouterOperations(notice, () => run());
</script>

<template>
  <div class="d-flex flex-wrap align-center ga-3 mb-4">
    <v-btn :icon="mdiArrowLeft" variant="text" to="/routers" aria-label="Back to the routers" />
    <h1 class="text-headline-small">{{ name }}</h1>
    <template v-if="router">
      <v-chip v-if="router.health" :color="healthColor(router.health.status)" variant="tonal" label>{{ router.health.status }}</v-chip>
      <TerraformChip v-if="router.source !== 'manager'" :text="terraformHelp(router.name)" />
      <PauseChip :pauses="router.pauses" />
      <span class="text-medium-emphasis d-inline-flex align-center ga-1"><span v-if="router.account" class="mono">{{ router.account }}</span><span v-if="router.account">·</span><RegionLabel :region="router.region" /></span>
    </template>
    <v-spacer />
    <RefreshIndicator :next-at="nextAt" :loading="loading" @refresh="run" />
    <RouterActions v-if="router" :router="router" @uninstall="operation({ type: 'uninstall-router', router: router.name }, `Uninstallation of ${router.name}`, router)"
      @pause="pause(router, $event)" @resume="resume(router)" />
  </div>
  <NoticeToast :notice="notice" @close="notice = null" />
  <v-alert v-if="error" type="error" class="mb-4" :text="error" />
  <v-alert v-else-if="loaded && !router" type="warning" variant="tonal" class="mb-4" :text="`Unknown router: ${name}. It may have been uninstalled; Routers lists those the manager knows.`" />
  <v-progress-linear v-if="!loaded" indeterminate color="primary" />

  <v-row v-if="router">
    <v-col cols="12" md="5">
      <v-card title="Summary">
        <v-table density="comfortable">
          <tbody>
            <tr><th class="text-medium-emphasis font-weight-regular">Version</th>
              <td><RouterVersion :router="router" :available="available" @upgrade="operation({ type: 'upgrade-router', router: router.name }, `Upgrade of ${router.name} to ${available}`, router)" /></td></tr>
            <tr><th class="text-medium-emphasis font-weight-regular">Last idle check</th><td>{{ relative(router.lastScheduledCheckAt, now) }}</td></tr>
            <tr><th class="text-medium-emphasis font-weight-regular">Workloads</th>
              <td>
                <div class="d-flex flex-wrap ga-1 py-1">
                  <v-tooltip v-for="(n, state) in router.workloadStates ?? {}" :key="state" location="top" :text="workloadsHelp(router.name, String(state), n)">
                    <template #activator="{ props: tip }">
                      <v-chip v-bind="tip" :color="stateColor(String(state))" variant="tonal" size="small" label link
                        @click="openWorkloads(router.name, String(state), n)">{{ n }} {{ String(state).toLowerCase() }}</v-chip>
                    </template>
                  </v-tooltip>
                  <span v-if="!router.workloadStates">{{ router.workloads ?? '—' }}</span>
                </div>
                <router-link :to="{ path: '/workloads', query: { router: router.name } }" class="text-body-small">All its workloads</router-link>
                <span v-if="router.paused" class="text-body-small text-medium-emphasis"> · {{ router.paused }} paused</span>
              </td></tr>
            <tr v-for="p in router.pauses ?? []" :key="`${p.scope}/${p.at}`"><th class="text-medium-emphasis font-weight-regular">Paused</th><td>{{ pauseLine(p, now) }}</td></tr>
          </tbody>
        </v-table>
      </v-card>
    </v-col>
    <v-col cols="12" md="7">
      <v-card title="Health">
        <v-card-text>
          <v-chip v-if="router.error" color="error" variant="tonal" label>unreachable</v-chip>
          <div v-if="router.error" class="text-error mt-2">{{ router.error }}</div>
          <template v-else-if="router.health">
            <div v-if="alarm" class="mb-2" :class="`text-${alarm.level}`">alert since {{ relative(alarm.since, now) }}</div>
            <div v-for="p in router.health.problems" :key="p.text" class="text-body-medium mb-1"><span :class="`text-${p.level}`">{{ p.level }}</span>: {{ p.text }}</div>
            <div v-if="!router.health.problems.length" class="text-medium-emphasis">No problem: its idle check runs, its functions and failure queues are clean.</div>
          </template>
          <span v-else class="text-medium-emphasis">Upgrade to 0.16 for health.</span>
        </v-card-text>
      </v-card>
    </v-col>
    <v-col cols="12">
      <v-card title="Figures and configuration"><RouterDetails :name="router.name" :source="router.source" /></v-card>
    </v-col>
  </v-row>
</template>
