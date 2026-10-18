<script setup lang="ts">
// The kinds of a workload's backends as icons (its databases last), each explained in a tooltip.
import { backendHelp, backendLabel } from '../format';
import { backendIcon } from '../icons';

defineProps<{ kinds: string[] }>();
</script>

<template>
  <span class="dm-kinds">
    <v-tooltip v-for="kind in kinds" :key="kind" location="top" max-width="380" :text="backendHelp(kind)">
      <template #activator="{ props }">
        <span v-bind="props" class="dm-kinds__kind" tabindex="0" :aria-label="backendLabel(kind)">
          <img v-if="backendIcon(kind)" :src="backendIcon(kind)!" :alt="backendLabel(kind)" width="22" height="22" class="backend-icon">
          <v-chip v-else size="x-small" variant="tonal" label>{{ backendLabel(kind) }}</v-chip>
        </span>
      </template>
    </v-tooltip>
  </span>
</template>

<style scoped>
.dm-kinds { display: inline-flex; align-items: center; gap: 5px; }
.dm-kinds__kind { display: inline-flex; border-radius: 7px; outline: none; transition: transform 0.25s var(--dm-ease); }
.dm-kinds__kind:hover { transform: translateY(-1px); }
.dm-kinds__kind:focus-visible { box-shadow: 0 0 0 2px rgb(var(--v-theme-secondary)); }
.backend-icon { display: block; border-radius: 6px; box-shadow: 0 0 0 1px rgba(var(--v-border-color), 0.12); }
@media (prefers-reduced-motion: reduce) { .dm-kinds__kind { transition: none; } }
</style>
