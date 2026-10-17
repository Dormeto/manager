<script setup lang="ts">
// An AWS resource's id, ARN and service in a tooltip (user request: the workload's backends and targets), with more rows
// (a backend's costs) and a note. Its activator is the default slot, given the tooltip's props as `tip`.
defineProps<{ id: string; arn: string | null; service: string; rows?: { label: string; value: string }[]; note?: string | null }>();
</script>

<template>
  <v-tooltip location="top" max-width="600">
    <template #activator="{ props: tip }"><slot :tip="tip" /></template>
    <table class="resource"><tbody>
      <tr><th>Id</th><td class="mono">{{ id }}</td></tr>
      <tr><th>ARN</th><td class="mono">{{ arn ?? '—' }}</td></tr>
      <tr><th>Service</th><td>{{ service }}</td></tr>
      <tr v-for="r in rows ?? []" :key="r.label"><th>{{ r.label }}</th><td>{{ r.value }}</td></tr>
    </tbody></table>
    <div v-if="note" class="mt-1 note">{{ note }}</div>
  </v-tooltip>
</template>

<style scoped>
.resource { border-collapse: collapse; }
.resource th { text-align: left; font: 500 0.66rem/1.9 var(--dm-mono); letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.65; padding: 1px 14px 1px 0; vertical-align: top; white-space: nowrap; }
.resource td { padding: 1px 0; word-break: break-word; font-variant-numeric: tabular-nums; }
.mono { word-break: break-all; }
.note { opacity: 0.8; }
</style>
