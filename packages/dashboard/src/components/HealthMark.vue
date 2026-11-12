<script setup lang="ts">
// A router's health as its icon alone (tables design §3, §4): ok, warning, error or unreachable in its color, or none before
// router 0.16. Its tooltip says the status, each problem with its level, the open alert and since when, the error's text,
// and "not reporting" with why. Second facts, not the health's reason, get their own marks beside it: a bell for an open
// alert, a muted cloud for a router that does not report (unreachable says more).
import { computed } from 'vue';
import { mdiBellRingOutline, mdiCloudOffOutline } from '@mdi/js';
import { relative } from '../format';
import { useNow } from '../now';
import { healthMark, NOT_REPORTING } from '../pause';
import StatusMark from './StatusMark.vue';
import type { AlarmInfo, RouterInfo } from '../types';

const props = defineProps<{ router: RouterInfo; alarm?: AlarmInfo | null }>();
const now = useNow();
const mark = computed(() => healthMark(props.router));
const alert = computed(() => (props.alarm ? `alert since ${relative(props.alarm.since, now.value)}` : ''));
const silent = computed(() => props.router.reporting === false && !props.router.error);
const why = `${NOT_REPORTING.charAt(0).toUpperCase()}${NOT_REPORTING.slice(1)}`;
</script>

<template>
  <span class="dm-health-mark" data-test="health-mark">
    <StatusMark :icon="mark.icon" :color="mark.color" :label="mark.label">
      <div v-if="router.error" class="text-body-medium dm-health-mark__line">{{ router.error }}</div>
      <div v-for="p in router.error ? [] : router.health?.problems ?? []" :key="p.text" class="text-body-medium dm-health-mark__line"><strong>{{ p.level }}</strong>: {{ p.text }}</div>
      <div v-if="!router.error && !router.health" class="text-body-medium dm-health-mark__line">Upgrade to 0.16 for health.</div>
      <div v-if="alarm" class="text-body-medium dm-health-mark__line"><strong>alert</strong> since {{ relative(alarm.since, now) }}</div>
      <div v-if="silent" class="text-body-medium dm-health-mark__line"><strong>not reporting</strong>: {{ NOT_REPORTING }}</div>
    </StatusMark>
    <StatusMark v-if="alarm" :icon="mdiBellRingOutline" :color="alarm.level" :label="alert" :size="18" />
    <StatusMark v-if="silent" :icon="mdiCloudOffOutline" label="not reporting" :size="18">
      <div class="text-body-medium dm-health-mark__line">{{ why }}</div>
    </StatusMark>
  </span>
</template>

<style scoped>
.dm-health-mark { display: inline-flex; align-items: center; gap: 6px; vertical-align: middle; }
.dm-health-mark__line { margin-top: 4px; overflow-wrap: anywhere; }
</style>
