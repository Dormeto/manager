<script setup lang="ts">
// A discovery status as a chip with its short name; what it means and how it changes in a tooltip.
import type { Status } from '@dormeto/discovery/types';
import { statusColor, statusLabel } from '../discovery';
import StatusHelp from './StatusHelp.vue';

defineProps<{ status: Status }>();
</script>

<template>
  <v-tooltip location="top" max-width="380">
    <template #activator="{ props: tip }">
      <v-chip v-bind="tip" :color="statusColor(status)" variant="tonal" label tabindex="0">{{ statusLabel(status) }}</v-chip>
    </template>
    <StatusHelp :status="status" />
  </v-tooltip>
</template>
