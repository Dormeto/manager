<script setup lang="ts">
// Routers (router management): version, health, idle check, workloads per state and pauses; pause and resume.
import { ref } from 'vue';
import { useDisplay } from 'vuetify';
import { mdiAlertOctagonOutline, mdiAlertOutline, mdiBellRingOutline, mdiCheckCircleOutline, mdiLanDisconnect, mdiPlusCircleOutline, mdiRouterNetwork } from '@mdi/js';
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
import DmLoader from '../components/DmLoader.vue';
import DmLogo from '../components/DmLogo.vue';

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
// Presentation: a router's health as a color and an icon, the same reading as its chip.
const tone = (r: RouterInfo) => (r.error ? 'error' : r.health ? healthColor(r.health.status) : undefined);
const HEALTH_ICONS: Record<string, string> = { ok: mdiCheckCircleOutline, warning: mdiAlertOutline, error: mdiAlertOctagonOutline };
</script>


<template>
  <div class="d-flex flex-wrap align-end ga-4 mb-6">
    <div>
      <div class="dm-eyebrow mb-1">Fleet</div>
      <h1 class="text-headline-small">Routers</h1>
    </div>
    <v-spacer />
    <v-btn v-if="session.isAdmin" :prepend-icon="mdiPlusCircleOutline" variant="tonal" color="primary" @click="installOpen = true">Install a router</v-btn>
    <RefreshIndicator :next-at="nextAt" :loading="loading" @refresh="run" />
  </div>
  <p class="dm-lead text-medium-emphasis mt-n2 mb-6">One router per account and region naps and wakes its workloads. A paused router never naps any of
    them (requests still wake); health comes from its idle check, its Lambda functions and its failure queues.</p>
  <NoticeToast :notice="notice" @close="notice = null" />
  <v-alert v-if="error" type="error" class="mb-4" :text="error" />
  <v-card class="dm-routers">
    <v-data-table :mobile="smAndDown" :headers="headers" :items="routers" :loading="loading && !routers.length" item-value="name" hide-default-footer>
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
            <div class="dm-router__where"><span v-if="item.account" class="mono">{{ item.account }}</span><span v-if="item.account" aria-hidden="true">·</span><RegionLabel :region="item.region" /></div>
          </div>
        </div>
      </template>
      <template #[`item.version`]="{ item }">
        <RouterVersion :router="item" :available="available" @upgrade="start({ type: 'upgrade-router', router: item.name }, `Upgrade of ${item.name} to ${available}`)" />
      </template>
      <template #[`item.health`]="{ item }">
        <div class="dm-health">
          <v-chip v-if="item.error" color="error" variant="tonal" label :prepend-icon="mdiLanDisconnect">unreachable</v-chip>
          <v-tooltip v-else-if="item.health" location="top" max-width="420" open-on-click open-on-focus :disabled="!item.health.problems.length">
            <template #activator="{ props }">
              <span v-bind="props" class="dm-health__line" tabindex="0">
                <v-chip :color="healthColor(item.health.status)" variant="tonal" label :prepend-icon="HEALTH_ICONS[item.health.status]">{{ item.health.status }}</v-chip>
                <!-- The first problem on one line, cut short: the tooltip has them all, in full. -->
                <span v-if="item.health.problems.length" class="health-problem text-truncate text-body-small text-medium-emphasis">{{ item.health.problems[0]!.text }}</span>
                <span v-if="item.health.problems.length > 1" class="dm-health__more nowrap">+{{ item.health.problems.length - 1 }}</span>
              </span>
            </template>
            <div v-for="p in item.health.problems" :key="p.text" class="text-body-medium dm-health__tip"><strong>{{ p.level }}</strong>: {{ p.text }}</div>
          </v-tooltip>
          <span v-else class="text-body-small text-medium-emphasis">upgrade to 0.16 for health</span>
          <div v-if="alarmOf(item)" class="dm-health__alarm text-body-small" :class="`text-${alarmOf(item)!.level}`">
            <v-icon :icon="mdiBellRingOutline" size="14" />alert since {{ relative(alarmOf(item)!.since, now) }}</div>
          <div v-if="item.error" class="text-body-small text-error">{{ item.error }}</div>
          <v-tooltip v-if="item.reporting === false && !item.error" location="top" max-width="380"
            text="The manager calls this router at each view: it does not send its state (a router older than 0.21, or without the manager's event bus).">
            <template #activator="{ props }"><v-chip v-bind="props" size="x-small" variant="tonal" label class="mt-1" tabindex="0">not reporting</v-chip></template>
          </v-tooltip>
        </div>
      </template>
      <template #[`item.lastScheduledCheckAt`]="{ item }"><span class="nowrap dm-num">{{ relative(item.lastScheduledCheckAt, now) }}</span></template>
      <template #[`item.workloads`]="{ item }">
        <div class="dm-states">
          <v-tooltip v-for="(n, state) in item.workloadStates ?? {}" :key="state" location="top" :text="workloadsHelp(item.name, String(state), n)">
            <template #activator="{ props }">
              <v-chip v-bind="props" :color="stateColor(String(state))" variant="tonal" size="small" label link class="dm-num"
                @click="openWorkloads(item.name, String(state), n)">{{ n }} {{ String(state).toLowerCase() }}</v-chip>
            </template>
          </v-tooltip>
          <span v-if="!item.workloadStates && item.workloads !== undefined" class="dm-num">{{ item.workloads }}</span>
        </div>
        <div v-if="item.paused" class="text-body-small text-medium-emphasis mt-1">{{ item.paused }} paused</div>
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
      <template #prepend>
        <v-avatar color="primary" variant="tonal" rounded="lg" size="36"><v-icon :icon="mdiRouterNetwork" size="20" /></v-avatar>
      </template>
      <v-card-text>
        <p class="mb-5 text-medium-emphasis">Dormeto creates the router in the account and region by API calls, through its DmtCommandRole there. Onboarding a
          workload installs it on its own when needed.</p>
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
.dm-lead { max-width: 68rem; font-size: 0.98rem; line-height: 1.55; text-wrap: pretty; }
.dm-num { font-variant-numeric: tabular-nums; }
.dm-calm { display: flex; align-items: center; justify-content: center; gap: 14px; }

/* The table: room to breathe, cells aligned on their first line. */
.dm-routers :deep(.v-table__wrapper > table > tbody > tr:not(.v-data-table__tr--mobile) > td) { padding: 14px 12px !important; vertical-align: top; height: auto !important; }
.dm-routers :deep(.v-table__wrapper > table > thead > tr > th) { padding-inline: 12px !important; }
.dm-routers :deep(.v-table__wrapper > table > * > tr > :first-child) { padding-inline-start: 18px !important; }
.dm-routers :deep(.v-table__wrapper > table > * > tr > :last-child) { padding-inline-end: 16px !important; }
.dm-routers :deep(.v-data-table-rows-loading > td), .dm-routers :deep(.v-data-table-rows-no-data > td) { height: auto !important; }

.dm-router { display: flex; align-items: center; gap: 12px; min-width: 0; }
.dm-router__icon { flex: none; }
.dm-router__id { min-width: 0; }
.dm-router__name { display: inline-block; white-space: nowrap; font-weight: 600; letter-spacing: -0.01em; color: rgb(var(--v-theme-on-surface)); text-decoration: none; transition: color 0.2s; }
.dm-router__name:hover { color: rgb(var(--v-theme-primary)); }
.dm-router__name:focus-visible { outline: 2px solid rgb(var(--v-theme-secondary)); outline-offset: 2px; border-radius: 4px; }
.dm-router__where { display: flex; align-items: center; gap: 6px; margin-top: 2px; font-size: 0.78rem; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }

.dm-health { min-width: 11rem; max-width: 15rem; }
/* The chip, then the first problem beside it, or under it when long. */
.dm-health__line { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; max-width: 100%; border-radius: 8px; }
.dm-health__line > .v-chip { flex: none; }
.dm-health__line:focus-visible { outline: 2px solid rgb(var(--v-theme-secondary)); outline-offset: 2px; }
.health-problem { display: inline-block; max-width: 10.5rem; min-width: 0; }
.dm-health__more { font: 500 0.7rem/1 var(--dm-mono); padding: 3px 6px; border-radius: 6px; background: rgba(var(--v-theme-on-surface), 0.07); }
.dm-health__alarm { display: flex; align-items: center; gap: 5px; margin-top: 6px; font-weight: 500; }
.dm-health__tip + .dm-health__tip { margin-top: 6px; }

.dm-states { display: flex; flex-wrap: wrap; gap: 4px; min-width: 10rem; max-width: 13rem; }
.dm-mono-field :deep(input) { font-family: var(--dm-mono); }

/* Phones: the table's rows become stacked blocks, one per router, its name first. */
.dm-routers :deep(.v-data-table__tr--mobile > td:first-child) { padding-top: 14px !important; }
.dm-routers :deep(.v-data-table__tr--mobile > td:last-child) { padding-bottom: 14px !important; border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)) !important; }
.dm-routers :deep(.v-data-table__tr--mobile:last-child > td:last-child) { border-bottom: 0 !important; }
.dm-routers :deep(.v-data-table__tr--mobile .v-data-table__td-value) { min-width: 0; text-align: end; }
.dm-routers :deep(.v-data-table__tr--mobile .dm-router__name) { white-space: normal; overflow-wrap: anywhere; }
.dm-routers :deep(.v-data-table__tr--mobile :is(.dm-router, .dm-states, .dm-version, .dm-health__line, .dm-health__alarm)) { justify-content: flex-end; }
@media (max-width: 600px) { .dm-health { min-width: 0; max-width: none; } .health-problem { max-width: 10rem; } .dm-states { min-width: 0; } }
</style>
