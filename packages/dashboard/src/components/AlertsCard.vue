<script setup lang="ts">
// Health alarms (R6a): what the watchdog found open, errors first, and where alerts are sent.
import { computed } from 'vue';
import { mdiAlertCircleOutline, mdiAlertOutline, mdiBellCheckOutline } from '@mdi/js';
import { relative } from '../format';
import type { AlarmInfo, AlertsInfo } from '../types';

const props = defineProps<{ alerts: AlertsInfo | null; now: number }>();

const rank = { error: 0, warning: 1 } as const;
const alarms = computed(() => [...(props.alerts?.alarms ?? [])].sort((a, b) => rank[a.level] - rank[b.level] || a.name.localeCompare(b.name)));
const title = (a: AlarmInfo) => (a.kind === 'list' ? `IP list ${a.name}` : a.name);
const where = (a: AlarmInfo) => (a.kind === 'router' ? `${a.account} · ${a.region}` : 'the manager\'s lists');
const subtitle = (a: AlarmInfo) => `${a.problems[0]?.text ?? ''} · since ${relative(a.since, props.now)}`;
const link = (a: AlarmInfo) => (a.kind === 'list' ? '/routers#ip-lists' : '/routers');
const footer = computed(() => {
  const n = props.alerts?.notifications;
  if (!n) return '';
  const total = n.confirmed + n.pending;
  if (!total) return 'No subscription: alerts show here only (alert_emails in the manager\'s Terraform).';
  return `Alerts are sent to ${total} subscription${total === 1 ? '' : 's'}${n.pending ? ` (${n.pending} pending confirmation)` : ''}.`;
});
const endpoints = computed(() => (props.alerts?.notifications?.endpoints ?? []).map((e) => `${e.protocol} ${e.endpoint}${e.pending ? ' (pending)' : ''}`).join(', '));
</script>

<template>
  <v-card v-if="alerts?.notifications" title="Alerts">
    <template #append><v-chip v-if="alarms.length" :color="alarms[0]!.level" variant="tonal" label size="small">{{ alarms.length }} open</v-chip></template>
    <v-list v-if="alarms.length" lines="two">
      <v-list-item v-for="a in alarms" :key="a.id" :to="link(a)" :title="`${title(a)} (${where(a)})`" :subtitle="subtitle(a)">
        <template #prepend><v-icon :icon="a.level === 'error' ? mdiAlertCircleOutline : mdiAlertOutline" :color="a.level" /></template>
      </v-list-item>
    </v-list>
    <v-card-text v-else class="d-flex align-center ga-2 text-medium-emphasis">
      <v-icon :icon="mdiBellCheckOutline" color="success" />No open alert: every router reports, and nothing it reports needs attention.
    </v-card-text>
    <v-card-text class="text-body-small text-medium-emphasis pt-0" :title="endpoints">{{ footer }}</v-card-text>
  </v-card>
</template>
