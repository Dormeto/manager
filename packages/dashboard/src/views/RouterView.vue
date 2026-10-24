<script setup lang="ts">
// A router's own view, reached from Routers as a workload's is from Workloads: its version, health and alert, its
// workloads by state, its pauses, its health figures and configuration (with where each setting is changed), its actions.
import { computed, onMounted, ref } from 'vue';
import { mdiAlertOctagonOutline, mdiAlertOutline, mdiArrowLeft, mdiArrowRight, mdiBellRingOutline, mdiCheckCircleOutline, mdiHeartPulse, mdiLanDisconnect, mdiPauseCircleOutline } from '@mdi/js';
import { api } from '../api';
import { usePoll } from '../poll';
import { relative, stateColor } from '../format';
import { healthColor, pauseLine } from '../pause';
import { useNow } from '../now';
import { useSession } from '../stores/session';
import { terraformHelp, workloadsHelp } from '../router-actions';
import { useRouterOperations } from '../router-operations';
import type { Notice } from '../components/NoticeAlert.vue';
import DescriptionCard from '../components/DescriptionCard.vue';
import DmLoader from '../components/DmLoader.vue';
import DmLogo from '../components/DmLogo.vue';
import NoticeToast from '../components/NoticeToast.vue';
import PauseChip from '../components/PauseChip.vue';
import RefreshIndicator from '../components/RefreshIndicator.vue';
import RegionLabel from '../components/RegionLabel.vue';
import RouterActions from '../components/RouterActions.vue';
import RouterDetails from '../components/RouterDetails.vue';
import RouterVersion from '../components/RouterVersion.vue';
import TerraformChip from '../components/TerraformChip.vue';
import type { AlarmInfo, AlertsInfo, DescriptionInfo, RouterInfo } from '../types';

const props = defineProps<{ name: string }>();
const now = useNow();
const session = useSession();
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
// The description (manager 0.19.0), read from the manager alone so that it shows while the router cannot be reached;
// undefined until read, and when the read fails: the card shows nothing then. Administrators write it.
const description = ref<DescriptionInfo | null | undefined>(undefined);
const savingDescription = ref(false);
const descriptionError = ref('');
const descriptionPath = computed(() => `/routers/${encodeURIComponent(props.name)}/description`);
onMounted(async () => {
  try {
    description.value = (await api<{ description: DescriptionInfo | null }>(descriptionPath.value)).description;
  } catch {
    // Nothing rather than an invitation to write over a text that may exist.
  }
});
async function writeDescription(call: { method: 'PUT'; body: string } | { method: 'DELETE' }) {
  savingDescription.value = true;
  descriptionError.value = '';
  try {
    description.value = (await api<{ description: DescriptionInfo | null }>(descriptionPath.value, call)).description;
  } catch (err) {
    descriptionError.value = (err as Error).message;
  } finally {
    savingDescription.value = false;
  }
}
const saveDescription = (text: string) => writeDescription({ method: 'PUT', body: JSON.stringify({ text }) });
const clearDescription = () => writeDescription({ method: 'DELETE' });

const { watch, operation, pause, resume, openWorkloads } = useRouterOperations(notice, () => run());

// Presentation of the hero: the icon awake, its sun's rays turning while an operation runs; a sentence for its health.
const mood = computed<'load' | 'wake'>(() => (router.value?.operation ? 'load' : 'wake'));
const sky = computed(() => {
  const r = router.value;
  if (!r) return 'wake';
  if (r.operation) return 'load';
  if (r.error || r.health?.status === 'error') return 'error';
  return r.health?.status === 'warning' ? 'warning' : 'wake';
});
const RUNNING: Record<string, string> = { 'upgrade-router': 'Upgrading…', 'install-router': 'Installing…', 'uninstall-router': 'Uninstalling…' };
const headline = computed(() => {
  const r = router.value;
  if (!r) return '';
  if (r.operation) return RUNNING[r.operation.type] ?? 'An operation is running…';
  if (r.error) return 'Unreachable right now';
  if (!r.health) return 'No health report before router 0.16';
  const n = r.health.problems.length;
  return n ? `${n} problem${n === 1 ? '' : 's'} to look at` : 'Healthy';
});
const HEALTH_ICONS: Record<string, string> = { ok: mdiCheckCircleOutline, warning: mdiAlertOutline, error: mdiAlertOctagonOutline };
const healthTone = computed(() => (router.value?.error ? 'error' : router.value?.health ? healthColor(router.value.health.status) : undefined));
</script>

<template>
  <div class="d-flex flex-wrap align-end ga-4 mb-6">
    <div>
      <div class="d-flex align-center mb-1">
        <v-btn :icon="mdiArrowLeft" variant="text" size="x-small" class="dm-back" to="/routers" aria-label="Back to the routers" />
        <span class="dm-eyebrow">Fleet</span>
      </div>
      <h1 class="text-headline-small">{{ name }}</h1>
    </div>
    <v-spacer />
    <RefreshIndicator :next-at="nextAt" :loading="loading" @refresh="run" />
  </div>
  <NoticeToast :notice="notice" @close="notice = null" />
  <v-alert v-if="error" type="error" class="mb-4" :text="error" />
  <v-alert v-else-if="loaded && !router" type="warning" variant="tonal" class="mb-4" :text="`Unknown router: ${name}. It may have been uninstalled; Routers lists those the manager knows.`" />
  <DmLoader v-if="!loaded" label="Reading the router…" />

  <template v-if="router">
    <v-card class="dm-hero mb-4">
      <div class="dm-hero__sky" :data-mood="sky" aria-hidden="true" />
      <v-card-text class="dm-hero__body">
        <div class="dm-hero__icon"><DmLogo :state="mood" :size="88" /></div>
        <div class="dm-hero__main">
          <div class="dm-hero__top">
            <div class="dm-hero__where">
              <span class="dm-eyebrow">Router</span>
              <span v-if="router.account" class="mono">{{ router.account }}</span><span v-if="router.account" aria-hidden="true">·</span>
              <RegionLabel :region="router.region" /><span class="mono">{{ router.region }}</span>
            </div>
            <RouterActions :router="router" @uninstall="operation({ type: 'uninstall-router', router: router.name }, `Uninstallation of ${router.name}`, router)"
              @pause="pause(router, $event)" @resume="resume(router)" />
          </div>
          <div class="dm-hero__headline">{{ headline }}</div>
          <div class="dm-hero__chips">
            <v-chip v-if="router.error" color="error" variant="tonal" label :prepend-icon="mdiLanDisconnect">unreachable</v-chip>
            <v-chip v-else-if="router.health" :color="healthColor(router.health.status)" variant="tonal" label :prepend-icon="HEALTH_ICONS[router.health.status]">{{ router.health.status }}</v-chip>
            <TerraformChip v-if="router.source !== 'manager'" :text="terraformHelp(router.name)" />
            <PauseChip :pauses="router.pauses" />
          </div>
          <div class="dm-hero__facts">
            <div class="dm-fact">
              <div class="dm-fact__label">Version</div>
              <RouterVersion :router="router" :available="available" @upgrade="operation({ type: 'upgrade-router', router: router.name }, `Upgrade of ${router.name} to ${available}`, router)" />
              <div v-if="!router.version" class="dm-fact__value">—</div>
            </div>
            <div class="dm-fact">
              <div class="dm-fact__label">Last idle check</div>
              <div class="dm-fact__value">{{ relative(router.lastScheduledCheckAt, now) }}</div>
            </div>
            <div class="dm-fact dm-fact--wide">
              <div class="dm-fact__label">Workloads</div>
              <div class="d-flex flex-wrap ga-1">
                <v-tooltip v-for="(n, state) in router.workloadStates ?? {}" :key="state" location="top" :text="workloadsHelp(router.name, String(state), n)">
                  <template #activator="{ props: tip }">
                    <v-chip v-bind="tip" :color="stateColor(String(state))" variant="tonal" size="small" label link class="dm-num"
                      @click="openWorkloads(router.name, String(state), n)">{{ n }} {{ String(state).toLowerCase() }}</v-chip>
                  </template>
                </v-tooltip>
                <span v-if="!router.workloadStates" class="dm-fact__value">{{ router.workloads ?? '—' }}</span>
              </div>
              <div class="dm-fact__more">
                <router-link :to="{ path: '/workloads', query: { router: router.name } }" class="dm-fact__link">All its workloads<v-icon :icon="mdiArrowRight" size="14" /></router-link>
                <span v-if="router.paused" class="text-medium-emphasis"> · {{ router.paused }} paused</span>
              </div>
            </div>
          </div>
          <div v-for="p in router.pauses ?? []" :key="`${p.scope}/${p.at}`" class="dm-hero__pause">
            <v-icon :icon="mdiPauseCircleOutline" size="18" color="secondary" />
            <span><span class="dm-hero__pause-label">Paused</span> {{ pauseLine(p, now) }}</span>
          </div>
        </div>
      </v-card-text>
    </v-card>

    <DescriptionCard class="mb-4" :description="description" :can-edit="session.isAdmin" :subject="router.name" :saving="savingDescription" :error="descriptionError"
      @save="saveDescription" @clear="clearDescription" />

    <!-- The health, short, heads the first of RouterDetails' two columns (the figures beside it): no empty space under it. -->
    <div class="dm-sections">
      <RouterDetails :name="router.name" :source="router.source">
        <v-card class="dm-health">
          <v-card-item class="dm-health__head">
            <template #prepend><v-avatar :color="healthTone" variant="tonal" rounded="lg" size="34"><v-icon :icon="mdiHeartPulse" size="19" /></v-avatar></template>
            <v-card-title>Health</v-card-title>
          </v-card-item>
          <v-card-text class="pt-2">
            <template v-if="router.error">
              <v-chip color="error" variant="tonal" label>unreachable</v-chip>
              <div class="dm-problem dm-problem--error mt-3"><div class="dm-problem__text text-error">{{ router.error }}</div></div>
            </template>
            <template v-else-if="router.health">
              <div v-if="alarm" class="dm-alarm" :class="`text-${alarm.level}`"><v-icon :icon="mdiBellRingOutline" size="16" />alert since {{ relative(alarm.since, now) }}</div>
              <ul v-if="router.health.problems.length" class="dm-problems">
                <li v-for="p in router.health.problems" :key="p.text" class="dm-problem" :class="`dm-problem--${p.level}`">
                  <v-icon :icon="HEALTH_ICONS[p.level]" :color="p.level" size="18" class="dm-problem__icon" />
                  <div class="text-body-medium">
                    <span class="dm-problem__level" :class="`text-${p.level}`">{{ p.level }}</span><span class="d-sr-only">: </span>
                    <div class="dm-problem__text">{{ p.text }}</div>
                  </div>
                </li>
              </ul>
              <div v-if="!router.health.problems.length" class="dm-calm">
                <DmLogo state="sleep" :size="40" />
                <span class="text-medium-emphasis">No problem: its idle check runs, its functions and failure queues are clean.</span>
              </div>
            </template>
            <span v-else class="text-medium-emphasis">Upgrade to 0.16 for health.</span>
          </v-card-text>
        </v-card>
      </RouterDetails>
    </div>
  </template>
</template>

<style scoped>
.dm-num { font-variant-numeric: tabular-nums; }
.dm-back { margin: -6px 4px -6px -6px; }
h1 { overflow-wrap: anywhere; }

/* The hero: the router's icon in its sky, who and where it is, its health in a sentence, its key figures. */
.dm-hero { position: relative; overflow: hidden; }
.dm-hero__sky { position: absolute; inset: 0; pointer-events: none; opacity: 0.9; transition: background 1.4s;
  background: radial-gradient(60% 120% at 0% 0%, rgba(var(--v-theme-sun), 0.18), transparent 60%), radial-gradient(50% 90% at 100% 100%, rgba(var(--v-theme-primary), 0.14), transparent 70%); }
.dm-hero__sky[data-mood="load"] { background: radial-gradient(60% 120% at 0% 0%, rgba(var(--v-theme-primary), 0.22), transparent 60%), radial-gradient(50% 90% at 100% 100%, rgba(var(--v-theme-sun), 0.12), transparent 70%); }
.dm-hero__sky[data-mood="warning"] { background: radial-gradient(60% 120% at 0% 0%, rgba(var(--v-theme-warning), 0.16), transparent 60%), radial-gradient(50% 90% at 100% 100%, rgba(var(--v-theme-primary), 0.12), transparent 70%); }
.dm-hero__sky[data-mood="error"] { background: radial-gradient(60% 120% at 0% 0%, rgba(var(--v-theme-error), 0.16), transparent 60%), radial-gradient(50% 90% at 100% 100%, rgba(var(--v-theme-primary), 0.12), transparent 70%); }
.dm-hero__body { position: relative; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 32px; align-items: center; padding: 28px !important; }
.dm-hero__icon { display: grid; place-items: center; width: 124px; height: 124px; border-radius: 50%; border: 1px dashed rgba(var(--v-border-color), 0.18); }
.dm-hero__top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; }
.dm-hero__where { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: 0.85rem; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.dm-hero__where .dm-eyebrow { margin-inline-end: 4px; }
.dm-hero__headline { margin: 6px 0 12px; font-size: clamp(1.3rem, 1rem + 1vw, 1.75rem); font-weight: 600; letter-spacing: -0.035em; line-height: 1.15; }
.dm-hero__chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 18px; }
.dm-hero__facts { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 2fr); gap: 12px; }
.dm-fact { min-width: 0; padding: 12px 14px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 16px; background: rgba(var(--v-theme-on-surface), 0.02); }
.dm-fact__label { margin-bottom: 6px; font: 500 0.66rem/1.2 var(--dm-mono); letter-spacing: 0.1em; text-transform: uppercase; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.dm-fact__value { font-size: 1.05rem; font-weight: 600; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
.dm-fact__more { margin-top: 8px; font-size: 0.8rem; }
.dm-fact__link { display: inline-flex; align-items: center; gap: 4px; color: rgb(var(--v-theme-primary)); font-weight: 500; text-decoration: none; }
.dm-fact__link:hover { text-decoration: underline; text-underline-offset: 3px; }
.dm-hero__pause { display: flex; align-items: flex-start; gap: 10px; margin-top: 12px; padding: 10px 14px; border-radius: 14px; font-size: 0.9rem;
  background: rgba(var(--v-theme-secondary), 0.08); border: 1px solid rgba(var(--v-theme-secondary), 0.22); }
.dm-hero__pause-label { font-weight: 600; }

/* The sections: RouterDetails' two columns (this view's health card at the head of the first), its configuration under both. */
.dm-sections { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: start; }
.dm-health__head { padding: 16px 16px 6px !important; }
.dm-health__head :deep(.v-card-title) { padding-top: 0 !important; }
.dm-alarm { display: flex; align-items: center; gap: 6px; margin-bottom: 12px; font-weight: 600; font-size: 0.9rem; }
.dm-problems { display: grid; gap: 8px; padding: 0; list-style: none; }
.dm-problem { display: flex; align-items: flex-start; gap: 12px; padding: 12px 14px; border-radius: 14px; border: 1px solid transparent; }
.dm-problem--warning { background: rgba(var(--v-theme-warning), 0.07); border-color: rgba(var(--v-theme-warning), 0.22); }
.dm-problem--error { background: rgba(var(--v-theme-error), 0.07); border-color: rgba(var(--v-theme-error), 0.24); }
.dm-problem__icon { flex: none; margin-top: 1px; }
.dm-problem__level { display: block; margin-bottom: 2px; font: 600 0.66rem/1.3 var(--dm-mono); letter-spacing: 0.1em; text-transform: uppercase; }
.dm-problem__text { line-height: 1.5; text-wrap: pretty; overflow-wrap: anywhere; }
.dm-calm { display: flex; align-items: center; gap: 14px; }

@media (max-width: 1100px) {
  .dm-hero__facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dm-fact--wide { grid-column: 1 / -1; }
}
@media (max-width: 960px) {
  .dm-hero__body { grid-template-columns: minmax(0, 1fr); justify-items: start; gap: 20px; padding: 20px !important; }
  .dm-hero__main { width: 100%; }
  .dm-hero__icon { width: 96px; height: 96px; }
  .dm-hero__icon :deep(svg) { width: 68px; height: 68px; }
  .dm-sections { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 600px) {
  .dm-hero__icon { width: 76px; height: 76px; }
  .dm-hero__icon :deep(svg) { width: 54px; height: 54px; }
  .dm-hero__facts { gap: 8px; }
}
</style>
