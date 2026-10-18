<script setup lang="ts">
// Details of one router: health figures (Lambda, failure queues, IP lists) and its configuration with the source of each item.
// Its sections are cards in two columns of the router view's grid, the parent's own card (its slot) first; .dm-wide spans both.
import { computed, onMounted, ref } from 'vue';
import { mdiChartTimelineVariant, mdiCogOutline, mdiKubernetes, mdiShieldSearch } from '@mdi/js';
import { api } from '../api';
import { concurrencyText, listSourceHref, relative, ruleText } from '../format';
import { CLUSTER_ROLE } from '../kubernetes';
import { useNow } from '../now';
import { terraformSettingHelp } from '../router-actions';
import DmLoader from './DmLoader.vue';
import TerraformChip from './TerraformChip.vue';
import type { RouterDetails } from '../types';

// source: who installed the router, so where its configuration is changed.
const props = defineProps<{ name: string; source?: 'terraform' | 'manager' }>();
const now = useNow();
const details = ref<RouterDetails | null>(null);
const error = ref('');

onMounted(async () => {
  try {
    details.value = await api<RouterDetails>(`/routers/${encodeURIComponent(props.name)}`);
  } catch (err) {
    error.value = (err as Error).message;
  }
});
// Layout only: two columns that end at about the same height. The parent's card (the router's health, short) heads the
// first; the figures table, the tall one, stands beside it with at most one short card under the health, else the
// clusters and the IP lists share the second column.
type Section = 'figures' | 'clusters' | 'ipLists';
const columns = computed<Section[][]>(() => {
  const d = details.value;
  if (!d) return [[], []];
  const extra: Section[] = [...(d.clusters?.length ? ['clusters' as const] : []), ...(d.health.ipLists.length ? ['ipLists' as const] : [])];
  return extra.length === 2 ? [['figures'], extra] : [extra, ['figures']];
});
</script>

<template>
  <!-- Two columns of cards: the parent's (the slot) heads the first; the figures, the clusters and the IP lists where
       `columns` puts them; the configuration spans both under them. -->
  <div v-for="(column, ci) in columns" :key="ci" class="dm-col">
    <slot v-if="ci === 0" />
    <template v-else>
      <v-alert v-if="error" type="error" variant="tonal" density="compact" class="dm-detail--figures" :text="error" />
      <v-card v-else-if="!details" class="dm-detail--figures"><DmLoader label="Reading its figures…" :size="48" /></v-card>
    </template>
    <template v-if="details">
      <template v-for="key in column" :key="key">
        <v-card v-if="key === 'figures'" class="dm-detail dm-detail--figures">
          <v-card-item class="dm-detail__head">
            <template #prepend><v-avatar color="primary" variant="tonal" rounded="lg" size="34"><v-icon :icon="mdiChartTimelineVariant" size="19" /></v-avatar></template>
            <v-card-title>Health figures</v-card-title>
          </v-card-item>
          <v-table density="compact" class="dm-facts">
            <tbody>
              <tr><th>Idle check</th>
                <td>{{ details.health.checkSchedule ?? '—' }}, last scheduled run {{ relative(details.health.lastScheduledCheckAt, now) }}</td></tr>
              <tr v-if="details.health.lambda.error"><th>Lambda (24 hours)</th><td class="text-warning">{{ details.health.lambda.error }}</td></tr>
              <template v-else>
                <tr v-if="details.health.lambda.controller"><th>Controller (24 hours)</th>
                  <td>{{ details.health.lambda.controller.errors }} errors, {{ details.health.lambda.controller.throttles }} throttles</td></tr>
                <tr v-if="details.health.lambda.waker"><th>Waker (24 hours)</th>
                  <td>{{ details.health.lambda.waker.errors }} errors, {{ details.health.lambda.waker.throttles }} throttles, peak concurrency {{ details.health.lambda.waker.peakConcurrency }}</td></tr>
              </template>
              <tr><th>Failure queues</th>
                <td v-if="details.health.queues.error" class="text-warning">{{ details.health.queues.error }}</td>
                <td v-else>check-failures {{ details.health.queues.check ?? '—' }}, controller-failures {{ details.health.queues.controller ?? '—' }}</td></tr>
              <tr><th>Lambda concurrency</th>
                <td :class="{ 'text-warning': details.health.concurrency?.error }">{{ concurrencyText(details.health.concurrency) }}</td></tr>
            </tbody>
          </v-table>
        </v-card>

        <v-card v-else-if="key === 'clusters'" class="dm-detail dm-detail--clusters" data-test="clusters">
          <v-card-item class="dm-detail__head">
            <template #prepend><v-avatar color="primary" variant="tonal" rounded="lg" size="34"><v-icon :icon="mdiKubernetes" size="19" /></v-avatar></template>
            <v-card-title>EKS clusters</v-card-title>
          </v-card-item>
          <p class="dm-detail__note text-body-small text-medium-emphasis">Its access to the clusters of its account and region, as its last install, upgrade or
            onboarding checked it.</p>
          <v-table density="compact" class="dm-facts">
            <tbody>
              <tr v-for="c in details.clusters" :key="c.name">
                <th><span class="dm-dot" :class="c.allowed ? 'dm-dot--success' : 'dm-dot--warning'" aria-hidden="true" />{{ c.name }}</th>
                <td :class="{ 'text-warning': !c.allowed }">
                  <template v-if="!c.reachable">unreachable: {{ c.reason }}</template>
                  <template v-else-if="c.allowed">reachable, every right</template>
                  <template v-else-if="c.missing.length">missing {{ c.missing.join('; ') }}: {{ CLUSTER_ROLE }}</template>
                  <template v-else>{{ c.reason }}</template>
                  <span class="dm-detail__when"> checked {{ relative(c.checkedAt, now) }}</span>
                </td>
              </tr>
            </tbody>
          </v-table>
        </v-card>

        <v-card v-else-if="key === 'ipLists'" class="dm-detail dm-detail--ip-lists">
          <v-card-item class="dm-detail__head">
            <template #prepend><v-avatar color="primary" variant="tonal" rounded="lg" size="34"><v-icon :icon="mdiShieldSearch" size="19" /></v-avatar></template>
            <v-card-title>IP lists</v-card-title>
          </v-card-item>
          <v-table density="compact" class="dm-facts">
            <tbody>
              <tr v-for="l in details.health.ipLists" :key="l.name">
                <th><span class="dm-dot" :class="l.error && !l.pending ? 'dm-dot--warning' : l.error ? '' : 'dm-dot--success'" aria-hidden="true" />IP list {{ l.name }}<span
                  v-if="l.source === 'manager'" class="dm-detail__source"> (manager)</span></th>
                <td :class="{ 'text-warning': l.error && !l.pending }" class="dm-num">{{ l.error ?? `${l.entries.toLocaleString()} entries, downloaded ${relative(l.fetchedAt, now)}` }}</td>
              </tr>
            </tbody>
          </v-table>
        </v-card>
      </template>
    </template>
  </div>
  <template v-if="details">
    <v-card class="dm-detail dm-wide">
      <v-card-item class="dm-detail__head">
        <template #prepend><v-avatar color="primary" variant="tonal" rounded="lg" size="34"><v-icon :icon="mdiCogOutline" size="19" /></v-avatar></template>
        <v-card-title>Configuration</v-card-title>
      </v-card-item>
      <p v-if="source === 'manager'" class="dm-detail__note text-body-small text-medium-emphasis">Set by the manager when it installs or upgrades the router: an idle
        check every 5 minutes, the built-in no-wake rules, no metrics, and the manager's IP lists (<code>ip_lists</code> in the manager's Terraform).
        Not editable from the dashboard yet.</p>
      <p v-else-if="source === 'terraform'" class="dm-detail__note text-body-small text-medium-emphasis">Set in this router's Terraform (the router module's
        <code>check_schedule</code>, <code>no_wake_rules</code>, <code>ip_lists</code> and <code>metrics_enabled</code>): change them there and apply.</p>
      <v-table density="compact" class="dm-facts dm-facts--config">
        <tbody>
          <tr><th>Idle check schedule</th><td><span class="mono">{{ details.configuration.checkSchedule.value ?? '—' }}</span></td>
            <td class="dm-facts__src"><TerraformChip v-if="details.configuration.checkSchedule.source === 'terraform'" size="x-small" variant="tonal" :text="terraformSettingHelp" /></td></tr>
          <tr><th>Wake statistics metrics</th><td>{{ details.configuration.metrics.value === null ? '—' : details.configuration.metrics.value ? 'published' : 'off' }}</td>
            <td class="dm-facts__src"><TerraformChip v-if="details.configuration.metrics.source === 'terraform'" size="x-small" variant="tonal" :text="terraformSettingHelp" /></td></tr>
          <tr><th>IP lists</th>
            <td>
              <div v-for="l in details.configuration.ipLists.value" :key="l.name" class="dm-facts__item">
                <a v-if="listSourceHref(l.url)" :href="listSourceHref(l.url) ?? undefined" target="_blank" rel="noopener">{{ l.name }}</a><span v-else class="font-weight-medium">{{ l.name }}</span>
                <span class="text-medium-emphasis"> ({{ l.action }}, every {{ l.refreshHours }} h)</span>
              </div>
              <span v-if="!details.configuration.ipLists.value.length" class="text-medium-emphasis">none</span>
            </td>
            <td class="dm-facts__src"><TerraformChip v-if="details.configuration.ipLists.source === 'terraform'" size="x-small" variant="tonal" :text="terraformSettingHelp" /></td></tr>
          <tr v-if="details.configuration.ipListsCatalog"><th>The manager's IP lists</th>
            <td>
              <div v-for="l in details.configuration.ipListsCatalog.value.lists" :key="l.name" class="dm-facts__item"><span class="font-weight-medium">{{ l.name }}</span><span
                class="text-medium-emphasis"> ({{ l.action }}, every {{ l.refreshHours }} h)</span></div>
              <span v-if="!details.configuration.ipListsCatalog.value.lists.length" class="text-medium-emphasis">none</span>
            </td>
            <td class="dm-facts__src"><TerraformChip v-if="details.configuration.ipListsCatalog.source === 'terraform'" size="x-small" variant="tonal" :text="terraformSettingHelp" /></td></tr>
          <tr><th>Router no-wake rules</th>
            <td>
              <div v-for="r in details.configuration.noWakeRules.value" :key="r.name" class="dm-facts__item"><strong>{{ r.name }}</strong>: {{ r.invalid ? `invalid, ${r.invalid}` : ruleText(r.conditions) }}</div>
              <span v-if="!details.configuration.noWakeRules.value.length" class="text-medium-emphasis">none</span>
            </td>
            <td class="dm-facts__src"><TerraformChip v-if="details.configuration.noWakeRules.source === 'terraform'" size="x-small" variant="tonal" :text="terraformSettingHelp" /></td></tr>
        </tbody>
      </v-table>
    </v-card>
  </template>
</template>

<style scoped>
.dm-wide { grid-column: 1 / -1; }
.dm-col { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
/* One column (the parent's grid below 960 px): the cards in their reading order, the health first. */
@media (max-width: 960px) {
  .dm-col { display: contents; }
  .dm-detail--figures { order: 1; }
  .dm-detail--clusters { order: 2; }
  .dm-detail--ip-lists { order: 3; }
  .dm-wide { order: 4; }
}
.dm-detail { display: flex; flex-direction: column; min-width: 0; }
.dm-detail__head { padding: 16px 16px 6px !important; }
.dm-detail__head :deep(.v-card-title) { padding-top: 0 !important; }
.dm-detail__note { margin: 0 16px 8px; max-width: 60rem; text-wrap: pretty; }
.dm-detail__when { color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); font-size: 0.85em; }
.dm-detail__source { color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); font-weight: 400; }
.dm-num { font-variant-numeric: tabular-nums; }

/* Label and value rows: a quiet label column, the values aligned on their first line. */
.dm-facts { padding: 0 8px 10px; }
.dm-facts th { width: 38%; min-width: 9rem; padding-top: 9px !important; padding-bottom: 9px !important; vertical-align: top; text-align: start;
  font-weight: 400 !important; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.dm-facts td { padding-top: 9px !important; padding-bottom: 9px !important; vertical-align: top; height: auto !important; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.dm-facts tr:last-child > th, .dm-facts tr:last-child > td { border-bottom: 0 !important; }
.dm-facts--config th { width: 30%; }
.dm-facts__src { width: 1%; white-space: nowrap; text-align: end; }
.dm-facts__item + .dm-facts__item { margin-top: 2px; }
.dm-facts a { color: rgb(var(--v-theme-primary)); font-weight: 500; text-decoration: none; }
.dm-facts a:hover { text-decoration: underline; text-underline-offset: 3px; }

.dm-dot { display: inline-block; width: 7px; height: 7px; margin-inline-end: 8px; border-radius: 50%; vertical-align: 0.1em; background: rgba(var(--v-theme-on-surface), 0.3); }
.dm-dot--success { background: rgb(var(--v-theme-success)); box-shadow: 0 0 0 3px rgba(var(--v-theme-success), 0.16); }
.dm-dot--warning { background: rgb(var(--v-theme-warning)); box-shadow: 0 0 0 3px rgba(var(--v-theme-warning), 0.16); }

@media (max-width: 600px) {
  .dm-facts th { width: auto; min-width: 7rem; }
}
</style>
