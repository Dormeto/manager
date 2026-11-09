<script setup lang="ts">
// The kinds of a workload's backends as icons (its databases last), each explained in a tooltip. plain: the icons alone,
// inside a choice of a list (no tooltip, nothing to tab to).
import { backendHelp, backendLabel } from '../format';
import { backendIcon, backendMdi } from '../icons';
import type { Cloud } from '@dormeto/fleet/clouds';

// cloud: Google Cloud's kinds are Material Design icons, AWS's their product icons.
const props = defineProps<{ kinds: string[]; plain?: boolean; cloud?: Cloud }>();
const icon = (kind: string) => (props.cloud === 'gcp' ? null : backendIcon(kind));
const mdi = (kind: string) => (props.cloud === 'gcp' ? backendMdi(kind) : null);
</script>

<template>
  <span class="dm-kinds">
    <v-tooltip v-for="kind in kinds" :key="kind" location="top" max-width="380" :text="backendHelp(kind, cloud)" :disabled="plain">
      <template #activator="{ props }">
        <span v-bind="plain ? {} : props" class="dm-kinds__kind" :tabindex="plain ? undefined : 0" :aria-label="plain ? undefined : backendLabel(kind, cloud)">
          <img v-if="icon(kind)" :src="icon(kind)!" :alt="backendLabel(kind, cloud)" width="22" height="22" class="backend-icon">
          <v-icon v-else-if="mdi(kind)" :icon="mdi(kind)!" size="22" class="backend-icon backend-icon--mdi" :aria-hidden="plain ? false : undefined" :aria-label="plain ? backendLabel(kind, cloud) : undefined" />
          <v-chip v-else size="x-small" variant="tonal" label>{{ backendLabel(kind, cloud) }}</v-chip>
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
.backend-icon--mdi { padding: 3px; box-sizing: content-box; background: rgba(var(--v-theme-on-surface), 0.06); }
.backend-icon { display: block; border-radius: 6px; box-shadow: 0 0 0 1px rgba(var(--v-border-color), 0.12); }
@media (prefers-reduced-motion: reduce) { .dm-kinds__kind { transition: none; } }
</style>
