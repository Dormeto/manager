<script setup lang="ts">
// A discovery status as its icon alone (tables design §3): its short name is the icon's accessible name and its tooltip's
// first line, what it means and how it changes under it.
import type { Status } from '@dormeto/discovery/types';
import { statusColor, statusIcon, statusLabel } from '../discovery';
import StatusHelp from './StatusHelp.vue';
import StatusMark from './StatusMark.vue';

defineProps<{ status: Status }>();
</script>

<template>
  <StatusMark :icon="statusIcon(status)" :color="statusColor(status)" :label="statusLabel(status)">
    <StatusHelp :status="status" untitled />
  </StatusMark>
</template>
