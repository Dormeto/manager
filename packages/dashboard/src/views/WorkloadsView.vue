<script setup lang="ts">
import { useNow } from '../now';
import { useDisplay } from 'vuetify';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { mdiMagnify, mdiOpenInNew, mdiTagOutline } from '@mdi/js';
import { api } from '../api';
import { usePoll } from '../poll';
import { checkHealth, relative, usd } from '../format';
import BackendKinds from '../components/BackendKinds.vue';
import StateBar from '../components/StateBar.vue';
import { barSavings } from '../costs';
import { stateSince } from '../state';
import { useCountUp } from '../count-up';
import PauseChip from '../components/PauseChip.vue';
import StateChip from '../components/StateChip.vue';
import RefreshIndicator from '../components/RefreshIndicator.vue';
import DmLoader from '../components/DmLoader.vue';
import DmLogo from '../components/DmLogo.vue';
import type { FleetStates, RouterInfo, WorkloadSummary } from '../types';
import { tagsList } from '../tags';
import { useSession } from '../stores/session';

const now = useNow();
// A member has no Routers view: the router column is text.
const session = useSession();
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
// R11: the tags chosen (key=value, all of them match) and the tags seen so far, to choose among.
const tagFilter = ref<string[]>([]);
const tagsSeen = ref<string[]>([]);
const tagChoices = computed(() => [...new Set([...tagsSeen.value, ...tagFilter.value])].sort());
// A tag is written key=value (split at the first =, so a key holding = cannot be filtered); free text is refused here.
const tagHint = ref('');
const isTag = (t: string) => t.indexOf('=') > 0;
function filterByTags(next: string[]) {
  const bad = next.find((t) => !isTag(t));
  tagHint.value = bad === undefined ? '' : `"${bad}" is not a tag: write it as key=value, for example team=payments`;
  const good = next.filter(isTag);
  const same = good.length === tagFilter.value.length && good.every((t, i) => t === tagFilter.value[i]);
  tagFilter.value = good;
  if (same) return;
  page.value = 1;
  void run();
}
// Pages from the API (scale design §4): the page, its size and the search are the server's.
const page = ref(1);
const perPage = ref(25);
const late = ref<RouterInfo[]>([]);
let routersCheckedAt = 0;
const { error, loading, nextAt, refreshedAt, run } = usePoll(async () => {
  // Router health every minute is enough (the warning is about checks late by 15 minutes), in the same request.
  const withRouters = Date.now() - routersCheckedAt > 60_000;
  const query = new URLSearchParams({
    limit: String(perPage.value), offset: String((page.value - 1) * perPage.value), idle: '1', states: '1', ...(search.value.trim() ? { q: search.value.trim() } : {}),
    ...(attentionOnly.value ? { attention: '1' } : {}), ...(withRouters ? { routers: '1' } : {}),
    ...(routerFilter.value ? { router: routerFilter.value } : {}), ...(stateFilter.value ? { state: stateFilter.value } : {}),
  });
  // Each tag percent-encoded (a space is %20, not the + of a form).
  const tags = tagFilter.value.map((tag) => `&tag=${encodeURIComponent(tag)}`).join('');
  const result = await api<{ workloads: WorkloadSummary[]; total: number; errors: { router: string; message: string }[]; routers?: RouterInfo[] }>(`/workloads?${query}${tags}`);
  workloads.value = result.workloads;
  tagsSeen.value = [...new Set([...tagsSeen.value, ...result.workloads.flatMap((w) => tagsList(w.tags).map((t) => t.text))])];
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
  tagFilter.value = [];
  tagHint.value = '';
  page.value = 1;
  void router.replace({ query: {} });
  void run();
}

const headers = [
  { title: 'AWS account', key: 'account', sortable: false },
  { title: 'Workload', key: 'name', value: (w: WorkloadSummary) => w.name ?? w.workloadId, sortable: false },
  { title: 'Backend', key: 'backends', sortable: false },
  { title: 'Router', key: 'router', sortable: false },
  { title: 'Tags', key: 'tags', sortable: false },
  { title: 'State', key: 'state', sortable: false },
  { title: 'Since', key: 'since', sortable: false },
  { title: 'Last 7 days', key: 'states7d', align: 'end' as const, sortable: false },
  { title: 'URL', key: 'url', sortable: false },
  { title: 'Wake mode', key: 'wakeMode', sortable: false },
  { title: 'Wakes (7 days)', key: 'wakes7d', align: 'end' as const, value: (w: WorkloadSummary) => w.stats7d?.wakes ?? null, sortable: false },
  { title: 'Wakes (total)', key: 'wakeCount', align: 'end' as const, sortable: false },
  { title: 'Saved (30 days)', key: 'saved', align: 'end' as const, value: (w: WorkloadSummary) => w.costs?.saved.usd ?? null, sortable: false },
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
// What its naps saved in the last 30 days, as its 7-day bar says it (nothing priced is not $0).
const saved = (s: { usd: number; unpricedHours: number } | undefined) => (!s ? '—' : !s.usd && s.unpricedHours ? 'not priced' : usd(s.usd));
// The fleet's figures count up when they arrive.
const fleetSaved = useCountUp(() => fleet.value?.costs?.saved.usd ?? 0);
const fleetMonthly = useCountUp(() => fleet.value?.costs?.monthly ?? 0);
// The table's empty row: the loader until the first answer, then why it is empty.
const settled = computed(() => refreshedAt.value !== null || Boolean(error.value));
const filtered = computed(() => Boolean(search.value.trim() || attentionOnly.value || routerFilter.value || stateFilter.value || tagFilter.value.length));
const host = (url: string) => url.replace('https://', '').replace(/\/$/, '');
</script>

<template>
  <div data-test="workloads-header" class="mb-4">
    <div class="d-flex flex-wrap align-end ga-4 mb-6">
      <div>
        <div class="dm-eyebrow mb-1">Fleet</div>
        <h1 class="text-headline-small">Workloads</h1>
      </div>
      <v-spacer />
      <RefreshIndicator :next-at="nextAt" :loading="loading" @refresh="run" />
    </div>
    <!-- The fleet's week (user request): every workload's time in each state, and what their naps saved. -->
    <v-expand-transition>
      <v-card v-if="fleet" class="dm-strip">
        <div class="dm-strip__sky" aria-hidden="true" />
        <div class="dm-strip__body">
          <div class="dm-strip__week">
            <div class="dm-strip__head">
              <span class="dm-eyebrow">All {{ fleet.workloads }} workloads · last 7 days</span>
              <span class="dm-strip__note">computed {{ relative(fleet.computedAt, now) }}</span>
            </div>
            <StateBar block legend :height="10" :states="fleet.states7d" :title="`All ${fleet.workloads} workloads, last 7 days`"
              :savings="fleet.costs ? { saved: fleet.costs.saved, hourly: fleet.costs.hourly, monthly: fleet.costs.monthly, discounts: fleet.costs.discounts ?? null } : null"
              :note="`Computed ${relative(fleet.computedAt, now)}; each workload's figures are kept ${fleet.cacheMinutes} minutes.`" />
          </div>
          <div v-if="fleet.costs" class="dm-strip__figures">
            <div class="dm-figure">
              <div class="dm-figure__value text-success">{{ fleet.costs.saved.usd ? usd(fleetSaved) : saved(fleet.costs.saved) }}</div>
              <div class="dm-figure__label">saved in the last 30 days</div>
            </div>
            <div v-if="typeof fleet.costs.monthly === 'number'" class="dm-figure">
              <div class="dm-figure__value">{{ usd(fleetMonthly) }}</div>
              <div class="dm-figure__label">a month at that rate</div>
            </div>
          </div>
        </div>
      </v-card>
    </v-expand-transition>
  </div>
  <v-alert v-if="error" type="error" class="mb-4" :text="error" />
  <v-alert v-for="e in errors" :key="e.router" type="warning" variant="tonal" class="mb-4" :title="`Router ${e.router} unreachable`" :text="e.message" />
  <v-alert v-for="r in late" :key="r.name" type="warning" variant="tonal" class="mb-4" :title="`Workloads of ${r.name} do not nap on their own`" :text="`${checkHealth(r, now).text}.`" />
  <v-card class="dm-workloads">
    <div class="dm-toolbar">
      <div class="dm-toolbar__filters">
        <span v-if="total" class="dm-toolbar__count"><span class="dm-num">{{ total.toLocaleString('en-US') }}</span> workload{{ total === 1 ? '' : 's' }}</span>
        <v-chip v-if="attentionOnly" closable label color="secondary" variant="tonal" @click:close="allWorkloads">Needing attention</v-chip>
        <v-chip v-if="routerFilter || stateFilter" closable label color="primary" variant="tonal" @click:close="allWorkloads">{{ [routerFilter, stateFilter.toLowerCase()].filter(Boolean).join(' · ') }}</v-chip>
      </div>
      <v-combobox :model-value="tagFilter" :items="tagChoices" multiple chips closable-chips :prepend-inner-icon="mdiTagOutline" label="Tags" placeholder="key=value" density="compact" :hide-details="!tagHint" :error-messages="tagHint || undefined"
        class="dm-toolbar__tags" data-test="tag-filter" @update:model-value="filterByTags($event as string[])" />
      <v-text-field v-model="search" :prepend-inner-icon="mdiMagnify" label="Search" density="compact" hide-details single-line class="dm-toolbar__search" />
    </div>
    <v-data-table-server :mobile="smAndDown" :headers="headers" :items="workloads" :items-length="total" :loading="loading && !workloads.length"
      :item-value="(w: WorkloadSummary) => `${w.router}/${w.workloadId}`" :page="page" :items-per-page="perPage" :sort-by="[]" :must-sort="false" @update:options="options">
      <template #loading><DmLoader label="Reading the workloads…" :size="56" /></template>
      <template #no-data>
        <DmLoader v-if="!settled" label="Reading the workloads…" :size="56" />
        <div v-else class="dm-calm py-6">
          <DmLogo state="sleep" :size="40" />
          <span class="text-medium-emphasis">{{ filtered ? 'No workload matches these filters.' : 'No workload yet: onboard one from Discovery.' }}</span>
        </div>
      </template>
      <template #[`item.account`]="{ item }"><span class="mono dm-account">{{ item.account }}</span></template>
      <template #[`item.name`]="{ item }">
        <div class="dm-wl">
          <router-link :to="`/workloads/${item.router}/${item.workloadId}`" class="dm-wl__name">{{ item.name ?? item.workloadId }}</router-link>
          <div v-if="item.name" class="dm-wl__id mono">{{ item.workloadId }}</div>
        </div>
      </template>
      <template #[`item.backends`]="{ item }"><BackendKinds :kinds="item.backends ?? []" /></template>
      <template #[`item.router`]="{ item }">
        <span v-if="session.isMember" class="dm-link dm-router">{{ item.router }}</span>
        <router-link v-else :to="`/routers/${encodeURIComponent(item.router)}`" class="dm-link dm-router">{{ item.router }}</router-link>
      </template>
      <template #[`item.tags`]="{ item }">
        <span class="dm-tags">
          <v-chip v-for="t in tagsList(item.tags)" :key="t.key" data-test="tag" size="small" label variant="tonal" link :title="`Show only ${t.text}`" @click="!tagFilter.includes(t.text) && filterByTags([...tagFilter, t.text])">{{ t.text }}</v-chip>
        </span>
      </template>
      <template #[`item.state`]="{ item }"><span class="dm-state"><StateChip :state="item.state" :failure="item.failure" /><PauseChip :pauses="item.pauses" /></span></template>
      <template #[`item.states7d`]="{ item }">
        <StateBar class="ml-auto" :width="92" :states="item.states7d" :idle-hours7d="item.idleHours7d" :requests7d="item.requests7d" :savings="barSavings(item.costs)" />
      </template>
      <template #[`item.since`]="{ item }"><span class="nowrap dm-num text-medium-emphasis">{{ since(item) }}</span></template>
      <template #[`item.url`]="{ item }">
        <a v-if="item.url" :href="item.url" target="_blank" rel="noopener" class="dm-url" :title="item.url"><span class="dm-url__host">{{ host(item.url) }}</span><v-icon :icon="mdiOpenInNew" size="x-small" class="dm-url__icon" /></a>
      </template>
      <template #[`item.wakeMode`]="{ item }"><span class="dm-mode">{{ item.wakeMode }}</span></template>
      <template #[`item.saved`]="{ item }"><span :class="['nowrap', { 'text-medium-emphasis': !item.costs || (!item.costs.saved.usd && item.costs.saved.unpricedHours) }]">{{ saved(item.costs?.saved) }}</span></template>
    </v-data-table-server>
  </v-card>
</template>

<style scoped>
.dm-num { font-variant-numeric: tabular-nums; }
.dm-calm { display: flex; align-items: center; justify-content: center; gap: 14px; }

/* The fleet's week: the 7-day bar at full width, its legend, and the savings beside it. */
.dm-strip { position: relative; overflow: hidden; }
.dm-strip__sky { position: absolute; inset: 0; pointer-events: none;
  background: radial-gradient(45% 160% at 0% 0%, rgba(var(--v-theme-primary), 0.1), transparent 70%), radial-gradient(35% 140% at 100% 100%, rgba(var(--v-theme-sun), 0.08), transparent 70%); }
.dm-strip__body { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 16px 40px; padding: 18px 22px; }
.dm-strip__head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 12px; margin-bottom: 2px; }
.dm-strip__note { font: 500 0.66rem/1.4 var(--dm-mono); letter-spacing: 0.06em; color: rgba(var(--v-theme-on-surface), 0.55); }
.dm-strip__figures { display: flex; gap: 12px; }
.dm-figure { min-width: 150px; padding: 10px 16px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 16px; background: rgba(var(--v-theme-on-surface), 0.02); }
.dm-figure__value { font-size: 1.55rem; font-weight: 600; line-height: 1.15; letter-spacing: -0.04em; font-variant-numeric: tabular-nums; }
.dm-figure__label { font-size: 0.78rem; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }

/* The toolbar: how many, the filters, the search. */
.dm-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 16px; padding: 14px 16px 14px 20px; border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.dm-toolbar__filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; flex: 1 1 auto; min-width: 0; }
.dm-toolbar__count { font: 500 0.7rem/1.4 var(--dm-mono); letter-spacing: 0.1em; text-transform: uppercase; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); margin-right: 4px; }
.dm-toolbar__count .dm-num { color: rgb(var(--v-theme-on-surface)); font-weight: 600; }
.dm-toolbar__search { flex: 0 1 280px; min-width: 200px; }
.dm-toolbar__tags { flex: 0 1 320px; min-width: 200px; }
.dm-tags { display: inline-flex; flex-wrap: wrap; gap: 4px; }

/* The table: cells a little tighter, aligned on their middle; numbers in columns. */
.dm-workloads :deep(.v-table__wrapper > table > thead > tr > th) { padding: 8px !important; }
.dm-workloads :deep(.v-table__wrapper > table > tbody > tr:not(.v-data-table__tr--mobile) > td) { padding: 10px 8px !important; height: auto !important; }
.dm-workloads :deep(.v-table__wrapper > table > thead > tr > th:first-child),
.dm-workloads :deep(.v-table__wrapper > table > tbody > tr:not(.v-data-table__tr--mobile) > td:first-child) { padding-left: 14px !important; }
.dm-workloads :deep(.v-table__wrapper > table > thead > tr > th:last-child),
.dm-workloads :deep(.v-table__wrapper > table > tbody > tr:not(.v-data-table__tr--mobile) > td:last-child) { padding-right: 14px !important; }
.dm-workloads :deep(.v-data-table-column--align-end) { font-variant-numeric: tabular-nums; }
.dm-workloads :deep(.v-data-table-rows-loading > td), .dm-workloads :deep(.v-data-table-rows-no-data > td) { height: auto !important; }
.dm-workloads :deep(.v-data-table-footer) { border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); padding: 4px 8px; font-size: 0.82rem; }

.dm-account { font-size: 0.7rem; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.dm-wl { min-width: 0; }
.dm-wl__name { display: inline-block; font-weight: 600; letter-spacing: -0.01em; color: rgb(var(--v-theme-on-surface)); text-decoration: none; white-space: nowrap; transition: color 0.2s; }
.dm-wl__name:hover { color: rgb(var(--v-theme-primary)); }
.dm-wl__id { margin-top: 1px; font-size: 0.7rem; letter-spacing: 0.02em; color: rgba(var(--v-theme-on-surface), 0.5); }
.dm-link { color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); text-decoration: none; font-size: 0.84rem; transition: color 0.2s; }
.dm-link:hover { color: rgb(var(--v-theme-primary)); }
/* A long router name breaks at its hyphens, never inside a word. */
.dm-router { display: inline-block; min-width: 5.8rem; max-width: 7.5rem; line-height: 1.3; }
.dm-wl__name:focus-visible, .dm-link:focus-visible, .dm-url:focus-visible { outline: 2px solid rgb(var(--v-theme-secondary)); outline-offset: 2px; border-radius: 4px; }
.dm-url { display: inline-flex; align-items: center; gap: 4px; max-width: 7.5rem; color: rgb(var(--v-theme-primary)); text-decoration: none; font-size: 0.86rem; }
.dm-url:hover .dm-url__host { text-decoration: underline; text-underline-offset: 3px; }
.dm-url__host { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dm-url__icon { flex: none; opacity: 0.7; }
/* A paused chip under the state: the column stays narrow. */
.dm-state { display: inline-flex; flex-direction: column; align-items: flex-start; gap: 4px; }
.dm-mode { font: 500 0.72rem/1 var(--dm-mono); letter-spacing: 0.04em; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }

/* Phones: each row a stacked card, its values on the right. */
.dm-workloads :deep(.v-data-table__tr--mobile) { border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.dm-workloads :deep(.v-data-table__tr--mobile > td) { border-bottom: 0 !important; height: auto !important; min-height: 42px; padding-top: 6px !important; padding-bottom: 6px !important; }
.dm-workloads :deep(.v-data-table__tr--mobile .v-data-table__td-title) { font-size: 0.82rem; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.dm-workloads :deep(.v-data-table__tr--mobile > td:first-child) { border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.dm-workloads :deep(.v-data-table__tr--mobile:first-child > td:first-child) { border-top: 0; }
.dm-workloads :deep(.v-data-table__tr--mobile:nth-child(even) > td) { background: rgba(var(--v-theme-on-surface), 0.02); }
.dm-workloads :deep(.v-data-table__tr--mobile .v-data-table__td-value) { min-width: 0; text-align: end; }
@media (max-width: 960px) {
  .dm-strip__body { grid-template-columns: minmax(0, 1fr); }
  .dm-strip__figures > * { flex: 1 1 0; min-width: 0; }
}
@media (max-width: 600px) {
  .dm-toolbar { padding: 12px 14px; }
  .dm-toolbar__search, .dm-toolbar__tags { flex: 1 1 100%; min-width: 0; }
  .dm-url { max-width: 11rem; }
  .dm-strip__body { padding: 16px; }
}
</style>
