<script setup lang="ts">
// A workload with a schedule (R12), as a row says it: an icon, its meaning in a tooltip. The row knows only that it has
// one (`scheduled`); the workload's Schedule card says when.
import { mdiCalendarClock } from '@mdi/js';

const TEXT = 'Has a schedule: it naps and wakes at set hours (its Schedule card says when).';
</script>

<template>
  <span class="dm-mark-wrap"><v-tooltip location="top" max-width="380" :text="TEXT">
    <template #activator="{ props: tip }">
      <v-icon v-bind="tip" data-test="scheduled" :icon="mdiCalendarClock" size="16" class="dm-mark" tabindex="0" role="img" aria-label="Has a schedule" :aria-hidden="false" />
    </template>
  </v-tooltip></span>
</template>

<style scoped>
.dm-mark-wrap { display: inline-flex; vertical-align: middle; margin-left: 4px; }
.dm-mark { color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); border-radius: 4px; outline: none; }
.dm-mark:focus-visible { box-shadow: 0 0 0 2px rgb(var(--v-theme-secondary)); }
</style>
