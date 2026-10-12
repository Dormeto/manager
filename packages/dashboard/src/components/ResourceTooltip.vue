<script setup lang="ts">
// An AWS resource's id, ARN and service in a tooltip (user request: the workload's backends and targets). Its activator is
// the default slot, given the tooltip's props as `tip`.
defineProps<{ id: string; arn: string | null; service: string }>();
</script>

<template>
  <v-tooltip location="top" max-width="600">
    <template #activator="{ props: tip }"><slot :tip="tip" /></template>
    <table class="resource">
      <tr><th>Id</th><td class="mono">{{ id }}</td></tr>
      <tr><th>ARN</th><td class="mono">{{ arn ?? '—' }}</td></tr>
      <tr><th>Service</th><td>{{ service }}</td></tr>
    </table>
  </v-tooltip>
</template>

<style scoped>
.resource th { text-align: left; font-weight: 400; opacity: 0.8; padding-right: 12px; vertical-align: top; white-space: nowrap; }
.resource td { word-break: break-all; }
</style>
