<script setup lang="ts">
// "Terraform", for a router or a setting written in Terraform, its tooltip saying where it is changed. Installed by the
// manager is the standard way: no chip for it (user request).
defineProps<{ text: string; size?: 'x-small' | 'small'; variant?: 'outlined' | 'tonal' }>();
</script>

<template>
  <v-tooltip location="top" max-width="380" :text="text">
    <template #activator="{ props: tip }">
      <v-chip v-bind="tip" :size="size ?? 'small'" :variant="variant ?? 'outlined'" label tabindex="0">Terraform</v-chip>
    </template>
  </v-tooltip>
</template>
