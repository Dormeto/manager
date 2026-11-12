<script setup lang="ts">
// A workload's state as its icon in its color (tables design §3): no word beside it. The state's name is the chip's
// accessible name and its tooltip's first line, what it means and the last failure (R7b) under it. Focusable, so a
// keyboard opens the tooltip too.
import { stateColor } from '../format';
import { failureTitle, type Failure } from '../failures';
import { stateLabel } from '../history';
import { stateIcon, stateMeaning } from '../state';
import type { Cloud } from '@dormeto/fleet/clouds';

// cloud: the workload's (a Google Cloud failure is said in its words).
defineProps<{ state: string; failure?: Failure | null; cloud?: Cloud }>();
</script>

<template>
  <v-tooltip location="top" max-width="380" open-on-focus>
    <template #activator="{ props: tip }">
      <v-chip v-bind="tip" :color="stateColor(state)" variant="flat" label class="dm-state-chip" data-test="state-chip" role="img" :aria-label="stateLabel(state)" tabindex="0">
        <v-icon :icon="stateIcon(state)" size="16" aria-hidden="true" />
      </v-chip>
    </template>
    <div class="dm-state-chip__label">{{ stateLabel(state) }}</div>
    <div>{{ stateMeaning(state) }}</div>
    <div v-if="failure" class="mt-1">{{ failureTitle(failure, cloud) }} ({{ failure.message }})</div>
  </v-tooltip>
</template>

<style scoped>
/* The icon alone: a small square badge in the state's color. */
.dm-state-chip { flex: none; padding-inline: 5px; justify-content: center; }
.dm-state-chip:focus-visible { outline: 2px solid rgb(var(--v-theme-secondary)); outline-offset: 2px; }
.dm-state-chip__label { font-weight: 600; }
</style>
