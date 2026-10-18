<script setup lang="ts">
import { useNow } from '../now';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { mdiAlertCircleOutline, mdiArrowRight, mdiFilterRemoveOutline, mdiPowerSleep, mdiServerNetwork, mdiWeatherSunny, mdiWeatherSunsetUp } from '@mdi/js';
import { api } from '../api';
import { useSession } from '../stores/session';
import { usePoll } from '../poll';
import { attentionMore, relative } from '../format';
import { routerStatus } from '../pause';
import PauseChip from '../components/PauseChip.vue';
import StateChip from '../components/StateChip.vue';
import SavingsCard from '../components/SavingsCard.vue';
import EnergyCard from '../components/EnergyCard.vue';
import RefreshIndicator from '../components/RefreshIndicator.vue';
import AlertsCard from '../components/AlertsCard.vue';
import UpdateBanner from '../components/UpdateBanner.vue';
import DmLogo from '../components/DmLogo.vue';
import FleetMap from '../components/FleetMap.vue';
import type { AlertsInfo, FleetStates, RouterInfo, WorkloadSummary } from '../types';

const now = useNow();
// A member reads the workloads their grants cover, not the routers: the API sends none, so neither the map nor the list shows.
const session = useSession();
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
// The energy the naps did not use (the energy card), as the API estimates it with the bar of all workloads: its figures
// kept an hour, asked again every 10 minutes, as the Workloads view does (never every workload from here).
const FLEET_MS = 600_000;
const fleetStates = ref<FleetStates | null>(null);
const fleetLoaded = ref(false);
const fleetError = ref('');
async function loadFleet() {
  try {
    fleetStates.value = await api<FleetStates>('/workloads/states');
    fleetError.value = '';
  } catch (err) {
    // The last answer stays; none yet, the card says why.
    if (!fleetStates.value) fleetError.value = (err as Error).message;
  } finally {
    fleetLoaded.value = true;
  }
}
let fleetTimer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void loadFleet();
  fleetTimer = setInterval(() => void loadFleet(), FLEET_MS);
});
onUnmounted(() => clearInterval(fleetTimer));

const count = (...states: string[]) => states.reduce((n, s) => n + (byState.value[s] ?? 0), 0);
const cards = computed(() => [
  { title: 'Awake', value: count('AWAKE'), icon: mdiWeatherSunny, color: 'success' },
  { title: 'Asleep', value: count('ASLEEP'), icon: mdiPowerSleep, color: 'info' },
  { title: 'Napping or waking', value: count('NAPPING', 'WAKING'), icon: mdiServerNetwork, color: 'warning' },
  { title: 'Failed', value: count('FAILED'), icon: mdiAlertCircleOutline, color: 'error' },
]);
const fleet = computed(() => Object.values(byState.value).reduce((a, b) => a + b, 0));
// The fleet's mood, for the icon: waking when one wakes, asleep when most sleep.
const mood = computed<'sleep' | 'load' | 'wake'>(() => (count('WAKING', 'NAPPING') ? 'load' : count('ASLEEP') > count('AWAKE') ? 'sleep' : 'wake'));
const headline = computed(() => {
  if (!loaded.value) return 'Reading the routers…';
  if (!fleet.value) return 'No workload yet: onboard one from Discovery.';
  return `${count('ASLEEP')} of ${fleet.value} workload${fleet.value === 1 ? '' : 's'} asleep right now`;
});
// The share of each state, for the bar under the counts.
const shares = computed(() => cards.value.filter((c) => c.value > 0).map((c) => ({ ...c, share: (c.value / Math.max(1, fleet.value)) * 100 })));
const total = (key: 'ignored' | 'deferred' | 'wakes') => stats7d.value[key];
const weekly = computed(() => [
  { title: 'Wakes (7 days)', value: total('wakes'), icon: mdiWeatherSunsetUp, color: 'primary' },
  { title: 'Requests that did not wake (7 days)', value: total('ignored') + total('deferred'), icon: mdiFilterRemoveOutline, color: 'secondary' },
]);

// The numbers count up when they change (a tween per key).
const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const shown = ref<Record<string, number>>({});
function tween(key: string, to: number) {
  const from = shown.value[key] ?? 0;
  if (reduced || from === to) { shown.value = { ...shown.value, [key]: to }; return; }
  const start = performance.now();
  const step = (t: number) => {
    const p = Math.min(1, (t - start) / 900);
    shown.value = { ...shown.value, [key]: Math.round(from + (to - from) * (1 - (1 - p) ** 3)) };
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
watch([cards, weekly], () => { for (const c of [...cards.value, ...weekly.value]) tween(c.title, c.value); }, { immediate: true });
const num = (title: string, value: number) => (shown.value[title] ?? value);
</script>

<template>
  <div class="d-flex flex-wrap align-end ga-4 mb-6">
    <div>
      <div class="dm-eyebrow mb-1">Fleet</div>
      <h1 class="text-headline-small">Overview</h1>
    </div>
    <v-spacer />
    <RefreshIndicator :next-at="nextAt" :loading="loading" @refresh="run" />
  </div>
  <v-alert v-if="error" type="error" class="mb-4" :text="error" />
  <UpdateBanner />
  <AlertsCard v-if="alerts?.notifications" :alerts="alerts" :now="now" class="mb-4" />

  <v-card class="dm-fleet mb-4" :loading="loading && !loaded">
    <div class="dm-fleet__sky" :data-mood="mood" aria-hidden="true" />
    <v-card-text class="dm-fleet__body">
      <div class="dm-fleet__icon">
        <DmLogo :state="loaded ? mood : 'load'" :size="96" />
      </div>
      <div class="dm-fleet__main">
        <div class="dm-eyebrow d-flex align-center ga-2"><span class="dm-live" aria-hidden="true" />Right now</div>
        <div class="dm-fleet__headline">{{ headline }}</div>
        <div class="dm-fleet__counts">
          <div v-for="card in cards" :key="card.title" class="dm-count">
            <v-avatar :color="card.color" variant="tonal" rounded="lg" size="36"><v-icon :icon="card.icon" size="20" /></v-avatar>
            <div>
              <div class="text-headline-large font-weight-bold">{{ num(card.title, card.value) }}</div>
              <div class="text-medium-emphasis text-body-small">{{ card.title }}</div>
            </div>
          </div>
        </div>
        <div v-if="shares.length" class="dm-fleet__bar" role="img" :aria-label="shares.map((s) => `${s.title} ${s.value}`).join(', ')">
          <span v-for="s in shares" :key="s.title" :class="`bg-${s.color}`" :style="{ width: `${s.share}%` }" />
        </div>
      </div>
    </v-card-text>
    <v-divider v-if="!session.isMember" class="mx-7" />
    <v-card-text v-if="!session.isMember" class="dm-fleet__map">
      <div class="dm-eyebrow mb-3">Your fleet, live</div>
      <FleetMap :routers="routers" />
    </v-card-text>
  </v-card>

  <v-row class="mb-1">
    <v-col cols="12" lg="7"><SavingsCard class="h-100" /></v-col>
    <v-col cols="12" lg="5" class="d-flex flex-column ga-4">
      <EnergyCard :energy="fleetStates?.energy" :loaded="fleetLoaded" :error="fleetError" />
      <div class="dm-kpis">
        <v-card v-for="card in weekly" :key="card.title">
          <v-card-text class="d-flex align-center ga-3">
            <v-avatar :color="card.color" variant="tonal" rounded="lg" size="40"><v-icon :icon="card.icon" size="20" /></v-avatar>
            <div>
              <div class="text-headline-large font-weight-bold dm-kpi">{{ num(card.title, card.value).toLocaleString() }}</div>
              <div class="text-medium-emphasis text-body-small">{{ card.title }}</div>
            </div>
          </v-card-text>
        </v-card>
      </div>
      <v-card v-if="!session.isMember" title="Routers" class="flex-grow-1" data-test="routers-card">
        <v-list lines="two" class="bg-transparent">
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
  <v-row align="start">
    <v-col cols="12">
      <v-card title="Needs attention">
        <v-list v-if="attention.length" lines="two" class="bg-transparent">
          <v-list-item v-for="w in attention" :key="`${w.router}/${w.workloadId}`" :to="`/workloads/${w.router}/${w.workloadId}`"
            :title="w.name ?? w.workloadId" :subtitle="`${w.router} · changed ${relative(w.updatedAt, now)}`">
            <template #append><span class="d-inline-flex align-center ga-1"><PauseChip :pauses="w.pauses" /><StateChip :state="w.state" :failure="w.failure" /></span></template>
          </v-list-item>
        </v-list>
        <v-card-text v-else class="dm-calm">
          <DmLogo state="sleep" :size="40" />
          <span class="text-medium-emphasis">Every workload is awake or asleep, none paused.</span>
        </v-card-text>
        <v-card-actions v-if="more"><v-btn variant="text" color="primary" :append-icon="mdiArrowRight" to="/workloads?attention=1">{{ more }}</v-btn></v-card-actions>
      </v-card>
    </v-col>
  </v-row>
</template>

<style scoped>
.dm-fleet { position: relative; overflow: hidden; }
.dm-fleet__sky { position: absolute; inset: 0; pointer-events: none; opacity: 0.9; transition: background 1.4s;
  background: radial-gradient(60% 120% at 0% 0%, rgba(246, 229, 184, 0.12), transparent 60%), radial-gradient(50% 90% at 100% 100%, rgba(69, 137, 202, 0.18), transparent 70%); }
.dm-fleet__sky[data-mood="wake"] { background: radial-gradient(60% 120% at 0% 0%, rgba(255, 155, 85, 0.2), transparent 60%), radial-gradient(50% 90% at 100% 100%, rgba(69, 137, 202, 0.18), transparent 70%); }
.dm-fleet__sky[data-mood="load"] { background: radial-gradient(60% 120% at 0% 0%, rgba(69, 137, 202, 0.25), transparent 60%), radial-gradient(50% 90% at 100% 100%, rgba(255, 155, 85, 0.14), transparent 70%); }
.dm-fleet__body { position: relative; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 32px; align-items: center; padding: 28px !important; }
.dm-fleet__icon { display: grid; place-items: center; width: 132px; height: 132px; border-radius: 50%; border: 1px dashed rgba(var(--v-border-color), 0.18); }
.dm-fleet__headline { margin: 6px 0 18px; font-size: clamp(1.3rem, 1rem + 1vw, 1.75rem); font-weight: 600; letter-spacing: -0.035em; line-height: 1.15; }
.dm-fleet__counts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.dm-count { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 16px; background: rgba(var(--v-theme-on-surface), 0.02); }
.dm-count .text-headline-large { font-size: 1.8rem !important; line-height: 1 !important; letter-spacing: -0.04em; }
.dm-fleet__bar { display: flex; gap: 3px; height: 8px; margin-top: 16px; border-radius: 4px; overflow: hidden; }
.dm-fleet__bar span { min-width: 6px; border-radius: 4px; transition: width 0.8s var(--dm-ease); }
.dm-calm { display: flex; align-items: center; gap: 14px; }
.dm-fleet__map { position: relative; padding: 20px 28px 26px !important; }
.dm-live { width: 8px; height: 8px; border-radius: 50%; background: rgb(var(--v-theme-success)); box-shadow: 0 0 0 0 rgba(var(--v-theme-success), 0.6); animation: dm-live 1.8s ease-out infinite; }
@keyframes dm-live { 70% { box-shadow: 0 0 0 8px rgba(var(--v-theme-success), 0); } 100% { box-shadow: 0 0 0 0 rgba(var(--v-theme-success), 0); } }
.dm-kpis { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.dm-kpi { font-size: 1.9rem !important; line-height: 1 !important; letter-spacing: -0.04em; font-variant-numeric: tabular-nums; }
@media (max-width: 520px) { .dm-kpis { grid-template-columns: minmax(0, 1fr); } }
@media (prefers-reduced-motion: reduce) { .dm-live { animation: none; } }
@media (max-width: 960px) {
  .dm-fleet__body { grid-template-columns: minmax(0, 1fr); justify-items: start; }
  .dm-fleet__icon { width: 104px; height: 104px; }
  .dm-fleet__counts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
