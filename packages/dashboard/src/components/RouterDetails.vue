<script setup lang="ts">
// Details of one router: health figures (Lambda, failure queues, IP lists) and its configuration with the source of each item.
import { onMounted, ref } from 'vue';
import { api } from '../api';
import { concurrencyText, listSourceHref, relative, ruleText } from '../format';
import { CLUSTER_ROLE } from '../kubernetes';
import { useNow } from '../now';
import { terraformSettingHelp } from '../router-actions';
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
</script>

<template>
  <div class="pa-4">
    <v-alert v-if="error" type="error" variant="tonal" density="compact" :text="error" />
    <v-progress-linear v-else-if="!details" indeterminate color="primary" />
    <v-row v-else dense>
      <v-col cols="12" md="6">
        <div class="text-title-small mb-2">Health</div>
        <v-table density="compact">
          <tbody>
            <tr><th class="font-weight-regular text-medium-emphasis">Idle check</th>
              <td>{{ details.health.checkSchedule ?? '—' }}, last scheduled run {{ relative(details.health.lastScheduledCheckAt, now) }}</td></tr>
            <tr v-if="details.health.lambda.error"><th class="font-weight-regular text-medium-emphasis">Lambda (24 hours)</th><td class="text-warning">{{ details.health.lambda.error }}</td></tr>
            <template v-else>
              <tr v-if="details.health.lambda.controller"><th class="font-weight-regular text-medium-emphasis">Controller (24 hours)</th>
                <td>{{ details.health.lambda.controller.errors }} errors, {{ details.health.lambda.controller.throttles }} throttles</td></tr>
              <tr v-if="details.health.lambda.waker"><th class="font-weight-regular text-medium-emphasis">Waker (24 hours)</th>
                <td>{{ details.health.lambda.waker.errors }} errors, {{ details.health.lambda.waker.throttles }} throttles, peak concurrency {{ details.health.lambda.waker.peakConcurrency }}</td></tr>
            </template>
            <tr><th class="font-weight-regular text-medium-emphasis">Failure queues</th>
              <td v-if="details.health.queues.error" class="text-warning">{{ details.health.queues.error }}</td>
              <td v-else>check-failures {{ details.health.queues.check ?? '—' }}, controller-failures {{ details.health.queues.controller ?? '—' }}</td></tr>
            <tr><th class="font-weight-regular text-medium-emphasis">Lambda concurrency</th>
              <td :class="{ 'text-warning': details.health.concurrency?.error }">{{ concurrencyText(details.health.concurrency) }}</td></tr>
            <tr v-for="l in details.health.ipLists" :key="l.name"><th class="font-weight-regular text-medium-emphasis">IP list {{ l.name }}{{ l.source === 'manager' ? ' (manager)' : '' }}</th>
              <td :class="{ 'text-warning': l.error && !l.pending }">{{ l.error ?? `${l.entries.toLocaleString()} entries, downloaded ${relative(l.fetchedAt, now)}` }}</td></tr>
          </tbody>
        </v-table>
      </v-col>
      <v-col v-if="details.clusters?.length" cols="12" md="6" data-test="clusters">
        <div class="text-title-small mb-2">EKS clusters</div>
        <p class="text-body-small text-medium-emphasis mb-2">Its access to the clusters of its account and region, as its last install, upgrade or
          onboarding checked it.</p>
        <v-table density="compact">
          <tbody>
            <tr v-for="c in details.clusters" :key="c.name">
              <th class="font-weight-regular text-medium-emphasis">{{ c.name }}</th>
              <td :class="{ 'text-warning': !c.allowed }">
                <template v-if="!c.reachable">unreachable: {{ c.reason }}</template>
                <template v-else-if="c.allowed">reachable, every right</template>
                <template v-else-if="c.missing.length">missing {{ c.missing.join('; ') }}: {{ CLUSTER_ROLE }}</template>
                <template v-else>{{ c.reason }}</template>
                <span class="text-medium-emphasis"> checked {{ relative(c.checkedAt, now) }}</span>
              </td>
            </tr>
          </tbody>
        </v-table>
      </v-col>
      <v-col cols="12" md="6">
        <div class="text-title-small mb-2">Configuration</div>
        <p v-if="source === 'manager'" class="text-body-small text-medium-emphasis mb-2">Set by the manager when it installs or upgrades the router: an idle
          check every 5 minutes, the built-in no-wake rules, no metrics, and the manager's IP lists (<code>ip_lists</code> in the manager's Terraform).
          Not editable from the dashboard yet.</p>
        <p v-else-if="source === 'terraform'" class="text-body-small text-medium-emphasis mb-2">Set in this router's Terraform (the router module's
          <code>check_schedule</code>, <code>no_wake_rules</code>, <code>ip_lists</code> and <code>metrics_enabled</code>): change them there and apply.</p>
        <v-table density="compact">
          <tbody>
            <tr><th class="font-weight-regular text-medium-emphasis">Idle check schedule</th><td>{{ details.configuration.checkSchedule.value ?? '—' }}</td>
              <td><TerraformChip v-if="details.configuration.checkSchedule.source === 'terraform'" size="x-small" variant="tonal" :text="terraformSettingHelp" /></td></tr>
            <tr><th class="font-weight-regular text-medium-emphasis">Wake statistics metrics</th><td>{{ details.configuration.metrics.value === null ? '—' : details.configuration.metrics.value ? 'published' : 'off' }}</td>
              <td><TerraformChip v-if="details.configuration.metrics.source === 'terraform'" size="x-small" variant="tonal" :text="terraformSettingHelp" /></td></tr>
            <tr><th class="font-weight-regular text-medium-emphasis">IP lists</th>
              <td>
                <div v-for="l in details.configuration.ipLists.value" :key="l.name">
                  <a v-if="listSourceHref(l.url)" :href="listSourceHref(l.url) ?? undefined" target="_blank" rel="noopener">{{ l.name }}</a><span v-else>{{ l.name }}</span>
                  ({{ l.action }}, every {{ l.refreshHours }} h)
                </div>
                <span v-if="!details.configuration.ipLists.value.length" class="text-medium-emphasis">none</span>
              </td>
              <td><TerraformChip v-if="details.configuration.ipLists.source === 'terraform'" size="x-small" variant="tonal" :text="terraformSettingHelp" /></td></tr>
            <tr v-if="details.configuration.ipListsCatalog"><th class="font-weight-regular text-medium-emphasis">The manager's IP lists</th>
              <td>
                <div v-for="l in details.configuration.ipListsCatalog.value.lists" :key="l.name">{{ l.name }} ({{ l.action }}, every {{ l.refreshHours }} h)</div>
                <span v-if="!details.configuration.ipListsCatalog.value.lists.length" class="text-medium-emphasis">none</span>
              </td>
              <td><TerraformChip v-if="details.configuration.ipListsCatalog.source === 'terraform'" size="x-small" variant="tonal" :text="terraformSettingHelp" /></td></tr>
            <tr><th class="font-weight-regular text-medium-emphasis">Router no-wake rules</th>
              <td>
                <div v-for="r in details.configuration.noWakeRules.value" :key="r.name"><strong>{{ r.name }}</strong>: {{ r.invalid ? `invalid, ${r.invalid}` : ruleText(r.conditions) }}</div>
                <span v-if="!details.configuration.noWakeRules.value.length" class="text-medium-emphasis">none</span>
              </td>
              <td><TerraformChip v-if="details.configuration.noWakeRules.source === 'terraform'" size="x-small" variant="tonal" :text="terraformSettingHelp" /></td></tr>
          </tbody>
        </v-table>
      </v-col>
    </v-row>
  </div>
</template>
