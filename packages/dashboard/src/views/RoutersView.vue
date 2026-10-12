<script setup lang="ts">
// Routers (router management): version, health, idle check, workloads per state and pauses; pause and resume.
import { ref } from 'vue';
import { useDisplay } from 'vuetify';
import { mdiPlusCircleOutline } from '@mdi/js';
import { api } from '../api';
import { usePoll } from '../poll';
import { relative, stateColor } from '../format';
import { healthColor } from '../pause';
import { useNow } from '../now';
import { useSession } from '../stores/session';
import { workloadsHelp } from '../router-actions';
import { useRouterOperations } from '../router-operations';
import type { Notice } from '../components/NoticeAlert.vue';
import NoticeToast from '../components/NoticeToast.vue';
import PauseChip from '../components/PauseChip.vue';
import RefreshIndicator from '../components/RefreshIndicator.vue';
import RegionLabel from '../components/RegionLabel.vue';
import RouterActions from '../components/RouterActions.vue';
import RouterVersion from '../components/RouterVersion.vue';
import type { AlarmInfo, AlertsInfo, RouterInfo } from '../types';
import IpListsPanel from '../components/IpListsPanel.vue';

const now = useNow();
const session = useSession();
const { smAndDown } = useDisplay();
const routers = ref<RouterInfo[]>([]);
const notice = ref<Notice | null>(null);
const available = ref<string | null>(null);
const installOpen = ref(false);
const install = ref({ account: '', region: '' });
// Open alarms of the watchdog (R6a), by router: dated in the health cell.
const alarms = ref<AlarmInfo[]>([]);
const alarmOf = (r: RouterInfo) => alarms.value.find((a) => a.kind === 'router' && a.name === r.name);
const { error, loading, nextAt, run } = usePoll(async () => {
  const [result, alerts] = await Promise.all([
    api<{ routers: RouterInfo[]; available?: { version: string } }>('/routers'),
    api<AlertsInfo>('/alerts').catch(() => null),
  ]);
  alarms.value = alerts?.alarms ?? [];
  routers.value = result.routers;
  available.value = result.available?.version ?? null;
  watch.refreshed(result.routers.flatMap((r) => (r.operation ? [{ ...r.operation, subject: r.name }] : [])));
});

// Router actions (router-operations.ts), shared with a router's own view.
const { watch, operation, pause, resume, openWorkloads } = useRouterOperations(notice, () => run());
function start(body: Record<string, unknown>, what: string) {
  installOpen.value = false;
  return operation(body, what, routers.value.find((r) => r.name === body.router));
}

const headers = [
  { title: 'Router', key: 'name' },
  { title: 'Version', key: 'version' },
  { title: 'Health', key: 'health', sortable: false },
  { title: 'Idle check', key: 'lastScheduledCheckAt' },
  { title: 'Workloads', key: 'workloads', sortable: false },
  { title: 'Pause', key: 'pauses', sortable: false },
  { title: 'Actions', key: 'actions', sortable: false, align: 'end' as const },
];
</script>

<template>
  <div class="d-flex flex-wrap align-center ga-4 mb-2">
    <h1 class="text-headline-small">Routers</h1>
    <v-spacer />
    <v-btn v-if="session.isAdmin" :prepend-icon="mdiPlusCircleOutline" variant="tonal" @click="installOpen = true">Install a router</v-btn>
    <RefreshIndicator :next-at="nextAt" :loading="loading" @refresh="run" />
  </div>
  <p class="text-medium-emphasis mb-4">One router per account and region naps and wakes its workloads. A paused router never naps any of
    them (requests still wake); health comes from its idle check, its Lambda functions and its failure queues.</p>
  <NoticeToast :notice="notice" @close="notice = null" />
  <v-alert v-if="error" type="error" class="mb-4" :text="error" />
  <v-card>
    <v-data-table :mobile="smAndDown" :headers="headers" :items="routers" :loading="loading && !routers.length" item-value="name" hide-default-footer>
      <template #[`item.name`]="{ item }">
        <router-link :to="`/routers/${encodeURIComponent(item.name)}`" class="font-weight-medium">{{ item.name }}</router-link>
        <div class="text-body-small text-medium-emphasis d-flex align-center ga-1"><span v-if="item.account" class="mono">{{ item.account }}</span><span v-if="item.account">·</span><RegionLabel :region="item.region" /></div>
      </template>
      <template #[`item.version`]="{ item }">
        <RouterVersion :router="item" :available="available" @upgrade="start({ type: 'upgrade-router', router: item.name }, `Upgrade of ${item.name} to ${available}`)" />
      </template>
      <template #[`item.health`]="{ item }">
        <v-chip v-if="item.error" color="error" variant="tonal" label>unreachable</v-chip>
        <v-tooltip v-else-if="item.health" location="top" max-width="420" open-on-click open-on-focus :disabled="!item.health.problems.length">
          <template #activator="{ props }">
            <span v-bind="props" class="d-inline-flex align-center ga-2" tabindex="0">
              <v-chip :color="healthColor(item.health.status)" variant="tonal" label>{{ item.health.status }}</v-chip>
              <!-- The first problem on one line, cut short: the tooltip has them all, in full. -->
              <span v-if="item.health.problems.length" class="health-problem text-truncate text-body-small text-medium-emphasis">{{ item.health.problems[0]!.text }}</span>
              <span v-if="item.health.problems.length > 1" class="text-body-small text-medium-emphasis nowrap">+{{ item.health.problems.length - 1 }}</span>
            </span>
          </template>
          <div v-for="p in item.health.problems" :key="p.text" class="text-body-medium">{{ p.level }}: {{ p.text }}</div>
        </v-tooltip>
        <span v-else class="text-body-small text-medium-emphasis">upgrade to 0.16 for health</span>
        <div v-if="alarmOf(item)" class="text-body-small" :class="`text-${alarmOf(item)!.level}`">alert since {{ relative(alarmOf(item)!.since, now) }}</div>
        <div v-if="item.error" class="text-body-small text-error">{{ item.error }}</div>
        <v-tooltip v-if="item.reporting === false && !item.error" location="top" max-width="380"
          text="The manager calls this router at each view: it does not send its state (a router older than 0.21, or without the manager's event bus).">
          <template #activator="{ props }"><v-chip v-bind="props" size="x-small" variant="tonal" label class="mt-1" tabindex="0">not reporting</v-chip></template>
        </v-tooltip>
      </template>
      <template #[`item.lastScheduledCheckAt`]="{ item }"><span class="nowrap">{{ relative(item.lastScheduledCheckAt, now) }}</span></template>
      <template #[`item.workloads`]="{ item }">
        <div class="d-flex flex-wrap ga-1">
          <v-tooltip v-for="(n, state) in item.workloadStates ?? {}" :key="state" location="top" :text="workloadsHelp(item.name, String(state), n)">
            <template #activator="{ props }">
              <v-chip v-bind="props" :color="stateColor(String(state))" variant="tonal" size="small" label link
                @click="openWorkloads(item.name, String(state), n)">{{ n }} {{ String(state).toLowerCase() }}</v-chip>
            </template>
          </v-tooltip>
          <span v-if="!item.workloadStates && item.workloads !== undefined">{{ item.workloads }}</span>
        </div>
        <div v-if="item.paused" class="text-body-small text-medium-emphasis">{{ item.paused }} paused</div>
      </template>
      <template #[`item.pauses`]="{ item }"><PauseChip :pauses="item.pauses" /></template>
      <template #[`item.actions`]="{ item }">
        <RouterActions :router="item" @uninstall="start({ type: 'uninstall-router', router: item.name }, `Uninstallation of ${item.name}`)"
          @pause="pause(item, $event)" @resume="resume(item)" />
      </template>
    </v-data-table>
  </v-card>
  <IpListsPanel />
  <v-dialog v-model="installOpen" max-width="480">
    <v-card title="Install a router">
      <v-card-text>
        <p class="mb-4">Dormeto creates the router in the account and region by API calls, through its DmtCommandRole there. Onboarding a
          workload installs it on its own when needed.</p>
        <v-text-field v-model="install.account" label="Account ID" maxlength="12" />
        <v-text-field v-model="install.region" label="Region" placeholder="eu-west-3" />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="installOpen = false">Cancel</v-btn>
        <v-btn color="primary" variant="flat" :disabled="!/^\d{12}$/.test(install.account) || !install.region"
          @click="start({ type: 'install-router', ...install }, `Installation in ${install.account}/${install.region}`)">Install</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.health-problem { display: inline-block; max-width: 14rem; min-width: 0; }
</style>
