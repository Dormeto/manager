<script setup lang="ts">
// A workload's state: its color and icon, what it means in a tooltip.
import { stateColor } from '../format';
import { stateHelp, stateIcon } from '../state';

defineProps<{ state: string }>();
</script>

<template>
  <v-tooltip location="top" max-width="380" :text="stateHelp(state)">
    <template #activator="{ props }">
      <v-chip v-bind="props" :color="stateColor(state)" :prepend-icon="stateIcon(state)" variant="flat" label class="font-weight-medium" tabindex="0">{{ state }}</v-chip>
    </template>
  </v-tooltip>
</template>
