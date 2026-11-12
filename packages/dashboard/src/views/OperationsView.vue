<script setup lang="ts">
// Operations (onboarding, R4b): onboardings, offboardings and router installations run by the workflow, as a table (tables
// design §4): a row per operation, its status an icon, its steps under it (with the error and a manager update's build).
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import {
  mdiAlertCircleOutline, mdiArrowUpBoldCircleOutline, mdiCancel, mdiCheck, mdiCheckCircleOutline, mdiCircleSmall, mdiClose, mdiDeleteOutline, mdiLinkVariant,
  mdiLinkVariantOff, mdiMinus, mdiMinusCircleOutline, mdiOpenInNew, mdiPlayCircleOutline, mdiPlusCircleOutline, mdiProgressClock, mdiRouterNetwork, mdiUpdate,
} from '@mdi/js';
import { api } from '../api';
import { exactTime, relative } from '../format';
import { useNow } from '../now';
import { operationBuildLink, operationKind, operationProgress, operationTitle } from '../operations';
import { usePoll } from '../poll';
import type { DmHeader } from '../table';
import DmLoader from '../components/DmLoader.vue';
import DmLogo from '../components/DmLogo.vue';
import DmTable from '../components/DmTable.vue';
import RefreshIndicator from '../components/RefreshIndicator.vue';
import RegionLabel from '../components/RegionLabel.vue';
import StatusMark from '../components/StatusMark.vue';
import type { Operation, OperationType, StepStatus } from '../types';
import PageTitle from '../components/PageTitle.vue';

const now = useNow();
const operations = ref<Operation[]>([]);
// An operation a link names (?id=, a notice's "Follow it in Operations", here or from another view) opens with its steps,
// on the page that holds it once the list has it; a refresh keeps the rows open (their ids).
const route = useRoute();
const expanded = ref<string[]>([]);
const table = ref<{ reveal: (value: unknown) => Promise<boolean> } | null>(null);
const named = ref<string | null>(null);
watch(() => route.query.id, (id) => {
  if (typeof id !== 'string' || !id) return;
  if (!expanded.value.includes(id)) expanded.value = [...expanded.value, id];
  named.value = id;
}, { immediate: true });
// Its page once the list holds it (an operation just started comes with a later refresh).
watch([named, operations, table], async ([id]) => {
  if (id && table.value && operations.value.some((o) => o.id === id) && await table.value.reveal(id)) named.value = null;
});
const { error, loading, nextAt, run } = usePoll(async () => {
  operations.value = (await api<{ operations: Operation[] }>('/operations')).operations;
});
// A row's name (its toggle's, its steps'): its title and id, two operations having the same title.
const rowName = (o: Operation) => `${operationTitle(o)} (${o.id})`;
const running = computed(() => operations.value.filter((o) => o.status === 'running').length);

// What a target's cell shows: the account or project, the region, the router, or the manager's version.
const targetParts = (o: Operation) => [o.target.account, o.target.region, o.target.router, ...(o.type === 'update-manager' ? [`manager ${o.target.version}`] : [])].filter(Boolean);
// The progress in words: done/total, then the step running.
function progressText(o: Operation) {
  const { done, total, current } = operationProgress(o);
  return [`${done}/${total}`, ...(current ? [current] : [])].join(' · ');
}
const collator = new Intl.Collator('en-US', { sensitivity: 'accent' });
// Each column's words: what search reads and an export prints (an operation without its steps): the status' word and a
// failure's error, the target's parts and the operation's id, the date as ISO 8601. Sorted newest first.
const headers: DmHeader<Operation>[] = [
  { title: 'Operation', key: 'type', text: (o) => `${operationKind(o)} · ${operationTitle(o)}`,
    sortRaw: (a, b) => collator.compare(operationKind(a), operationKind(b)) || collator.compare(operationTitle(a), operationTitle(b)) },
  { title: 'Target', key: 'target', sortable: false, text: (o) => [...targetParts(o), o.id].join(' · ') },
  { title: 'Status', key: 'status', text: (o) => (o.status === 'failed' && o.error ? `failed: ${o.error}` : o.status) },
  { title: 'Progress', key: 'progress', sortable: false, text: progressText },
  { title: 'By', key: 'by' },
  { title: 'Started', key: 'createdAt', value: (o) => Date.parse(o.createdAt) },
];
const NEWEST = [{ key: 'createdAt', order: 'desc' as const }];

// Presentation: an icon per kind of operation; a status' and a step's mark (the running ones breathe).
const KIND_ICONS: Record<OperationType, string> = {
  onboard: mdiPlusCircleOutline, offboard: mdiMinusCircleOutline, 'install-router': mdiRouterNetwork, 'upgrade-router': mdiArrowUpBoldCircleOutline,
  'uninstall-router': mdiDeleteOutline, exclude: mdiCancel, 'lift-exclusion': mdiPlayCircleOutline, 'connect-account': mdiLinkVariant, 'disconnect-account': mdiLinkVariantOff,
  'update-manager': mdiUpdate,
};
const STATUS_MARKS: Record<Operation['status'], { icon: string; color: string }> = {
  running: { icon: mdiProgressClock, color: 'primary' }, succeeded: { icon: mdiCheckCircleOutline, color: 'success' }, failed: { icon: mdiAlertCircleOutline, color: 'error' },
};
const STEP_MARKS: Record<StepStatus, { icon: string; color?: string }> = {
  done: { icon: mdiCheck, color: 'success' }, skipped: { icon: mdiMinus }, running: { icon: mdiProgressClock, color: 'primary' }, pending: { icon: mdiCircleSmall },
  failed: { icon: mdiClose, color: 'error' },
};
// Who started it, split before the @ of an email (the cell breaks a line there if need be); a start's exact time is exactTime's.
const byParts = (by: string) => {
  const at = by.indexOf('@');
  return at > 0 ? [by.slice(0, at), by.slice(at)] : [by, ''];
};
</script>

<template>
  <div>
    <div class="d-flex flex-wrap align-center ga-4 mb-4">
      <PageTitle eyebrow="Organization" title="Operations">
        <template #after>
          <v-chip v-if="running" color="primary" variant="tonal" label class="dm-running"><span class="dm-pulse" aria-hidden="true" />{{ running }} running</v-chip>
        </template>
      </PageTitle>
      <v-spacer />
      <RefreshIndicator :next-at="nextAt" :loading="loading" @refresh="run" />
    </div>
    <p class="dm-lead text-medium-emphasis mt-n2 mb-6">Onboardings, offboardings and router installations, run step by step in the target account or project and region by
      AWS or Google Cloud API calls. A step waits for a lock, a slot or a resource being created; a failed onboarding is undone.</p>
    <v-alert v-if="error" type="error" class="mb-4" :text="error" />

    <v-card class="dm-operations">
      <DmTable ref="table" v-model:expanded="expanded" :headers="headers" :items="operations" :loading="loading && !operations.length" item-value="id" :sort-by="NEWEST"
        :row-name="rowName" expandable expand-title="Steps" :exported="{ name: 'operations', title: 'Operations' }">
        <template #loading><DmLoader label="Reading the operations…" :size="56" /></template>
        <template #no-data>
          <div class="dm-calm">
            <DmLogo state="sleep" :size="40" />
            <span class="text-medium-emphasis">No operation yet: onboardings, offboardings and router installations show here.</span>
          </div>
        </template>
        <template #[`item.type`]="{ item }">
          <div class="dm-op">
            <v-avatar :color="STATUS_MARKS[item.status].color" variant="tonal" rounded="lg" size="36" class="dm-op__icon"><v-icon :icon="KIND_ICONS[item.type]" size="20" aria-hidden="true" /></v-avatar>
            <div class="dm-op__titles">
              <div class="dm-op__kind">{{ operationKind(item) }}</div>
              <div class="dm-op__title">{{ operationTitle(item) }}</div>
            </div>
          </div>
        </template>
        <template #[`item.target`]="{ item }">
          <div class="dm-op__target">
            <div v-if="item.target.account || item.target.region" class="dm-op__where">
              <span v-if="item.target.account" class="mono">{{ item.target.account }}</span>
              <span v-if="item.target.region" class="dm-op__region"><RegionLabel :region="item.target.region" /><span class="mono">{{ item.target.region }}</span></span>
            </div>
            <div v-if="item.target.router" class="dm-op__router">{{ item.target.router }}</div>
            <div v-if="item.type === 'update-manager'" class="dm-op__router">manager {{ item.target.version }}</div>
            <div class="mono dm-op__id">{{ item.id }}</div>
          </div>
        </template>
        <!-- The status' icon alone: its word the icon's name, a failure's error in its tooltip. -->
        <template #[`item.status`]="{ item }">
          <StatusMark :icon="STATUS_MARKS[item.status].icon" :color="STATUS_MARKS[item.status].color" :label="item.status" :pulse="item.status === 'running'">
            <div v-if="item.status === 'failed' && item.error" class="dm-op__tip">{{ item.error }}</div>
          </StatusMark>
        </template>
        <template #[`item.progress`]="{ item }">
          <div class="dm-op__progress">
            <div class="dm-op__meter">
              <v-progress-linear :model-value="(100 * operationProgress(item).done) / (operationProgress(item).total || 1)" :color="STATUS_MARKS[item.status].color" height="4" rounded
                bg-opacity="0.14" class="dm-op__bar" :aria-label="`${operationProgress(item).done} of ${operationProgress(item).total} steps`" />
              <span class="dm-op__count">{{ operationProgress(item).done }}/{{ operationProgress(item).total }}</span>
            </div>
            <div v-if="operationProgress(item).current" class="dm-op__current text-body-small text-medium-emphasis">{{ operationProgress(item).current }}</div>
          </div>
        </template>
        <!-- An email on two lines if need be, before its @. -->
        <template #[`item.by`]="{ item }"><span class="dm-op__by">{{ byParts(item.by)[0] }}<wbr>{{ byParts(item.by)[1] }}</span></template>
        <template #[`item.createdAt`]="{ item }">
          <v-tooltip location="top" :text="exactTime(item.createdAt)" open-on-focus>
            <template #activator="{ props: tip }"><time v-bind="tip" :datetime="item.createdAt" tabindex="0" class="dm-op__when nowrap">{{ relative(item.createdAt, now) }}</time></template>
          </v-tooltip>
        </template>
        <!-- Under an operation's row: its error, its steps (a vertical stepper), a manager update's build; its id the one its
             toggle names. -->
        <template #expanded-row="{ item, columns, expandedId }">
          <tr class="dm-op-steps">
            <td :colspan="columns.length">
              <div :id="expandedId" class="dm-op__steps">
                <div v-if="item.error" class="dm-op__error text-error"><v-icon :icon="mdiAlertCircleOutline" size="16" aria-hidden="true" /><span>{{ item.error }}</span></div>
                <ol class="dm-steps" :aria-label="`Steps of ${rowName(item)}`">
                  <li v-for="step in item.steps" :key="step.name" class="dm-step" :class="`dm-step--${step.status}`">
                    <StatusMark :icon="STEP_MARKS[step.status].icon" :color="STEP_MARKS[step.status].color" :label="step.status" :pulse="step.status === 'running'" :size="14" class="dm-step__mark" />
                    <div class="dm-step__body">
                      <div class="dm-step__line"><span class="dm-step__name">{{ step.name }}</span> <span v-if="(step.attempts ?? 0) > 1" class="text-body-small text-medium-emphasis">({{ step.attempts }} attempts)</span></div>
                      <div v-if="step.detail" class="dm-step__detail">{{ step.detail }}</div>
                    </div>
                  </li>
                </ol>
                <a v-if="operationBuildLink(item)" :href="operationBuildLink(item)!" target="_blank" rel="noopener" class="dm-op__link text-body-small">View the build in CodeBuild<v-icon :icon="mdiOpenInNew" size="14" class="ms-1" /></a>
              </div>
            </td>
          </tr>
        </template>
      </DmTable>
    </v-card>
  </div>
</template>

<style scoped>
.dm-lead { max-width: 68rem; font-size: 0.98rem; line-height: 1.55; text-wrap: pretty; }
.dm-calm { display: flex; align-items: center; justify-content: center; gap: 14px; padding: 16px; text-align: start; }

/* "N running" beside the title: a dot that breathes. */
.dm-pulse { display: inline-block; flex: none; width: 7px; height: 7px; margin-inline-end: 7px; border-radius: 50%; background: currentColor; animation: dm-pulse 1.8s ease-in-out infinite; }
@keyframes dm-pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(var(--v-theme-primary), 0.5); } 60% { box-shadow: 0 0 0 6px rgba(var(--v-theme-primary), 0); } }

/* The table: room to breathe, cells aligned on their first line. */
.dm-operations :deep(.v-table__wrapper > table > tbody > tr:not(.v-data-table__tr--mobile):not(.dm-op-steps) > td:not(.v-data-table-column--no-padding)) { padding: 14px 12px !important; vertical-align: top; height: auto !important; }
.dm-operations :deep(.v-table__wrapper > table > tbody > tr:not(.v-data-table__tr--mobile):not(.dm-op-steps) > td.v-data-table-column--no-padding) { padding-top: 8px !important; vertical-align: top; }
.dm-operations :deep(.v-table__wrapper > table > thead > tr > th:not(.v-data-table-column--no-padding)) { padding-inline: 12px !important; }
.dm-operations :deep(.v-table__wrapper > table > * > tr > :first-child) { padding-inline-start: 18px !important; }
.dm-operations :deep(.v-table__wrapper > table > * > tr > :last-child) { padding-inline-end: 16px !important; }

.dm-op { display: flex; align-items: center; gap: 12px; min-width: 11.5rem; }
.dm-op__icon { flex: none; }
.dm-op__titles { min-width: 0; }
.dm-op__kind { font: 500 0.64rem/1.3 var(--dm-mono); letter-spacing: 0.12em; text-transform: uppercase; color: rgb(var(--v-theme-secondary)); }
.dm-op__title { margin-top: 2px; font-weight: 600; letter-spacing: -0.01em; line-height: 1.3; overflow-wrap: anywhere; }
.dm-op__target { display: grid; gap: 2px; min-width: 9.5rem; font-size: 0.8rem; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.dm-op__where { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 10px; }
.dm-op__region { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.dm-op__router { font-weight: 500; color: rgba(var(--v-theme-on-surface), var(--v-high-emphasis-opacity)); overflow-wrap: anywhere; }
/* An id breaks after its hyphens. */
.dm-op__id { font-size: 0.7rem; opacity: 0.7; }
.dm-op__by { font-size: 0.88rem; }
.dm-op__tip { max-width: 380px; overflow-wrap: anywhere; }
.dm-op__progress { min-width: 8rem; max-width: 12rem; }
.dm-op__meter { display: flex; align-items: center; gap: 10px; min-height: 20px; }
.dm-op__bar { flex: 1 1 auto; }
.dm-op__count { font: 500 0.78rem/1 var(--dm-mono); font-variant-numeric: tabular-nums; }
.dm-op__current { margin-top: 4px; overflow-wrap: anywhere; }
.dm-op__when { border-radius: 4px; }
.dm-op__when:focus-visible { outline: 2px solid rgb(var(--v-theme-secondary)); outline-offset: 2px; }

/* Under the row: the error, the steps as a vertical stepper (a rail between the marks), the build's link. */
.dm-op-steps > td { padding: 0 !important; height: auto !important; background: rgba(var(--v-theme-on-surface), 0.015); }
.dm-op__steps { padding: 14px 18px 12px 66px; }
.dm-op__error { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 12px; font-size: 0.88rem; line-height: 1.45; overflow-wrap: anywhere; }
.dm-op__error .v-icon { margin-top: 2px; }
.dm-steps { margin: 0; padding: 0; list-style: none; }
.dm-step { position: relative; display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 12px; padding-bottom: 12px; }
.dm-step:not(:last-child)::after { content: ""; position: absolute; left: 10px; top: 24px; bottom: 2px; width: 2px; border-radius: 1px; background: rgba(var(--v-theme-on-surface), 0.1); }
.dm-step--done:not(:last-child)::after, .dm-step--skipped:not(:last-child)::after { background: rgba(var(--v-theme-success), 0.35); }
.dm-steps :deep(.dm-step__mark) { width: 22px; height: 22px; border: 1.5px solid rgba(var(--v-theme-on-surface), 0.22); }
.dm-steps .dm-step--done :deep(.dm-step__mark) { border-color: transparent; background: rgba(var(--v-theme-success), 0.16); }
.dm-steps .dm-step--skipped :deep(.dm-step__mark) { border-style: dashed; }
.dm-steps .dm-step--failed :deep(.dm-step__mark) { border-color: transparent; background: rgba(var(--v-theme-error), 0.18); }
.dm-steps .dm-step--running :deep(.dm-step__mark) { border-color: transparent; background: rgba(var(--v-theme-primary), 0.14); }
.dm-step__line { min-height: 22px; padding-top: 1px; }
.dm-step__name { font-size: 0.92rem; font-weight: 500; }
.dm-step--failed .dm-step__name { color: rgb(var(--v-theme-error)); }
.dm-step--pending .dm-step__name, .dm-step--skipped .dm-step__name { color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.dm-step__detail { margin-top: 2px; font-size: 0.85rem; line-height: 1.45; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); overflow-wrap: anywhere; }
.dm-step--failed .dm-step__detail { color: rgb(var(--v-theme-error)); }
.dm-op__link { display: inline-flex; align-items: center; margin-top: 2px; }

@media (max-width: 600px) {
  .dm-op { min-width: 0; }
  .dm-op__steps { padding: 12px 14px 10px 16px; }
}
@media (prefers-reduced-motion: reduce) {
  .dm-pulse { animation: none; }
}
</style>
