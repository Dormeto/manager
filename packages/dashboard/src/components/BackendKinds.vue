<script setup lang="ts">
// The kinds of a workload's backends as icons (its databases last), each explained in a tooltip.
import { backendHelp, backendLabel } from '../format';
import { backendIcon } from '../icons';

defineProps<{ kinds: string[] }>();
</script>

<template>
  <span class="d-inline-flex align-center ga-1">
    <v-tooltip v-for="kind in kinds" :key="kind" location="top" max-width="380" :text="backendHelp(kind)">
      <template #activator="{ props }">
        <span v-bind="props" class="d-inline-flex" tabindex="0" :aria-label="backendLabel(kind)">
          <img v-if="backendIcon(kind)" :src="backendIcon(kind)!" :alt="backendLabel(kind)" width="22" height="22" class="backend-icon">
          <v-chip v-else size="x-small" variant="tonal" label>{{ backendLabel(kind) }}</v-chip>
        </span>
      </template>
    </v-tooltip>
  </span>
</template>

<style scoped>
.backend-icon { border-radius: 4px; display: block; }
</style>
