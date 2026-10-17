<script setup lang="ts">
// Health alarms (R6a): what the watchdog found open (routers, IP lists, failed wakes), errors first, and where alerts are sent.
import { computed } from 'vue';
import { mdiBellCheckOutline, mdiBellRingOutline, mdiChevronRight, mdiEmailOutline } from '@mdi/js';
import { relative } from '../format';
import DmLogo from './DmLogo.vue';
import type { AlarmInfo, AlertsInfo } from '../types';

const props = defineProps<{ alerts: AlertsInfo | null; now: number }>();

const rank = { error: 0, warning: 1 } as const;
const alarms = computed(() => [...(props.alerts?.alarms ?? [])].sort((a, b) => rank[a.level] - rank[b.level] || a.name.localeCompare(b.name)));
const title = (a: AlarmInfo) => (a.kind === 'list' ? `IP list ${a.name}` : a.name);
const where = (a: AlarmInfo) => (a.kind === 'list' ? 'the manager\'s lists' : `${a.account} · ${a.region}`);
const subtitle = (a: AlarmInfo) => `${a.problems[0]?.text ?? ''} · since ${relative(a.since, props.now)}`;
const link = (a: AlarmInfo) => {
  if (a.kind === 'workload' && a.router && a.workloadId) return `/workloads/${encodeURIComponent(a.router)}/${encodeURIComponent(a.workloadId)}`;
  if (a.kind === 'router') return `/routers/${encodeURIComponent(a.name)}`;
  return a.kind === 'list' ? '/routers#ip-lists' : a.kind === 'workload' ? '/workloads' : '/routers';
};
const footer = computed(() => {
  const n = props.alerts?.notifications;
  if (!n) return '';
  const total = n.confirmed + n.pending;
  if (!total) return 'No subscription: alerts show here only (alert_emails in the manager\'s Terraform).';
  return `Alerts are sent to ${total} subscription${total === 1 ? '' : 's'}${n.pending ? ` (${n.pending} pending confirmation)` : ''}.`;
});
const endpoints = computed(() => (props.alerts?.notifications?.endpoints ?? []).map((e) => `${e.protocol} ${e.endpoint}${e.pending ? ' (pending)' : ''}`).join(', '));
// The worst level open, for the card's tone.
const tone = computed(() => alarms.value[0]?.level ?? 'success');
</script>

<template>
  <v-card v-if="alerts?.notifications" title="Alerts" class="dm-alerts" :class="`dm-alerts--${tone}`">
    <template #prepend>
      <v-avatar :color="tone" variant="tonal" rounded="lg" size="34"><v-icon :icon="alarms.length ? mdiBellRingOutline : mdiBellCheckOutline" size="19" /></v-avatar>
    </template>
    <template v-if="alarms.length" #image><div class="dm-alerts__glow" aria-hidden="true" /></template>
    <template #append><v-chip v-if="alarms.length" :color="alarms[0]!.level" variant="tonal" label size="small">{{ alarms.length }} open</v-chip></template>
    <v-list v-if="alarms.length" lines="two" class="bg-transparent px-2 py-1">
      <v-list-item v-for="a in alarms" :key="a.id" :to="link(a)" :subtitle="subtitle(a)" rounded="lg" class="dm-alarm">
        <template #prepend><span class="dm-alarm__dot" :class="`dm-alarm__dot--${a.level}`" role="img" :aria-label="a.level === 'error' ? 'Error' : 'Warning'" /></template>
        <template #title>{{ title(a) }} <span class="dm-alarm__where">({{ where(a) }})</span></template>
        <template #append><v-icon :icon="mdiChevronRight" size="18" class="dm-alarm__go" /></template>
      </v-list-item>
    </v-list>
    <v-card-text v-else class="dm-calm">
      <DmLogo state="sleep" :size="40" />
      <span class="text-medium-emphasis">No open alert: every router reports, nothing it reports needs attention, and no wake failed.</span>
    </v-card-text>
    <v-card-text class="dm-alerts__footer text-body-small text-medium-emphasis pt-0" :title="endpoints">
      <v-icon :icon="mdiEmailOutline" size="15" />{{ footer }}
    </v-card-text>
  </v-card>
</template>

<style scoped>
.dm-alerts { position: relative; overflow: hidden; }
/* The bell, the title and the count on one line. */
.dm-alerts > :deep(.v-card-item) { padding-top: 16px; padding-bottom: 8px; }
.dm-alerts > :deep(.v-card-item .v-card-title) { padding-top: 0 !important; }
.dm-alerts__glow { position: absolute; top: -120px; left: -60px; width: 320px; height: 240px; border-radius: 50%; filter: blur(60px); opacity: 0.22; pointer-events: none;
  background: radial-gradient(closest-side, rgb(var(--v-theme-warning)), transparent); }
.dm-alerts--error .dm-alerts__glow { background: radial-gradient(closest-side, rgb(var(--v-theme-error)), transparent); }
.dm-alarm { position: relative; }
.dm-alarm :deep(.v-list-item__prepend) { align-self: flex-start; margin-top: 7px; }
.dm-alarm :deep(.v-list-item-title) { font-weight: 500; white-space: normal; }
.dm-alarm :deep(.v-list-item-subtitle) { -webkit-line-clamp: unset; line-clamp: unset; line-height: 1.45; }
.dm-alarm__where { font-family: var(--dm-mono); font-size: 0.78em; font-weight: 400; opacity: 0.6; }
.dm-alarm__go { opacity: 0.4; transition: opacity 0.2s, transform 0.3s var(--dm-ease); }
.dm-alarm:hover .dm-alarm__go { opacity: 0.9; transform: translateX(2px); }
/* The level: a dot with a halo; an error's breathes. */
.dm-alarm__dot { position: relative; display: block; width: 10px; height: 10px; margin: 0 6px 0 4px; border-radius: 50%; }
.dm-alarm__dot--warning { background: rgb(var(--v-theme-warning)); box-shadow: 0 0 0 4px rgba(var(--v-theme-warning), 0.16); }
.dm-alarm__dot--error { background: rgb(var(--v-theme-error)); box-shadow: 0 0 0 4px rgba(var(--v-theme-error), 0.18); }
.dm-alarm__dot--error::after { content: ""; position: absolute; inset: -4px; border-radius: 50%; border: 1px solid rgba(var(--v-theme-error), 0.6); animation: dm-alarm-ping 2.4s var(--dm-ease) infinite; }
.dm-calm { display: flex; align-items: center; gap: 14px; }
.dm-alerts__footer { display: flex; align-items: center; gap: 8px; padding-left: 26px !important; }
@keyframes dm-alarm-ping { 0% { transform: scale(0.8); opacity: 0.9; } 80%, 100% { transform: scale(2.2); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .dm-alarm__dot--error::after { animation: none; opacity: 0; } }
</style>
