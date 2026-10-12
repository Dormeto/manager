<script setup lang="ts">
// A workload's state: its color and icon, what it means in a tooltip, with the last failure (R7b).
import { stateColor } from '../format';
import { failureTitle, type Failure } from '../failures';
import { stateHelp, stateIcon } from '../state';

defineProps<{ state: string; failure?: Failure | null }>();
const help = (state: string, failure?: Failure | null) => [stateHelp(state), failure && `${failureTitle(failure)} (${failure.message})`].filter(Boolean).join(' ');
</script>

<template>
  <v-tooltip location="top" max-width="380" :text="help(state, failure)">
    <template #activator="{ props }">
      <v-chip v-bind="props" :color="stateColor(state)" :prepend-icon="stateIcon(state)" variant="flat" label class="font-weight-medium" tabindex="0">{{ state }}</v-chip>
    </template>
  </v-tooltip>
</template>
