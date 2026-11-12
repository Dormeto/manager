<script setup lang="ts">
// Routers (router management): version, health, idle check, workloads per state and pauses; each row's menu pauses,
// resumes or uninstalls it, the table's exports the list (tables design §4, §5).
import { ref } from 'vue';
import { mdiDeleteOutline, mdiPause, mdiPlay, mdiPlusCircleOutline, mdiRouterNetwork } from '@mdi/js';
import { api } from '../api';
import { usePoll } from '../poll';
import { relative, rowCloud } from '../format';
import CloudMark from '../components/CloudMark.vue';
import { healthColor, healthText, pausesText, workloadsText } from '../pause';
import { useNow } from '../now';
import { useSession } from '../stores/session';
import { pauseHelp, resumeHelp, uninstallHelp } from '../router-actions';
import { useRouterOperations } from '../router-operations';
import type { DmAction, DmHeader } from '../table';
import type { Notice } from '../components/NoticeAlert.vue';
import DmTable from '../components/DmTable.vue';
import HealthMark from '../components/HealthMark.vue';
import NoticeToast from '../components/NoticeToast.vue';
import PauseChip from '../components/PauseChip.vue';
import PauseDialog from '../components/PauseDialog.vue';
import RefreshIndicator from '../components/RefreshIndicator.vue';
import RegionLabel from '../components/RegionLabel.vue';
import RouterVersion from '../components/RouterVersion.vue';
import UninstallDialog from '../components/UninstallDialog.vue';
import WorkloadCounts from '../components/WorkloadCounts.vue';
import type { AlarmInfo, AlertsInfo, RouterInfo } from '../types';
import IpListsPanel from '../components/IpListsPanel.vue';
import WaitingPageCard from '../components/WaitingPageCard.vue';
import WorkloadDefaultsCard from '../components/WorkloadDefaultsCard.vue';
import WorkloadTypesCard from '../components/WorkloadTypesCard.vue';
import DmLoader from '../components/DmLoader.vue';
import DmLogo from '../components/DmLogo.vue';
import InfoTip from '../components/InfoTip.vue';
import PageTitle from '../components/PageTitle.vue';

const now = useNow();
const session = useSession();
const routers = ref<RouterInfo[]>([]);
const notice = ref<Notice | null>(null);
const available = ref<string | null>(null);
const installOpen = ref(false);
const install = ref({ account: '', region: '' });
// Open alarms of the watchdog (R6a), by router: a bell in the health cell.
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

// Each column's words: what search reads and an export prints (the marks' words, dates as ISO 8601). A router is named
// with its account and region, which its cell shows under the name.
const where = (r: RouterInfo) => [r.account, r.region].filter(Boolean).join(', ');
const headers: DmHeader<RouterInfo>[] = [
  { title: 'Router', key: 'name', text: (r) => (where(r) ? `${r.name} (${where(r)})` : r.name) },
  { title: 'Version', key: 'version', text: (r) => (r.version ? `${r.version}${r.build ? ` (build ${r.build})` : ''}` : '') },
  { title: 'Health', key: 'health', sortable: false, text: (r) => healthText(r, alarmOf(r)) },
  { title: 'Idle check', key: 'lastScheduledCheckAt', text: (r) => r.lastScheduledCheckAt ?? '' },
  { title: 'Workloads', key: 'workloads', sortable: false, text: workloadsText },
  { title: 'Pause', key: 'pauses', sortable: false, text: (r) => pausesText(r.pauses) },
];

// A row's menu: pause (with a reason) or resume for operators, while the router reports its health (0.16 and later);
// uninstall (after a confirmation) for administrators, of a router the manager installed.
const target = ref<RouterInfo | null>(null);
const pausing = ref(false);
const removing = ref(false);
function actions(r: RouterInfo): DmAction[] {
  const pauses: DmAction[] = !session.canOperate || !r.health ? [] : r.pauses?.length
    ? [{ title: 'Resume', icon: mdiPlay, help: resumeHelp(r.name), run: () => void resume(r) }]
    : [{ title: 'Pause…', icon: mdiPause, help: pauseHelp(r.name), run: () => { target.value = r; pausing.value = true; } }];
  const uninstall: DmAction[] = session.isAdmin && r.source === 'manager'
    ? [{ title: 'Uninstall…', icon: mdiDeleteOutline, color: 'error', help: uninstallHelp(r.name), run: () => { target.value = r; removing.value = true; } }]
    : [];
  return [...pauses, ...uninstall];
}
function uninstall() {
  const r = target.value!;
  return start({ type: 'uninstall-router', router: r.name }, `Uninstallation of ${r.name}`);
}
function submitPause(body: { reason: string; until?: string; keepAsleep: boolean }) {
  pausing.value = false;
  return pause(target.value!, body);
}
// Presentation: a router's health as a color, the same reading as its health mark.
const tone = (r: RouterInfo) => (r.error ? 'error' : r.health ? healthColor(r.health.status) : undefined);
</script>


<template>
  <div class="d-flex flex-wrap align-center ga-4 mb-4">
    <PageTitle eyebrow="Fleet" title="Routers">
      <template #after>
        <InfoTip label="What a router does" test="routers" :max-width="440">One router per AWS account and region, or per Google Cloud project and region, naps and wakes its workloads. A paused router
          never naps any of them (requests still wake); health comes from its idle check and, on AWS, its Lambda functions and its failure queues.</InfoTip>
      </template>
    </PageTitle>
    <v-spacer />
    <v-btn v-if="session.isAdmin" :prepend-icon="mdiPlusCircleOutline" variant="tonal" color="primary" @click="installOpen = true">Install a router</v-btn>
    <RefreshIndicator :next-at="nextAt" :loading="loading" @refresh="run" />
  </div>
  <NoticeToast :notice="notice" @close="notice = null" />
  <v-alert v-if="error" type="error" class="mb-4" :text="error" />
  <v-card class="dm-routers">
    <DmTable :headers="headers" :items="routers" :loading="loading && !routers.length" item-value="name" :actions="actions" :exported="{ name: 'routers', title: 'Routers' }">
      <template #loading><DmLoader label="Reading the routers…" :size="56" /></template>
      <template #no-data>
        <div class="dm-calm py-6">
          <DmLogo state="sleep" :size="40" />
          <span class="text-medium-emphasis">No router yet: onboarding a workload installs one.</span>
        </div>
      </template>
      <template #[`item.name`]="{ item }">
        <div class="dm-router">
          <v-avatar :color="tone(item)" variant="tonal" rounded="lg" size="36" class="dm-router__icon"><v-icon :icon="mdiRouterNetwork" size="20" /></v-avatar>
          <div class="dm-router__id">
            <router-link :to="`/routers/${encodeURIComponent(item.name)}`" class="dm-router__name">{{ item.name }}</router-link>
            <div v-if="item.summary" class="dm-list-summary" data-test="summary" :title="item.summary">{{ item.summary }}</div>
            <div class="dm-router__where"><CloudMark :cloud="rowCloud(item)" /><span v-if="item.account" class="mono">{{ item.account }}</span><span v-if="item.account" aria-hidden="true">·</span><RegionLabel :region="item.region" /></div>
          </div>
        </div>
      </template>
      <template #[`item.version`]="{ item }">
        <RouterVersion :router="item" :available="available" @upgrade="start({ type: 'upgrade-router', router: item.name }, `Upgrade of ${item.name} to ${available}`)" />
      </template>
      <!-- The health's icon, a bell beside it for an open alert: the problems, the error and the rest in their tooltips. -->
      <template #[`item.health`]="{ item }"><HealthMark :router="item" :alarm="alarmOf(item)" /></template>
      <template #[`item.lastScheduledCheckAt`]="{ item }"><span class="nowrap dm-num">{{ relative(item.lastScheduledCheckAt, now) }}</span></template>
      <template #[`item.workloads`]="{ item }">
        <WorkloadCounts v-if="item.workloadStates" :router="item" class="dm-states" @open="(state, n) => openWorkloads(item.name, state, n)" />
        <span v-else-if="item.workloads !== undefined" class="dm-num">{{ item.workloads }}</span>
      </template>
      <template #[`item.pauses`]="{ item }"><PauseChip :pauses="item.pauses" /></template>
    </DmTable>
  </v-card>
  <PauseDialog v-model="pausing" :subject="target?.name ?? ''" router @submit="submitPause" />
  <UninstallDialog v-model="removing" :subject="target?.name ?? ''" @confirm="uninstall" />
  <div class="dm-defaults">
    <WorkloadDefaultsCard @notice="notice = $event" />
    <WorkloadTypesCard @notice="notice = $event" />
    <WaitingPageCard level="organization" path="/settings/waiting-page" subject="the organization" @notice="notice = $event" />
  </div>
  <IpListsPanel />
  <v-dialog v-model="installOpen" max-width="480">
    <v-card title="Install a router">
      <template #prepend>
        <v-avatar color="primary" variant="tonal" rounded="lg" size="36"><v-icon :icon="mdiRouterNetwork" size="20" /></v-avatar>
      </template>
      <v-card-text>
        <p class="mb-5 text-medium-emphasis">Dormeto creates the router in the account and region by API calls, through its DmtCommandRole there. Onboarding a
          workload installs it on its own when needed.</p>
        <p data-test="gcp-install-line" class="mb-5 text-body-small text-medium-emphasis">A Google Cloud router is installed with the CLI instead: <code>dormeto gcp routers install</code>.</p>
        <v-text-field v-model="install.account" label="Account ID" maxlength="12" class="dm-mono-field" inputmode="numeric" autocomplete="off" />
        <v-text-field v-model="install.region" label="Region" placeholder="eu-west-3" class="dm-mono-field" autocomplete="off" />
      </v-card-text>
      <v-card-actions class="px-4 pb-4">
        <v-spacer />
        <v-btn variant="text" @click="installOpen = false">Cancel</v-btn>
        <v-btn color="primary" variant="flat" :disabled="!/^\d{12}$/.test(install.account) || !install.region"
          @click="start({ type: 'install-router', ...install }, `Installation in ${install.account}/${install.region}`)">Install</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.dm-num { font-variant-numeric: tabular-nums; }
.dm-defaults { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: start; margin-top: 24px; }
@media (max-width: 960px) { .dm-defaults { grid-template-columns: minmax(0, 1fr); } }
.dm-calm { display: flex; align-items: center; justify-content: center; gap: 14px; }

/* The table: room to breathe, cells aligned on their first line. */
.dm-routers :deep(.v-table__wrapper > table > tbody > tr:not(.v-data-table__tr--mobile) > td) { padding: 14px 12px !important; vertical-align: top; height: auto !important; }
.dm-routers :deep(.v-table__wrapper > table > thead > tr > th) { padding-inline: 12px !important; }
.dm-routers :deep(.v-table__wrapper > table > * > tr > :first-child) { padding-inline-start: 18px !important; }
.dm-routers :deep(.v-table__wrapper > table > * > tr > :last-child) { padding-inline-end: 16px !important; }

.dm-router { display: flex; align-items: center; gap: 12px; min-width: 0; }
.dm-router__icon { flex: none; }
.dm-router__id { min-width: 0; }
.dm-router__name { display: inline-block; white-space: nowrap; font-weight: 600; letter-spacing: -0.01em; color: rgb(var(--v-theme-on-surface)); text-decoration: none; transition: color 0.2s; }
.dm-router__name:hover { color: rgb(var(--v-theme-primary)); }
.dm-router__name:focus-visible { outline: 2px solid rgb(var(--v-theme-secondary)); outline-offset: 2px; border-radius: 4px; }
.dm-router__where { display: flex; align-items: center; gap: 6px; margin-top: 2px; font-size: 0.78rem; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }

/* Four chips on one line. */
.dm-states { min-width: 14rem; max-width: 15rem; }
.dm-mono-field :deep(input) { font-family: var(--dm-mono); }

/* Phones: the table's rows become stacked blocks, one per router, its name first. */
.dm-routers :deep(.v-data-table__tr--mobile > td:first-child) { padding-top: 14px !important; }
.dm-routers :deep(.v-data-table__tr--mobile > td:last-child) { padding-bottom: 14px !important; border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)) !important; }
.dm-routers :deep(.v-data-table__tr--mobile:last-child > td:last-child) { border-bottom: 0 !important; }
.dm-routers :deep(.v-data-table__tr--mobile .v-data-table__td-value) { min-width: 0; text-align: end; }
.dm-routers :deep(.v-data-table__tr--mobile .dm-router__name) { white-space: normal; overflow-wrap: anywhere; }
.dm-routers :deep(.v-data-table__tr--mobile :is(.dm-router, .dm-states, .dm-version)) { justify-content: flex-end; }
@media (max-width: 600px) { .dm-states { min-width: 0; max-width: none; } }
</style>
