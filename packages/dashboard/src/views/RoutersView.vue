<script setup lang="ts">
// Routers (router management): version, health, idle check, workloads per state and pauses; pause and resume.
import { ref } from 'vue';
import { useDisplay } from 'vuetify';
import { mdiPause, mdiPlay } from '@mdi/js';
import { api } from '../api';
import { usePoll } from '../poll';
import { relative, stateColor } from '../format';
import { healthColor } from '../pause';
import { useNow } from '../now';
import { useSession } from '../stores/session';
import PauseChip from '../components/PauseChip.vue';
import PauseDialog from '../components/PauseDialog.vue';
import RefreshIndicator from '../components/RefreshIndicator.vue';
import RouterDetails from '../components/RouterDetails.vue';
import type { RouterInfo } from '../types';

const now = useNow();
const session = useSession();
const { smAndDown } = useDisplay();
const routers = ref<RouterInfo[]>([]);
const expanded = ref<string[]>([]);
const pausing = ref<RouterInfo | null>(null);
const notice = ref<{ type: 'success' | 'error'; text: string } | null>(null);
const { error, loading, nextAt, run } = usePoll(async () => {
  routers.value = (await api<{ routers: RouterInfo[] }>('/routers')).routers;
});

async function pause(router: RouterInfo, body: { reason: string; until?: string; keepAsleep: boolean }) {
  pausing.value = null;
  try {
    const result = await api<{ woken: string[] }>(`/routers/${encodeURIComponent(router.name)}/pause`, { method: 'POST', body: JSON.stringify(body) });
    notice.value = { type: 'success', text: `${router.name} paused${result.woken.length ? `; waking ${result.woken.join(', ')}` : ''}.` };
  } catch (err) {
    notice.value = { type: 'error', text: (err as Error).message };
  }
  await run();
}

async function resume(router: RouterInfo) {
  try {
    await api(`/routers/${encodeURIComponent(router.name)}/resume`, { method: 'POST' });
    notice.value = { type: 'success', text: `${router.name} resumed: its workloads nap again when idle (workloads paused on their own stay paused).` };
  } catch (err) {
    notice.value = { type: 'error', text: (err as Error).message };
  }
  await run();
}

const headers = [
  { title: 'Router', key: 'name' },
  { title: 'Version', key: 'version' },
  { title: 'Health', key: 'health', sortable: false },
  { title: 'Idle check', key: 'lastScheduledCheckAt' },
  { title: 'Workloads', key: 'workloads', sortable: false },
  { title: 'Pause', key: 'pauses', sortable: false },
  { title: '', key: 'actions', sortable: false, align: 'end' as const },
  { title: '', key: 'data-table-expand' },
];
</script>

<template>
  <div class="d-flex flex-wrap align-center ga-4 mb-2">
    <h1 class="text-headline-small">Routers</h1>
    <v-spacer />
    <RefreshIndicator :next-at="nextAt" :loading="loading" @refresh="run" />
  </div>
  <p class="text-medium-emphasis mb-4">One router per account and region naps and wakes its workloads. A paused router never naps any of
    them (requests still wake); health comes from its idle check, its Lambda functions and its failure queues.</p>
  <v-alert v-if="notice" :type="notice.type" closable class="mb-4" :text="notice.text" @click:close="notice = null" />
  <v-alert v-if="error" type="error" class="mb-4" :text="error" />
  <v-card>
    <v-data-table v-model:expanded="expanded" :mobile="smAndDown" :headers="headers" :items="routers" :loading="loading && !routers.length"
      item-value="name" show-expand hide-default-footer>
      <template #[`item.name`]="{ item }">
        <div class="font-weight-medium">{{ item.name }}</div>
        <div class="text-body-small text-medium-emphasis"><span v-if="item.account" class="mono">{{ item.account }}</span> · {{ item.region }}</div>
      </template>
      <template #[`item.version`]="{ item }">
        <span v-if="item.version">{{ item.version }} <span class="text-body-small text-medium-emphasis mono">{{ item.build }}</span></span>
      </template>
      <template #[`item.health`]="{ item }">
        <v-chip v-if="item.error" color="error" variant="tonal" label>unreachable</v-chip>
        <v-tooltip v-else-if="item.health" location="top" max-width="420" open-on-click open-on-focus :disabled="!item.health.problems.length">
          <template #activator="{ props }">
            <span v-bind="props" class="d-inline-flex align-center ga-2" tabindex="0">
              <v-chip :color="healthColor(item.health.status)" variant="tonal" label>{{ item.health.status }}</v-chip>
              <span v-if="item.health.problems.length" class="text-body-small text-medium-emphasis">{{ item.health.problems[0]!.text }}<template v-if="item.health.problems.length > 1"> (+{{ item.health.problems.length - 1 }})</template></span>
            </span>
          </template>
          <div v-for="p in item.health.problems" :key="p.text" class="text-body-medium">{{ p.level }}: {{ p.text }}</div>
        </v-tooltip>
        <span v-else class="text-body-small text-medium-emphasis">upgrade to 0.16 for health</span>
        <div v-if="item.error" class="text-body-small text-error">{{ item.error }}</div>
      </template>
      <template #[`item.lastScheduledCheckAt`]="{ item }"><span class="nowrap">{{ relative(item.lastScheduledCheckAt, now) }}</span></template>
      <template #[`item.workloads`]="{ item }">
        <div class="d-flex flex-wrap ga-1">
          <v-chip v-for="(n, state) in item.workloadStates ?? {}" :key="state" :color="stateColor(String(state))" variant="tonal" size="small" label>{{ n }} {{ String(state).toLowerCase() }}</v-chip>
          <span v-if="!item.workloadStates && item.workloads !== undefined">{{ item.workloads }}</span>
        </div>
        <div v-if="item.paused" class="text-body-small text-medium-emphasis">{{ item.paused }} paused</div>
      </template>
      <template #[`item.pauses`]="{ item }"><PauseChip :pauses="item.pauses" /></template>
      <template #[`item.actions`]="{ item }">
        <template v-if="session.canOperate && item.health">
          <v-btn v-if="item.pauses?.length" :prepend-icon="mdiPlay" variant="tonal" size="small" @click="resume(item)">Resume</v-btn>
          <v-btn v-else :prepend-icon="mdiPause" variant="tonal" size="small" @click="pausing = item">Pause</v-btn>
        </template>
      </template>
      <template #expanded-row="{ columns, item }">
        <tr><td :colspan="columns.length" class="pa-0"><RouterDetails :name="item.name" /></td></tr>
      </template>
    </v-data-table>
  </v-card>
  <PauseDialog :model-value="pausing !== null" :subject="pausing?.name ?? ''" router @update:model-value="pausing = null" @submit="pause(pausing!, $event)" />
</template>
