<script setup lang="ts">
// The fleet's workloads: the week of all of them, then the table (tables design §5), paged, searched and filtered on the
// server (scale design §4); its export reads every page of the list shown.
import { useNow } from '../now';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { mdiOpenInNew, mdiTagOutline } from '@mdi/js';
import { api } from '../api';
import { usePoll } from '../poll';
import { backendLabel, checkHealth, cloudMark, exactTime, percent, relative, rowCloud, usd } from '../format';
import CloudMark from '../components/CloudMark.vue';
import BackendKinds from '../components/BackendKinds.vue';
import StateBar from '../components/StateBar.vue';
import { barSavings } from '../costs';
import { failureTitle } from '../failures';
import { stateLabel } from '../history';
import { pausesText } from '../pause';
import { runFacts, weekText } from '../state';
import { useCountUp } from '../count-up';
import type { DmExport, DmHeader, DmServer } from '../table';
import DmTable from '../components/DmTable.vue';
import PauseChip from '../components/PauseChip.vue';
import StateChip from '../components/StateChip.vue';
import RefreshIndicator from '../components/RefreshIndicator.vue';
import DmLoader from '../components/DmLoader.vue';
import DmLogo from '../components/DmLogo.vue';
import type { FleetStates, RouterInfo, WorkloadSummary } from '../types';
import { tagsList } from '../tags';
import KindSelect from '../components/KindSelect.vue';
import WorkloadCell from '../components/WorkloadCell.vue';
import { isStandalone, kindInfo, resourceKindOf, type Kind } from '../kinds';
import { useSession } from '../stores/session';
import PageTitle from '../components/PageTitle.vue';

const now = useNow();
// A member has no Routers view: the router column is text.
const session = useSession();
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
// One kind of workloads (an HTTP or a standalone one, design §6), the API's filter.
const kindFilter = ref<Kind | null>(route.query.kind === 'http' || route.query.kind === 'standalone' ? route.query.kind : null);
function filterByKind(kind: Kind | null) {
  kindFilter.value = kind;
  page.value = 1;
  void run();
}
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
// The list asked of the API: a page (`limit` from `offset`) of the workloads matching the search and the filters, with each
// one's idle hours and week; the routers' health with it when asked.
interface Filters { q: string; attention: boolean; router: string; state: string; tags: string[]; kind: Kind | null }
const filters = (): Filters => ({ q: search.value.trim(), attention: attentionOnly.value, router: routerFilter.value, state: stateFilter.value, tags: [...tagFilter.value], kind: kindFilter.value });
function listPath(f: Filters, limit: number, offset: number, routers = false): string {
  const query = new URLSearchParams({
    limit: String(limit), offset: String(offset), idle: '1', states: '1', ...(f.q ? { q: f.q } : {}),
    ...(f.attention ? { attention: '1' } : {}), ...(routers ? { routers: '1' } : {}),
    ...(f.router ? { router: f.router } : {}), ...(f.state ? { state: f.state } : {}), ...(f.kind ? { kind: f.kind } : {}),
  });
  // Each tag percent-encoded (a space is %20, not the + of a form).
  const tags = f.tags.map((tag) => `&tag=${encodeURIComponent(tag)}`).join('');
  return `/workloads?${query}${tags}`;
}
// `total`: the workloads matching, which the API always counts (GET /workloads), so the table pages on it.
type ListAnswer = { workloads: WorkloadSummary[]; total: number; errors: { router: string; message: string }[]; routers?: RouterInfo[] };
const { error, loading, nextAt, refreshedAt, run } = usePoll(async () => {
  // Router health every minute is enough (the warning is about checks late by 15 minutes), in the same request.
  const withRouters = Date.now() - routersCheckedAt > 60_000;
  const result = await api<ListAnswer>(listPath(filters(), perPage.value, (page.value - 1) * perPage.value, withRouters));
  workloads.value = result.workloads;
  tagsSeen.value = [...new Set([...tagsSeen.value, ...result.workloads.flatMap((w) => tagsList(w.tags).map((t) => t.text))])];
  total.value = result.total;
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
  kindFilter.value = null;
  tagHint.value = '';
  page.value = 1;
  void router.replace({ query: {} });
  void run();
}

// Each column's words: what an export prints (the marks' words, dates as ISO 8601). No sort: the API's order.
const stateText = (w: WorkloadSummary) => [
  stateLabel(w.state), ...(w.failure ? [`${failureTitle(w.failure, rowCloud(w))} (${w.failure.message})`] : []), ...(w.pauses?.length ? [pausesText(w.pauses)] : []),
].join(' · ');
const headers: DmHeader<WorkloadSummary>[] = [
  { title: 'Account or project', key: 'account', sortable: false, text: (w) => (w.account ? `${w.account} (${cloudMark(rowCloud(w)).label})` : cloudMark(rowCloud(w)).label) },
  { title: 'Workload', key: 'name', value: (w) => w.name ?? w.workloadId, sortable: false,
    text: (w) => [w.name ? `${w.name} (${w.workloadId})` : w.workloadId, ...(isStandalone(w) ? ['standalone'] : []), ...(w.summary ? [w.summary] : []), ...(w.scheduled ? ['has a schedule'] : [])].join(' · ') },
  { title: 'Backend', key: 'backends', sortable: false, text: (w) => (w.backends ?? []).map((kind) => backendLabel(kind, rowCloud(w))).join(', ') },
  { title: 'Router', key: 'router', sortable: false },
  { title: 'Tags', key: 'tags', sortable: false, text: (w) => tagsList(w.tags).map((t) => t.text).join(', ') },
  { title: 'State', key: 'state', sortable: false, text: stateText },
  // Its week, then since when, its wake mode and its wakes (M37: the bar's tooltip says them), the date as ISO 8601.
  { title: 'Last 7 days', key: 'states7d', align: 'end', sortable: false,
    text: (w) => [weekText(w.states7d?.totals), ...(typeof w.idleHours7d === 'number' ? [`idle ${percent(w.idleHours7d, 168)}`] : []), ...runFacts(w, (iso) => iso).map((f) => `${f.label}: ${f.value}`)].join(' · ') },
  { title: 'URL', key: 'url', sortable: false },
  // Exported as a number a spreadsheet adds up, the currency in the column's title.
  { title: 'Saved (30 days)', exportTitle: 'Saved (30 days, $)', key: 'saved', align: 'end', value: (w) => w.costs?.saved.usd ?? null, sortable: false,
    text: (w) => (!w.costs ? '' : !w.costs.saved.usd && w.costs.saved.unpricedHours ? 'not priced' : w.costs.saved.usd.toFixed(2)) },
];
const workloadKey = (w: WorkloadSummary) => `${w.router}/${w.workloadId}`;

// An export (tables design §5): every workload matching the search and filters as they are when it is asked, the API's
// pages one at a time (the size the view asks at most, with each one's week), `limit` at most: until a short page, or all
// those the API counts.
const EXPORT_PAGE = 100;
async function readAll(limit: number): Promise<WorkloadSummary[]> {
  const asked = filters();
  const rows: WorkloadSummary[] = [];
  for (let offset = 0; rows.length < limit; offset += EXPORT_PAGE) {
    const result = await api<ListAnswer>(listPath(asked, EXPORT_PAGE, offset));
    rows.push(...result.workloads);
    if (result.workloads.length < EXPORT_PAGE || rows.length >= result.total) break;
  }
  return rows.slice(0, limit);
}
const server = computed<DmServer<WorkloadSummary>>(() => ({ total: total.value, all: readAll }));
// The PDF's lines: the filters in force (the search is the table's).
const exported = computed<DmExport>(() => ({
  name: 'workloads', title: 'Workloads',
  filters: [
    ...(attentionOnly.value ? ['Needing attention'] : []),
    ...(routerFilter.value ? [`Router: ${routerFilter.value}`] : []),
    ...(stateFilter.value ? [`State: ${stateLabel(stateFilter.value)}`] : []),
    ...(tagFilter.value.length ? [`Tags: ${tagFilter.value.join(', ')}`] : []),
    ...(kindFilter.value ? [`Kind: ${kindInfo(kindFilter.value).title}`] : []),
  ],
}));
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
// The 7-day bar's facts (M37: they had columns): since when it is in its state, how long ago and the exact time.
const facts = (w: WorkloadSummary) => runFacts(w, (iso) => `${relative(iso, now.value)} (${exactTime(iso)})`);
// What its naps saved in the last 30 days, as its 7-day bar says it (nothing priced is not $0).
const saved = (s: { usd: number; unpricedHours: number } | undefined) => (!s ? '—' : !s.usd && s.unpricedHours ? 'not priced' : usd(s.usd));
// The fleet's figures count up when they arrive.
const fleetSaved = useCountUp(() => fleet.value?.costs?.saved.usd ?? 0);
const fleetMonthly = useCountUp(() => fleet.value?.costs?.monthly ?? 0);
// The table's empty row: the loader until the first answer, then why it is empty.
const settled = computed(() => refreshedAt.value !== null || Boolean(error.value));
const filtered = computed(() => Boolean(search.value.trim() || attentionOnly.value || routerFilter.value || stateFilter.value || tagFilter.value.length || kindFilter.value));
const host = (url: string) => url.replace('https://', '').replace(/\/$/, '');
</script>

<template>
  <div data-test="workloads-header" class="mb-4">
    <div class="d-flex flex-wrap align-center ga-4 mb-4">
      <PageTitle eyebrow="Fleet" title="Workloads" />
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
              <div class="dm-figure__label">saved in 30 days</div>
            </div>
            <div v-if="typeof fleet.costs.monthly === 'number'" class="dm-figure">
              <div class="dm-figure__value">{{ usd(fleetMonthly) }}</div>
              <div class="dm-figure__label">a month</div>
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
    <!-- A server table: the page, its size and the search go to the API (options and the search model), the filters too;
         its export reads every page through readAll. The rows have no action: the header's "⋮" holds the exports. -->
    <DmTable v-model:search="search" :headers="headers" :items="workloads" :loading="loading && !workloads.length" :item-value="workloadKey" :server="server" :page="page"
      :per-page="25" :exported="exported" @update:options="options">
      <template #toolbar>
        <div class="dm-toolbar__filters">
          <span v-if="total" class="dm-toolbar__count"><span class="dm-num">{{ total.toLocaleString('en-US') }}</span> workload{{ total === 1 ? '' : 's' }}</span>
          <v-chip v-if="attentionOnly" closable label color="secondary" variant="tonal" @click:close="allWorkloads">Needing attention</v-chip>
          <v-chip v-if="routerFilter || stateFilter" closable label color="primary" variant="tonal" @click:close="allWorkloads">{{ [routerFilter, stateFilter.toLowerCase()].filter(Boolean).join(' · ') }}</v-chip>
        </div>
        <!-- Tags and Kind side by side, wrapping together (never one of them alone under the count). -->
        <div class="dm-toolbar__pick" data-test="toolbar-pick">
          <v-combobox :model-value="tagFilter" :items="tagChoices" multiple chips closable-chips :prepend-inner-icon="mdiTagOutline" label="Tags" placeholder="key=value" density="compact" :hide-details="!tagHint" :error-messages="tagHint || undefined"
            class="dm-toolbar__tags" data-test="tag-filter" @update:model-value="filterByTags($event as string[])" />
          <KindSelect :model-value="kindFilter" class="dm-toolbar__kind" @update:model-value="filterByKind($event)" />
        </div>
      </template>
      <template #loading><DmLoader label="Reading the workloads…" :size="56" /></template>
      <template #no-data>
        <DmLoader v-if="!settled" label="Reading the workloads…" :size="56" />
        <div v-else class="dm-calm py-6">
          <DmLogo state="sleep" :size="40" />
          <span class="text-medium-emphasis">{{ filtered ? 'No workload matches these filters.' : 'No workload yet: onboard one from Discovery.' }}</span>
        </div>
      </template>
      <template #[`item.account`]="{ item }"><span class="mono dm-account"><CloudMark :cloud="rowCloud(item)" class="mr-1" />{{ item.account }}</span></template>
      <template #[`item.name`]="{ item }">
        <WorkloadCell :item="item" />
      </template>
      <template #[`item.backends`]="{ item }"><BackendKinds :kinds="item.backends ?? []" :cloud="rowCloud(item)" /></template>
      <template #[`item.router`]="{ item }">
        <span v-if="session.isMember" class="dm-link dm-router">{{ item.router }}</span>
        <router-link v-else :to="`/routers/${encodeURIComponent(item.router)}`" class="dm-link dm-router">{{ item.router }}</router-link>
      </template>
      <template #[`item.tags`]="{ item }">
        <span class="dm-tags">
          <v-chip v-for="t in tagsList(item.tags)" :key="t.key" data-test="tag" size="small" label variant="tonal" link :title="`Show only ${t.text}`" @click="!tagFilter.includes(t.text) && filterByTags([...tagFilter, t.text])">{{ t.text }}</v-chip>
        </span>
      </template>
      <template #[`item.state`]="{ item }"><span class="dm-state"><StateChip :state="item.state" :failure="item.failure" :cloud="rowCloud(item)" /><PauseChip :pauses="item.pauses" /></span></template>
      <template #[`item.states7d`]="{ item }">
        <StateBar class="ml-auto" :width="92" :states="item.states7d" :idle-hours7d="item.idleHours7d" :requests7d="item.requests7d" :resource="resourceKindOf(item)" :savings="barSavings(item.costs)" :cloud="rowCloud(item)" :facts="facts(item)" />
      </template>
      <template #[`item.url`]="{ item }">
        <a v-if="item.url" :href="item.url" target="_blank" rel="noopener" class="dm-url" :title="item.url"><span class="dm-url__host">{{ host(item.url) }}</span><v-icon :icon="mdiOpenInNew" size="x-small" class="dm-url__icon" /></a>
      </template>
      <template #[`item.saved`]="{ item }"><span :class="['nowrap', { 'text-medium-emphasis': !item.costs || (!item.costs.saved.usd && item.costs.saved.unpricedHours) }]">{{ saved(item.costs?.saved) }}</span></template>
    </DmTable>
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

/* The table's toolbar (DmTable's, the search last): how many, the filters. */
.dm-toolbar__filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; flex: 0 1 auto; min-width: 0; }
.dm-toolbar__count { font: 500 0.7rem/1.4 var(--dm-mono); letter-spacing: 0.1em; text-transform: uppercase; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); margin-right: 4px; }
.dm-toolbar__count .dm-num { color: rgb(var(--v-theme-on-surface)); font-weight: 600; }
/* Tags and Kind as one group: Tags takes the room left, Kind the width of its longest choice with its icon. */
.dm-toolbar__pick { display: flex; align-items: center; gap: 8px; flex: 1 1 380px; min-width: 0; max-width: 520px; }
.dm-toolbar__tags { flex: 1 1 200px; min-width: 160px; }
.dm-toolbar__kind { flex: 0 0 172px; }
.dm-tags { display: inline-flex; flex-wrap: wrap; gap: 4px; max-width: 8rem; }

/* The table: cells a little tighter, aligned on their middle; numbers in columns. */
.dm-workloads :deep(.v-table__wrapper > table > thead > tr > th) { padding: 8px !important; }
.dm-workloads :deep(.v-table__wrapper > table > tbody > tr:not(.v-data-table__tr--mobile) > td) { padding: 10px 8px !important; height: auto !important; }
.dm-workloads :deep(.v-table__wrapper > table > thead > tr > th:first-child),
.dm-workloads :deep(.v-table__wrapper > table > tbody > tr:not(.v-data-table__tr--mobile) > td:first-child) { padding-left: 14px !important; }
.dm-workloads :deep(.v-table__wrapper > table > thead > tr > th:last-child),
.dm-workloads :deep(.v-table__wrapper > table > tbody > tr:not(.v-data-table__tr--mobile) > td:last-child) { padding-right: 14px !important; }
.dm-workloads :deep(.v-data-table-column--align-end) { font-variant-numeric: tabular-nums; }

.dm-account { font-size: 0.7rem; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.dm-link { color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); text-decoration: none; font-size: 0.84rem; transition: color 0.2s; }
.dm-link:hover { color: rgb(var(--v-theme-primary)); }
/* A long router name breaks at its hyphens, never inside a word. */
.dm-router { display: inline-block; min-width: 5.8rem; max-width: 7.5rem; line-height: 1.3; }
.dm-link:focus-visible, .dm-url:focus-visible { outline: 2px solid rgb(var(--v-theme-secondary)); outline-offset: 2px; border-radius: 4px; }
.dm-url { display: inline-flex; align-items: center; gap: 4px; max-width: 5.5rem; color: rgb(var(--v-theme-primary)); text-decoration: none; font-size: 0.86rem; }
.dm-url:hover .dm-url__host { text-decoration: underline; text-underline-offset: 3px; }
.dm-url__host { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dm-url__icon { flex: none; opacity: 0.7; }
/* The state's icon, the pause's beside it: the column stays narrow. */
.dm-state { display: inline-flex; align-items: center; gap: 6px; }

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
  .dm-toolbar__pick { flex: 1 1 100%; max-width: none; flex-wrap: wrap; }
  .dm-toolbar__tags, .dm-toolbar__kind { flex: 1 1 100%; min-width: 0; }
  .dm-url { max-width: 11rem; }
  .dm-strip__body { padding: 16px; }
}
</style>
