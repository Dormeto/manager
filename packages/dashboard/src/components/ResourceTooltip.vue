<script setup lang="ts">
// An AWS resource's id, ARN and service in a tooltip (user request: the workload's backends and targets), with more rows
// (a backend's costs) and a note. Its activator is the default slot, given the tooltip's props as `tip`.
defineProps<{ id: string; arn: string | null; service: string; rows?: { label: string; value: string }[]; note?: string | null }>();
</script>

<template>
  <v-tooltip location="top" max-width="600">
    <template #activator="{ props: tip }"><slot :tip="tip" /></template>
    <table class="resource">
      <tr><th>Id</th><td class="mono">{{ id }}</td></tr>
      <tr><th>ARN</th><td class="mono">{{ arn ?? '—' }}</td></tr>
      <tr><th>Service</th><td>{{ service }}</td></tr>
      <tr v-for="r in rows ?? []" :key="r.label"><th>{{ r.label }}</th><td>{{ r.value }}</td></tr>
    </table>
    <div v-if="note" class="mt-1 note">{{ note }}</div>
  </v-tooltip>
</template>

<style scoped>
.resource th { text-align: left; font-weight: 400; opacity: 0.8; padding-right: 12px; vertical-align: top; white-space: nowrap; }
.resource td { word-break: break-word; }
.mono { word-break: break-all; }
.note { opacity: 0.8; }
</style>
