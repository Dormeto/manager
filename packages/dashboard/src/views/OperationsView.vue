<script setup lang="ts">
// Operations (onboarding, R4b): onboardings, offboardings and router installations run by the workflow, with their steps.
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import {
  mdiAlertCircleOutline, mdiArrowDown, mdiArrowUp, mdiArrowUpBoldCircleOutline, mdiCancel, mdiCheck, mdiChevronDown, mdiClose, mdiDeleteOutline, mdiLinkVariant, mdiLinkVariantOff,
  mdiMinus, mdiMinusCircleOutline, mdiPlayCircleOutline, mdiPlusCircleOutline, mdiRouterNetwork,
} from '@mdi/js';
import { api } from '../api';
import { relative } from '../format';
import { useNow } from '../now';
import { operationProgress, operationTitle } from '../operations';
import { usePoll } from '../poll';
import DmLoader from '../components/DmLoader.vue';
import DmLogo from '../components/DmLogo.vue';
import RefreshIndicator from '../components/RefreshIndicator.vue';
import RegionLabel from '../components/RegionLabel.vue';
import type { Operation, OperationType } from '../types';

const now = useNow();
const operations = ref<Operation[]>([]);
// An operation a notice links to (?id=) opens with its steps.
const route = useRoute();
const expanded = ref<string[]>(typeof route.query.id === 'string' ? [route.query.id] : []);
const page = ref(1);
const { error, loading, nextAt, run } = usePoll(async () => {
  operations.value = (await api<{ operations: Operation[] }>('/operations')).operations;
});
const running = computed(() => operations.value.filter((o) => o.status === 'running').length);
// Sorting and the page size, as the table had them: a key sorts ascending, then descending, then no more (newest first, as
// the API lists them); 25 a page, or as many as chosen.
type SortKey = 'status' | 'by' | 'createdAt';
const SORTS: { key: SortKey; title: string }[] = [{ key: 'status', title: 'Status' }, { key: 'by', title: 'By' }, { key: 'createdAt', title: 'Started' }];
const sortBy = ref<{ key: SortKey; order: 'asc' | 'desc' }[]>([]);
const sortOf = (key: SortKey) => sortBy.value.find((s) => s.key === key)?.order;
function sortOn(key: SortKey) {
  const order = sortOf(key);
  sortBy.value = !order ? [{ key, order: 'asc' }] : order === 'asc' ? [{ key, order: 'desc' }] : [];
}
const PER_PAGE = [{ title: '10', value: 10 }, { title: '25', value: 25 }, { title: '50', value: 50 }, { title: '100', value: 100 }, { title: 'All', value: -1 }];
const perPage = ref(25);
watch([sortBy, perPage], () => { page.value = 1; });
const statusColor = (s: Operation['status']) => ({ running: 'primary', succeeded: 'success', failed: 'error' })[s];

// Presentation: an icon per kind of operation, one per status.
const KIND_ICONS: Record<OperationType, string> = {
  onboard: mdiPlusCircleOutline, offboard: mdiMinusCircleOutline, 'install-router': mdiRouterNetwork, 'upgrade-router': mdiArrowUpBoldCircleOutline,
  'uninstall-router': mdiDeleteOutline, exclude: mdiCancel, 'lift-exclusion': mdiPlayCircleOutline, 'connect-account': mdiLinkVariant, 'disconnect-account': mdiLinkVariantOff,
};
const STATUS_ICONS: Partial<Record<Operation['status'], string>> = { succeeded: mdiCheck, failed: mdiAlertCircleOutline };
const kind = (op: Operation) => op.type.replace(/-/g, ' ');
// An operation's steps, shown or hidden (the ids in expanded).
const isOpen = (id: string) => expanded.value.includes(id);
const toggle = (id: string) => { expanded.value = isOpen(id) ? expanded.value.filter((x) => x !== id) : [...expanded.value, id]; };
</script>

<template>
  <!-- A list of cards, its content on their left: a centred column on a wide screen rather than cards wider than it. -->
  <div class="dm-narrow">
    <div class="d-flex flex-wrap align-end ga-4 mb-6">
      <div>
        <div class="dm-eyebrow mb-1">Organization</div>
        <div class="d-flex flex-wrap align-center ga-3">
          <h1 class="text-headline-small">Operations</h1>
          <v-chip v-if="running" color="primary" variant="tonal" label class="dm-running"><span class="dm-pulse" aria-hidden="true" />{{ running }} running</v-chip>
        </div>
      </div>
      <v-spacer />
      <RefreshIndicator :next-at="nextAt" :loading="loading" @refresh="run" />
    </div>
    <p class="dm-lead text-medium-emphasis mt-n2 mb-6">Onboardings, offboardings and router installations, run step by step in the target account and region by
      AWS API calls. A step waits for a lock, a slot or a resource being created; a failed onboarding is undone.</p>
    <v-alert v-if="error" type="error" class="mb-4" :text="error" />

    <div v-if="operations.length" class="dm-ops-tools">
      <span class="dm-ops-tools__label">Sort</span>
      <v-btn v-for="s in SORTS" :key="s.key" data-test="sort" size="small" :variant="sortOf(s.key) ? 'tonal' : 'text'" :color="sortOf(s.key) ? 'primary' : undefined"
        :append-icon="sortOf(s.key) === 'asc' ? mdiArrowUp : sortOf(s.key) === 'desc' ? mdiArrowDown : undefined" :aria-pressed="Boolean(sortOf(s.key))"
        :aria-label="`Sort by ${s.title.toLowerCase()}${sortOf(s.key) ? (sortOf(s.key) === 'asc' ? ', ascending' : ', descending') : ''}`" @click="sortOn(s.key)">{{ s.title }}</v-btn>
      <v-spacer />
      <v-select v-model="perPage" :items="PER_PAGE" label="Per page" density="compact" hide-details class="dm-ops-tools__size" />
    </div>

    <v-data-iterator v-model:page="page" :items="operations" item-value="id" :sort-by="sortBy" :items-per-page="perPage" :loading="loading && !operations.length">
      <template #loader><v-card><DmLoader label="Reading the operations…" /></v-card></template>
      <template #no-data>
        <v-card>
          <v-card-text class="dm-calm">
            <DmLogo state="sleep" :size="40" />
            <span class="text-medium-emphasis">No operation yet: onboardings, offboardings and router installations show here.</span>
          </v-card-text>
        </v-card>
      </template>
      <template #default="{ items }">
        <ol class="dm-ops">
          <li v-for="op in items" :key="op.raw.id">
            <v-card class="dm-op" :class="`dm-op--${op.raw.status}`">
              <div class="dm-op__head">
                <v-avatar :color="statusColor(op.raw.status)" variant="tonal" rounded="lg" size="40" class="dm-op__icon"><v-icon :icon="KIND_ICONS[op.raw.type]" size="21" /></v-avatar>
                <div class="dm-op__titles">
                  <div class="dm-op__kind">{{ kind(op.raw) }}</div>
                  <div class="dm-op__title">{{ operationTitle(op.raw) }}</div>
                </div>
                <v-chip :color="statusColor(op.raw.status)" variant="tonal" label class="dm-op__status" :prepend-icon="STATUS_ICONS[op.raw.status]">
                  <span v-if="op.raw.status === 'running'" class="dm-pulse" aria-hidden="true" />{{ op.raw.status }}</v-chip>
              </div>

              <div class="dm-op__body">
                <div class="dm-op__target">
                  <span v-if="op.raw.target.account" class="mono">{{ op.raw.target.account }}</span>
                  <span v-if="op.raw.target.region" class="dm-op__region"><RegionLabel :region="op.raw.target.region" /><span class="mono">{{ op.raw.target.region }}</span></span>
                  <span v-if="op.raw.target.router" class="dm-op__router">{{ op.raw.target.router }}</span>
                  <span class="mono dm-op__id">{{ op.raw.id }}</span>
                </div>
                <div class="dm-op__progress">
                  <v-progress-linear :model-value="(100 * operationProgress(op.raw).done) / operationProgress(op.raw).total" :color="statusColor(op.raw.status)" height="4" rounded
                    bg-opacity="0.14" class="dm-op__bar" :aria-label="`${operationProgress(op.raw).done} of ${operationProgress(op.raw).total} steps`" />
                  <span class="dm-op__count">{{ operationProgress(op.raw).done }}/{{ operationProgress(op.raw).total }}</span>
                </div>
                <div v-if="operationProgress(op.raw).current" class="dm-op__current text-body-small text-medium-emphasis">{{ operationProgress(op.raw).current }}</div>
                <div v-if="op.raw.error" class="dm-op__error text-body-small text-error">{{ op.raw.error }}</div>
                <div class="dm-op__foot">
                  <span><span class="dm-op__label">By</span> {{ op.raw.by }}</span>
                  <span><span class="dm-op__label">Started</span> <span class="nowrap">{{ relative(op.raw.createdAt, now) }}</span></span>
                  <v-spacer />
                  <v-btn variant="text" size="small" class="dm-op__toggle" :class="{ 'is-open': isOpen(op.raw.id) }" :append-icon="mdiChevronDown"
                    :aria-expanded="isOpen(op.raw.id)" :aria-controls="`steps-${op.raw.id}`" @click="toggle(op.raw.id)">Steps</v-btn>
                </div>
              </div>

              <v-expand-transition>
                <div v-if="isOpen(op.raw.id)" :id="`steps-${op.raw.id}`" class="dm-op__steps">
                  <ol class="dm-steps">
                    <li v-for="step in op.raw.steps" :key="step.name" class="dm-step" :class="`dm-step--${step.status}`">
                      <span class="dm-step__mark" aria-hidden="true">
                        <v-icon v-if="step.status === 'done'" :icon="mdiCheck" size="13" />
                        <DmLogo v-else-if="step.status === 'running'" state="load" :size="20" :zzz="false" />
                        <v-icon v-else-if="step.status === 'failed'" :icon="mdiClose" size="13" />
                        <v-icon v-else-if="step.status === 'skipped'" :icon="mdiMinus" size="13" />
                      </span>
                      <div class="dm-step__body">
                        <div class="dm-step__line">
                          <span class="dm-step__name">{{ step.name }}</span>
                          <span class="dm-step__status">{{ step.status }}</span>
                          <span v-if="(step.attempts ?? 0) > 1" class="text-body-small text-medium-emphasis">({{ step.attempts }} attempts)</span>
                        </div>
                        <div v-if="step.detail" class="dm-step__detail">{{ step.detail }}</div>
                      </div>
                    </li>
                  </ol>
                </div>
              </v-expand-transition>
            </v-card>
          </li>
        </ol>
      </template>
      <template #footer="{ pageCount }">
        <v-pagination v-if="pageCount > 1" v-model="page" :length="pageCount" density="comfortable" rounded="lg" class="mt-4" />
      </template>
    </v-data-iterator>
  </div>
</template>

<style scoped>
.dm-narrow { max-width: 1120px; margin-inline: auto; }
.dm-lead { max-width: 68rem; font-size: 0.98rem; line-height: 1.55; text-wrap: pretty; }
.dm-calm { display: flex; align-items: center; justify-content: center; gap: 14px; padding: 32px 16px !important; text-align: start; }

/* Sorting and the page size, above the cards. */
.dm-ops-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 14px; }
.dm-ops-tools__label { margin-inline-end: 4px; font: 500 0.64rem/1 var(--dm-mono); letter-spacing: 0.1em; text-transform: uppercase; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.dm-ops-tools__size { flex: 0 0 132px; }

/* "running": a dot that breathes. */
.dm-pulse { display: inline-block; flex: none; width: 7px; height: 7px; margin-inline-end: 7px; border-radius: 50%; background: currentColor; animation: dm-pulse 1.8s ease-in-out infinite; }
@keyframes dm-pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(var(--v-theme-primary), 0.5); } 60% { box-shadow: 0 0 0 6px rgba(var(--v-theme-primary), 0); } }

/* The operations: a column of cards, newest first; a status rail on the left edge. */
.dm-ops { display: grid; gap: 16px; margin: 0; padding: 0; list-style: none; }
.dm-op { position: relative; overflow: hidden; }
.dm-op::before { content: ""; position: absolute; left: 0; top: 18px; bottom: 18px; width: 3px; border-radius: 0 3px 3px 0; background: rgba(var(--v-theme-on-surface), 0.12); }
.dm-op--running::before { background: rgb(var(--v-theme-primary)); }
.dm-op--failed::before { background: rgb(var(--v-theme-error)); }
.dm-op--succeeded::before { background: rgba(var(--v-theme-success), 0.55); }

.dm-op__head { display: flex; align-items: center; gap: 14px; padding: 16px 18px 0 20px; }
.dm-op__icon { flex: none; }
.dm-op__titles { flex: 1; min-width: 0; }
.dm-op__kind { font: 500 0.66rem/1.3 var(--dm-mono); letter-spacing: 0.12em; text-transform: uppercase; color: rgb(var(--v-theme-secondary)); }
.dm-op__title { margin-top: 2px; font-size: 1.02rem; font-weight: 600; letter-spacing: -0.015em; line-height: 1.3; overflow-wrap: anywhere; }
.dm-op__status { flex: none; align-self: flex-start; }

.dm-op__body { padding: 10px 18px 12px 74px; }
.dm-op__target { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; font-size: 0.8rem; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.dm-op__region { display: inline-flex; align-items: center; gap: 6px; }
.dm-op__router { font-weight: 500; color: rgba(var(--v-theme-on-surface), var(--v-high-emphasis-opacity)); }
.dm-op__id { opacity: 0.7; overflow-wrap: anywhere; }
.dm-op__progress { display: flex; align-items: center; gap: 12px; margin-top: 12px; }
.dm-op__bar { flex: 1 1 auto; max-width: 320px; }
.dm-op__count { font: 500 0.78rem/1 var(--dm-mono); font-variant-numeric: tabular-nums; }
.dm-op__current { margin-top: 6px; overflow-wrap: anywhere; }
.dm-op__error { margin-top: 6px; overflow-wrap: anywhere; }
.dm-op__foot { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 18px; margin-top: 8px; font-size: 0.82rem; }
.dm-op__label { margin-inline-end: 4px; font: 500 0.64rem/1 var(--dm-mono); letter-spacing: 0.1em; text-transform: uppercase; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.dm-op__toggle { margin-inline-end: -8px; }
.dm-op__toggle :deep(.v-btn__append) { transition: transform 0.3s var(--dm-ease); }
.dm-op__toggle.is-open :deep(.v-btn__append) { transform: rotate(180deg); }

/* The steps: a vertical stepper, a rail between the marks. */
.dm-op__steps { border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); background: rgba(var(--v-theme-on-surface), 0.015); }
.dm-steps { padding: 16px 18px 12px 74px; list-style: none; }
.dm-step { position: relative; display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 12px; padding-bottom: 12px; }
.dm-step:not(:last-child)::after { content: ""; position: absolute; left: 10px; top: 24px; bottom: 2px; width: 2px; border-radius: 1px; background: rgba(var(--v-theme-on-surface), 0.1); }
.dm-step--done:not(:last-child)::after, .dm-step--skipped:not(:last-child)::after { background: rgba(var(--v-theme-success), 0.35); }
.dm-step__mark { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; border: 1.5px solid rgba(var(--v-theme-on-surface), 0.22); }
.dm-step--done .dm-step__mark { border-color: transparent; background: rgba(var(--v-theme-success), 0.16); color: rgb(var(--v-theme-success)); }
.dm-step--skipped .dm-step__mark { border-style: dashed; color: rgba(var(--v-theme-on-surface), 0.5); }
.dm-step--failed .dm-step__mark { border-color: transparent; background: rgba(var(--v-theme-error), 0.18); color: rgb(var(--v-theme-error)); }
.dm-step--running .dm-step__mark { border-color: transparent; }
.dm-step__line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; min-height: 22px; padding-top: 1px; }
.dm-step__name { font-size: 0.92rem; font-weight: 500; }
.dm-step__status { font: 500 0.64rem/1 var(--dm-mono); letter-spacing: 0.1em; text-transform: uppercase; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.dm-step--done .dm-step__status { color: rgb(var(--v-theme-success)); }
.dm-step--running .dm-step__status { color: rgb(var(--v-theme-primary)); }
.dm-step--failed .dm-step__status, .dm-step--failed .dm-step__name { color: rgb(var(--v-theme-error)); }
.dm-step--pending .dm-step__name, .dm-step--skipped .dm-step__name { color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.dm-step__detail { margin-top: 2px; font-size: 0.85rem; line-height: 1.45; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); overflow-wrap: anywhere; }
.dm-step--failed .dm-step__detail { color: rgb(var(--v-theme-error)); }

@media (max-width: 600px) {
  .dm-op__head { padding: 14px 14px 0 16px; gap: 12px; flex-wrap: wrap; }
  .dm-op__body { padding: 10px 14px 12px 16px; }
  .dm-steps { padding: 14px 14px 10px 16px; }
}
@media (prefers-reduced-motion: reduce) {
  .dm-pulse { animation: none; }
  .dm-op__toggle :deep(.v-btn__append) { transition: none; }
}
</style>
