<script setup lang="ts">
// The Workloads view's Workload cell: its name (a link), its marks, its description's first line and its id. Every icon has
// a tooltip and an accessible name (the user, 2026-11-21): the kind (a standalone workload's only: an HTTP-only fleet's
// column stays quiet) and a schedule.
import KindMark from './KindMark.vue';
import ScheduledMark from './ScheduledMark.vue';
import { isStandalone } from '../kinds';
import { rowCloud } from '../format';
import type { WorkloadSummary } from '../types';

defineProps<{ item: WorkloadSummary }>();
</script>

<template>
  <div class="dm-wl">
    <span class="dm-wl__head"><router-link :to="`/workloads/${item.router}/${item.workloadId}`" class="dm-wl__name">{{ item.name ?? item.workloadId }}</router-link><KindMark v-if="isStandalone(item)" kind="standalone" :cloud="rowCloud(item)" /><ScheduledMark v-if="item.scheduled" /></span>
    <div v-if="item.summary" class="dm-list-summary" data-test="summary" :title="item.summary">{{ item.summary }}</div>
    <div v-if="item.name" class="dm-wl__id mono">{{ item.workloadId }}</div>
  </div>
</template>

<style scoped>
.dm-wl { min-width: 0; }
/* The name and its marks on one line: a mark never wraps below the name. */
.dm-wl__head { display: inline-flex; align-items: center; white-space: nowrap; }
.dm-wl__name { display: inline-block; font-weight: 600; letter-spacing: -0.01em; color: rgb(var(--v-theme-on-surface)); text-decoration: none; white-space: nowrap; transition: color 0.2s; }
.dm-wl__name:hover { color: rgb(var(--v-theme-primary)); }
.dm-wl__name:focus-visible { outline: 2px solid rgb(var(--v-theme-secondary)); outline-offset: 2px; border-radius: 4px; }
.dm-wl__id { margin-top: 1px; font-size: 0.7rem; letter-spacing: 0.02em; color: rgba(var(--v-theme-on-surface), 0.5); }
</style>
